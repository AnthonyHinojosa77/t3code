// @effect-diagnostics nodeBuiltinImport:off - The companion is a standalone Node process with a small import graph.
// @effect-diagnostics globalTimers:off - Companion lifecycle and transport use native timers.
// @effect-diagnostics globalDate:off - Persisted lifecycle timestamps use ISO wall-clock time.
import * as NodeCrypto from "node:crypto";

import { WebSocket } from "ws";
import type { BearerTokenSource } from "../bearerToken.ts";
import type { CouncilModelInput } from "./types.ts";

export interface EngineUpdate {
  status: "running" | "needs-attention" | "complete" | "failed" | "cancelled";
  text: string;
  error?: string;
}
export type CouncilRuntimeMode = "auto" | "approval-required";
class EngineRpcRejected extends Error {}
export function councilRuntimeMode(modes: readonly string[] = []): CouncilRuntimeMode {
  return modes.length === 0 || modes.includes("auto") ? "auto" : "approval-required";
}
export interface EngineLaunch {
  threadId: string;
  title: string;
  projectId: string | null;
  model: CouncilModelInput;
  prompt: string;
  onRuntimeMode?: (mode: CouncilRuntimeMode) => void;
}
export interface CouncilEngine {
  launch(input: EngineLaunch): Promise<void>;
  observe(threadId: string, update: (value: EngineUpdate) => void): () => void;
  interrupt(threadId: string): Promise<void>;
  close(): void;
}
interface Projection {
  messages: { role: string; text: string }[];
  runs: { status: string; failure?: { message?: string } | null }[];
  runtimeRequests: { status: string }[];
}
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
export class EngineClient implements CouncilEngine {
  private socket: WebSocket | undefined;
  private connecting: Promise<WebSocket> | undefined;
  private pending = new Map<string, Pending>();
  private observers = new Set<() => void>();
  private stopped = false;
  private readonly tokens: BearerTokenSource;
  private readonly url: string;
  constructor(tokens: BearerTokenSource, base = "ws://127.0.0.1:3773") {
    this.tokens = tokens;
    const url = new URL("/ws", base);
    url.searchParams.set("orchestrationProtocol", "2");
    this.url = url.href;
  }
  private connect(): Promise<WebSocket> {
    if (this.stopped) return Promise.reject(new Error("Engine client closed"));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = this.tokens
      .getToken()
      .then(
        (token) =>
          new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(this.url, {
              headers: { authorization: `Bearer ${token}` },
              handshakeTimeout: 10000,
            });
            this.socket = ws;
            ws.once("open", () => resolve(ws));
            ws.on("error", () => reject(new Error("Engine WebSocket unavailable")));
            ws.on("close", () => {
              for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error("Engine disconnected"));
              }
              this.pending.clear();
            });
            ws.on("message", (raw) => {
              let data: unknown;
              try {
                data = JSON.parse(raw.toString());
              } catch {
                ws.close(1002, "Invalid RPC JSON");
                return;
              }
              for (const frame of Array.isArray(data) ? data : [data]) {
                if (!frame || typeof frame !== "object") continue;
                if (frame._tag === "Ping") {
                  ws.send(JSON.stringify({ _tag: "Pong" }));
                  continue;
                }
                if (frame._tag !== "Exit") continue;
                const p = this.pending.get(String(frame.requestId));
                if (!p) continue;
                clearTimeout(p.timer);
                this.pending.delete(String(frame.requestId));
                if (frame.exit?._tag === "Success") p.resolve(frame.exit.value);
                else p.reject(new EngineRpcRejected("Engine RPC rejected the request"));
              }
            });
          }),
      )
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async rpc<T>(tag: string, payload: unknown): Promise<T> {
    const ws = await this.connect();
    const id = NodeCrypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Engine RPC timed out"));
      }, 30000);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }
  async launch(input: EngineLaunch) {
    const projectId =
      input.projectId ??
      (await this.rpc<{ projectId: string }>("projects.ensureScratch", {})).projectId;
    const config = await this.rpc<{
      providers: { instanceId: string; supportedRuntimeModes?: string[] }[];
    }>("server.getConfig", {});
    const mode = councilRuntimeMode(
      config.providers.find((p) => p.instanceId === input.model.instanceId)?.supportedRuntimeModes,
    );
    const launch = async (runtimeMode: CouncilRuntimeMode) => {
      input.onRuntimeMode?.(runtimeMode);
      await this.rpc("orchestration.launchThread", {
        commandId: `council-launch-${input.threadId}-${runtimeMode}`,
        threadId: input.threadId,
        projectId,
        title: input.title,
        modelSelection: {
          instanceId: input.model.instanceId,
          model: input.model.model,
          ...(input.model.options == null ? {} : { options: input.model.options }),
        },
        runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: input.prompt, attachments: [] },
      });
    };
    try {
      await launch(mode);
    } catch (error) {
      if (mode !== "auto" || !(error instanceof EngineRpcRejected)) throw error;
      await launch("approval-required");
    }
  }
  observe(threadId: string, update: (value: EngineUpdate) => void) {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      this.observers.delete(stop);
    };
    const read = async () => {
      try {
        const p = await this.rpc<Projection>("orchestration.getThreadProjection", { threadId });
        if (stopped) return;
        const run = p.runs.at(-1);
        const text = p.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.text)
          .join("\n\n");
        const status =
          run?.status === "completed"
            ? "complete"
            : run?.status === "failed" || run?.status === "rolled_back"
              ? "failed"
              : run?.status === "cancelled" || run?.status === "interrupted"
                ? "cancelled"
                : p.runtimeRequests.some((r) => r.status === "pending")
                  ? "needs-attention"
                  : "running";
        update({ status, text, ...(run?.failure?.message ? { error: run.failure.message } : {}) });
      } catch {
        /* A dropped socket is retried without failing a running provider turn. */
      }
      if (!stopped)
        timer = setTimeout(() => {
          void read();
        }, 1000);
    };
    this.observers.add(stop);
    void read();
    return stop;
  }
  async interrupt(threadId: string) {
    await this.rpc("orchestration.dispatchCommand", {
      type: "thread.stop",
      commandId: NodeCrypto.randomUUID(),
      threadId,
    });
  }
  async archive(threadId: string) {
    await this.rpc("orchestration.dispatchCommand", {
      type: "thread.archive",
      commandId: NodeCrypto.randomUUID(),
      threadId,
    });
  }
  close() {
    this.stopped = true;
    for (const stop of this.observers) stop();
    this.socket?.close();
  }
}
