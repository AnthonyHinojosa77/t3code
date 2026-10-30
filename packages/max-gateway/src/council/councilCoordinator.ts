// @effect-diagnostics globalConsole:off - Standalone companion logs sanitized cleanup failures.
// @effect-diagnostics nodeBuiltinImport:off - The companion is a standalone Node process with a small import graph.
// @effect-diagnostics globalTimers:off - Companion lifecycle and transport use native timers.
// @effect-diagnostics globalDate:off - Persisted lifecycle timestamps use ISO wall-clock time.
import * as NodeCrypto from "node:crypto";

import type { CouncilEngine, EngineUpdate } from "./engineClient.ts";
import { CouncilStore } from "./councilStore.ts";
import { RoleTemplates, COUNCIL_PREFACE, SYNTHESIS_PREFACE } from "./roleTemplates.ts";
import {
  CouncilError,
  type CouncilRoundInput,
  type CouncilRound,
  type CouncilStructuredSynthesis,
  type CouncilModelInput,
  type CouncilContenderState,
  type CouncilSynthesisState,
  type CouncilAttachment,
} from "./types.ts";
const MAX_ATTACHMENTS = 100;
const ATTACHMENT_ID = /^[a-z0-9_-]{1,128}$/i;
function validAttachments(v: unknown): v is CouncilAttachment[] | undefined {
  if (v === undefined) return true;
  return (
    Array.isArray(v) &&
    v.length <= MAX_ATTACHMENTS &&
    v.every((a: unknown) => {
      if (!a || typeof a !== "object") return false;
      const m = a as Record<string, unknown>;
      return (
        (m.type === "image" || m.type === "file") &&
        typeof m.id === "string" &&
        ATTACHMENT_ID.test(m.id) &&
        typeof m.name === "string" &&
        !!m.name.trim() &&
        m.name.length <= 255 &&
        typeof m.mimeType === "string" &&
        !!m.mimeType.trim() &&
        m.mimeType.length <= 100 &&
        typeof m.sizeBytes === "number" &&
        Number.isInteger(m.sizeBytes) &&
        m.sizeBytes >= 0
      );
    })
  );
}
const terminal = (s: string) =>
  ["complete", "failed", "timed-out", "cancelled", "skipped"].includes(s);
export function parseSynthesis(text: string): CouncilStructuredSynthesis | null {
  const candidates = [text, /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]];
  const start = text.indexOf("{");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i >= 0 && i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      candidates.push(text.slice(start, i + 1));
      break;
    }
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v: unknown = JSON.parse(c);
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const r = v as Record<string, unknown>;
      const arr = (x: unknown) =>
        Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
      return {
        consensus: arr(r.consensus),
        disagreements: arr(r.disagreements),
        verdict: typeof r.verdict === "string" ? r.verdict : "",
        uncertainties: arr(r.uncertainties),
      };
    } catch {
      /* Try the next representation. */
    }
  }
  return null;
}
function validModel(v: unknown): v is CouncilModelInput {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.instanceId === "string" &&
    !!m.instanceId.trim() &&
    typeof m.model === "string" &&
    !!m.model.trim() &&
    (m.options == null ||
      (Array.isArray(m.options) &&
        m.options.every(
          (option) =>
            option !== null &&
            typeof option === "object" &&
            typeof option.id === "string" &&
            option.id.trim().length > 0 &&
            (typeof option.value === "boolean" ||
              (typeof option.value === "string" && option.value.trim().length > 0)),
        )))
  );
}
export class CouncilCoordinator {
  private active = new Map<string, CouncilRound>();
  private cleanup = new Map<string, () => void>();
  private stopped = false;
  private lifecycle = new Map<string, Promise<void>>();
  readonly store: CouncilStore;
  readonly templates: RoleTemplates;
  private readonly engine: CouncilEngine;
  private readonly timeoutMs: number;
  constructor(
    store: CouncilStore,
    templates: RoleTemplates,
    engine: CouncilEngine,
    timeoutMs = Number(process.env.MAX_COUNCIL_CONTENDER_TIMEOUT_MS ?? 900000),
  ) {
    this.store = store;
    this.templates = templates;
    this.engine = engine;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 900000;
  }
  resume() {
    for (const r of this.store.all())
      if (terminal(r.status)) {
        for (const state of [...r.contenders, r.synthesis]) this.archive(r, state);
      } else {
        this.active.set(r.id, r);
        this.run(r);
      }
  }
  private serialize(threadId: string, action: () => Promise<void>) {
    const previous = this.lifecycle.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.lifecycle.set(threadId, next);
    void next
      .finally(() => {
        if (this.lifecycle.get(threadId) === next) this.lifecycle.delete(threadId);
      })
      .catch(() => {});
    return next;
  }
  private archive(r: CouncilRound, state: CouncilContenderState | CouncilSynthesisState) {
    const threadId = state.threadId;
    if (!threadId || !terminal(state.status) || state.archivedAt || state.continuedAt) return;
    void this.serialize(threadId, async () => {
      if (this.stopped) return;
      const current = this.active.get(r.id) ?? this.store.get(r.id);
      const target = [...current.contenders, current.synthesis].find(
        (s) => s.threadId === threadId,
      )!;
      if (target.archivedAt || target.continuedAt) return;
      await this.engine.archive(threadId);
      if (this.stopped) return;
      const latest = this.active.get(r.id) ?? this.store.get(r.id);
      const archived = [...latest.contenders, latest.synthesis].find(
        (s) => s.threadId === threadId,
      )!;
      archived.archivedAt = new Date().toISOString();
      this.save(latest);
    }).catch(() => {
      console.warn("Council thread archive failed; will retry on companion start", threadId);
    });
  }
  async continueThread(id: string, threadId: string) {
    const round = this.active.get(id) ?? this.store.get(id);
    if (![...round.contenders, round.synthesis].some((s) => s.threadId === threadId))
      throw new CouncilError(404, "Thread not found in round");
    await this.serialize(threadId, async () => {
      await this.engine.unarchive(threadId);
      const current = this.active.get(id) ?? this.store.get(id);
      const target = [...current.contenders, current.synthesis].find(
        (s) => s.threadId === threadId,
      )!;
      target.continuedAt = new Date().toISOString();
      this.save(current);
    });
    return { threadId };
  }
  create(value: unknown): CouncilRound {
    const v = value as CouncilRoundInput;
    if (
      !v ||
      typeof v.prompt !== "string" ||
      !v.prompt.trim() ||
      v.prompt.length > 20000 ||
      typeof v.templateId !== "string" ||
      !(v.projectId === null || (typeof v.projectId === "string" && !!v.projectId.trim())) ||
      !Array.isArray(v.contenders) ||
      v.contenders.length < 1 ||
      v.contenders.length > 8 ||
      !v.contenders.every(validModel) ||
      !v.contenders.every((c) => validAttachments(c.attachments)) ||
      !validModel(v.synthesizer)
    )
      throw new CouncilError(400, "Invalid council round");
    let t;
    try {
      t = this.templates.get(v.templateId);
    } catch {
      throw new CouncilError(400, "Unknown template");
    }
    const keys = v.contenders.map((c) => JSON.stringify([c.instanceId, c.model, c.roleId ?? null]));
    if (
      new Set(keys).size !== keys.length ||
      v.contenders.some((c) => c.roleId != null && !t.roles.some((r) => r.id === c.roleId))
    )
      throw new CouncilError(400, "Duplicate contender or unknown role");
    const now = new Date().toISOString();
    const base = {
      runtimeMode: null,
      threadId: null,
      status: "pending" as const,
      text: "",
      error: null,
      startedAt: null,
      finishedAt: null,
    };
    const r: CouncilRound = {
      id: NodeCrypto.randomUUID(),
      prompt: v.prompt,
      templateId: t.id,
      templateName: t.name,
      projectId: v.projectId,
      status: "running",
      createdAt: now,
      updatedAt: now,
      contenders: v.contenders.map((c, i) => ({
        ...base,
        instanceId: c.instanceId,
        model: c.model,
        key: `c${i}`,
        options: c.options ?? null,
        roleId: c.roleId ?? null,
        roleName: t.roles.find((r) => r.id === c.roleId)?.name ?? null,
        attachments: (c.attachments ?? []).map((a) => ({
          type: a.type,
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        })),
      })),
      synthesis: {
        ...base,
        instanceId: v.synthesizer.instanceId,
        model: v.synthesizer.model,
        options: v.synthesizer.options ?? null,
        format: t.format,
        structured: null,
      },
    };
    this.store.save(r, t);
    this.active.set(r.id, r);
    this.run(r);
    return this.store.get(r.id);
  }
  private save(r: CouncilRound) {
    r.updatedAt = new Date().toISOString();
    this.store.save(r);
    if (terminal(r.status)) this.active.delete(r.id);
  }
  private run(r: CouncilRound) {
    if (this.stopped || terminal(r.status)) return;
    const t = this.store.template(r.id);
    if (r.contenders.every((c) => terminal(c.status))) {
      if (!r.contenders.some((c) => c.status === "complete")) {
        r.status = "failed";
        r.synthesis.status = "skipped";
        r.synthesis.finishedAt = new Date().toISOString();
        this.save(r);
        return;
      }
      r.status = "synthesizing";
      const prompt = `${t.id === "meta-debate" ? SYNTHESIS_PREFACE + "\n\n" : ""}${t.synthesizerInstruction}\n\nOriginal prompt:\n${r.prompt}\n\n${r.contenders
        .filter((c) => c.status === "complete")
        .map(
          (c) =>
            `=== ${c.model} (${c.instanceId})${c.roleName ? ` (${c.roleName})` : ""} ===\n${c.text}`,
        )
        .join("\n\n")}`;
      this.start(r, r.synthesis, prompt, true);
      return;
    }
    for (const c of r.contenders)
      if (!terminal(c.status)) {
        const role = t.roles.find((role) => role.id === c.roleId);
        const prompt = role ? `${role.instruction}\n\n${r.prompt}` : r.prompt;
        this.start(
          r,
          c,
          t.id === "meta-debate" ? `${COUNCIL_PREFACE}\n\n${prompt}` : prompt,
          false,
        );
      }
  }
  private start(
    r: CouncilRound,
    state: CouncilContenderState | CouncilSynthesisState,
    prompt: string,
    synthesis: boolean,
  ) {
    const key = `${r.id}:${synthesis ? "s" : (state as CouncilContenderState).key}`;
    if (this.cleanup.has(key) || terminal(state.status)) return;
    state.threadId ??= NodeCrypto.randomUUID();
    state.startedAt ??= new Date().toISOString();
    state.status = "running";
    this.save(r);
    let stopObserve = () => {};
    let disposed = false;
    const finish = (u: EngineUpdate | { status: "timed-out"; text: string; error: string }) => {
      if (disposed || this.stopped || terminal(r.status)) return;
      state.text = u.text;
      state.error = u.error ?? null;
      if (synthesis) {
        state.status =
          u.status === "needs-attention"
            ? "running"
            : u.status === "timed-out"
              ? "failed"
              : u.status;
      } else state.status = u.status;
      if (terminal(state.status)) {
        state.finishedAt = new Date().toISOString();
        this.cleanup.get(key)?.();
        this.cleanup.delete(key);
        if (synthesis) {
          r.synthesis.structured =
            state.status === "complete" && r.synthesis.format === "meta-debate"
              ? parseSynthesis(state.text)
              : null;
          r.status = state.status === "complete" ? "complete" : "failed";
        }
      }
      this.save(r);
      if (terminal(state.status)) this.archive(r, state);
      if (!synthesis && terminal(state.status)) this.run(r);
    };
    const remaining = Math.max(0, this.timeoutMs - (Date.now() - Date.parse(state.startedAt)));
    const expire = () => {
      finish({ status: "timed-out", text: state.text, error: "Council turn timed out" });
      void this.engine.interrupt(state.threadId!).catch(() => {});
    };
    const timer = setTimeout(expire, remaining);
    this.cleanup.set(key, () => {
      disposed = true;
      clearTimeout(timer);
      stopObserve();
    });
    if (remaining === 0) {
      expire();
      return;
    }
    const attach = () => {
      if (!disposed) {
        stopObserve = this.engine.observe(state.threadId!, finish);
        if (disposed) stopObserve();
      }
    };
    void this.engine
      .launch({
        threadId: state.threadId,
        title: `${synthesis ? "Council synthesis" : "Council"} · ${r.prompt.slice(0, 40)} · ${state.model}`,
        projectId: r.projectId,
        model: state,
        prompt,
        ...(synthesis ? {} : { attachments: (state as CouncilContenderState).attachments ?? [] }),
        onRuntimeMode: (mode) => {
          if (!disposed) {
            state.runtimeMode = mode;
            this.save(r);
          }
        },
      })
      .then(
        () => {
          if (disposed) {
            if (!this.stopped) void this.engine.interrupt(state.threadId!).catch(() => {});
          } else attach();
        },
        () =>
          finish({ status: "failed", text: state.text, error: "Could not launch engine thread" }),
      );
  }
  cancel(id: string) {
    const r = this.active.get(id) ?? this.store.get(id);
    if (terminal(r.status)) return r;
    r.status = "cancelled";
    for (const s of [...r.contenders, r.synthesis])
      if (!terminal(s.status)) {
        s.status = "cancelled";
        s.finishedAt = new Date().toISOString();
        if (s.threadId) void this.engine.interrupt(s.threadId).catch(() => {});
      }
    for (const [key, stop] of this.cleanup)
      if (key.startsWith(`${id}:`)) {
        stop();
        this.cleanup.delete(key);
      }
    this.save(r);
    for (const state of [...r.contenders, r.synthesis]) this.archive(r, state);
    return this.store.get(id);
  }
  close() {
    this.stopped = true;
    for (const stop of this.cleanup.values()) stop();
    this.cleanup.clear();
    this.engine.close();
  }
}
