import type { ModelSelection } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";

export interface CouncilModelInput {
  instanceId: string;
  model: string;
  options?: ModelSelection["options"] | null;
}
/** A pending engine upload. Each contender gets its own copy: the engine claims an upload once. */
export interface CouncilAttachmentMeta {
  type: "image" | "file";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}
export interface CouncilRole {
  id: string;
  name: string;
  instruction: string;
}
export interface CouncilTemplate {
  id: string;
  name: string;
  description: string;
  format: "meta-debate" | "freeform";
  builtIn: boolean;
  roles: CouncilRole[];
  synthesizerInstruction: string;
}
export type TemplateInput = Omit<CouncilTemplate, "id" | "builtIn" | "roles"> & {
  roles: Omit<CouncilRole, "id">[];
};
export interface CouncilRoundInput {
  prompt: string;
  templateId: string;
  projectId: string | null;
  contenders: (CouncilModelInput & {
    roleId?: string | null;
    attachments?: CouncilAttachmentMeta[];
  })[];
  synthesizer: CouncilModelInput;
}
export type ContenderStatus =
  | "pending"
  | "running"
  | "needs-attention"
  | "complete"
  | "failed"
  | "timed-out"
  | "cancelled";
interface AnswerState extends CouncilModelInput {
  options: ModelSelection["options"] | null;
  runtimeMode?: "auto" | "approval-required" | null;
  threadId: string | null;
  text: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface CouncilContenderState extends AnswerState {
  key: string;
  roleId: string | null;
  roleName: string | null;
  /** Absent on rounds saved before attachments existed. */
  attachments?: CouncilAttachmentMeta[];
  status: ContenderStatus;
}
export interface CouncilStructuredSynthesis {
  consensus: string[];
  disagreements: string[];
  verdict: string;
  uncertainties: string[];
}
export interface CouncilSynthesisState extends AnswerState {
  status: "pending" | "running" | "complete" | "failed" | "skipped" | "cancelled";
  format: "meta-debate" | "freeform";
  structured: CouncilStructuredSynthesis | null;
}
export type RoundStatus = "running" | "synthesizing" | "complete" | "failed" | "cancelled";
export interface CouncilRoundSummary {
  id: string;
  prompt: string;
  status: RoundStatus;
  templateName: string;
  contenderCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface CouncilRound extends Omit<CouncilRoundSummary, "contenderCount"> {
  templateId: string;
  projectId: string | null;
  contenders: CouncilContenderState[];
  synthesis: CouncilSynthesisState;
}
export class CouncilApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export const GATEWAY_MESSAGE = "Council needs the MAX gateway";
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/council${path}`, {
      method,
      credentials: "include",
      ...(signal ? { signal } : {}),
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CouncilApiError(GATEWAY_MESSAGE, 0);
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new CouncilApiError(
      response.status === 404 && (!/^\/rounds\/[^/]+/.test(path) || !payload?.error)
        ? GATEWAY_MESSAGE
        : (payload?.error ?? `Council request failed (${response.status})`),
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new CouncilApiError(GATEWAY_MESSAGE, 0);
  }
}
export const councilApi = {
  templates: (signal?: AbortSignal) =>
    request<{ templates: CouncilTemplate[] }>("/templates", "GET", undefined, signal),
  saveTemplate: (input: TemplateInput, id?: string) =>
    request<{ template: CouncilTemplate }>(
      id ? `/templates/${encodeURIComponent(id)}` : "/templates",
      id ? "PUT" : "POST",
      input,
    ),
  deleteTemplate: (id: string) => request<void>(`/templates/${encodeURIComponent(id)}`, "DELETE"),
  rounds: (signal?: AbortSignal) =>
    request<{ rounds: CouncilRoundSummary[] }>("/rounds?limit=20", "GET", undefined, signal),
  createRound: (input: CouncilRoundInput) =>
    request<{ round: CouncilRound }>("/rounds", "POST", input),
  round: (id: string, signal?: AbortSignal) =>
    request<{ round: CouncilRound }>(`/rounds/${encodeURIComponent(id)}`, "GET", undefined, signal),
  continueThread: (id: string, threadId: string) =>
    request<{ threadId: string }>(
      `/rounds/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/continue`,
      "POST",
    ),
  cancelRound: (id: string) =>
    request<{ round: CouncilRound }>(`/rounds/${encodeURIComponent(id)}/cancel`, "POST"),
};
export function isRoundActive(status: RoundStatus) {
  return status === "running" || status === "synthesizing";
}
export function useCouncilRound(id: string | undefined, onRound?: (round: CouncilRound) => void) {
  const [state, setState] = useState<{
    id?: string;
    round: CouncilRound | null;
    error: string | null;
  }>({ round: null, error: null });
  const notifyRound = useStableCallback((round: CouncilRound) => onRound?.(round));
  // oxlint-disable-next-line t3code/react-effect-budget -- Poll the external coordinator while visible; abort HTTP and timers on cleanup.
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (stopped || terminal || document.hidden) return;
      const requestController = new AbortController();
      controller = requestController;
      try {
        const { round } = await councilApi.round(id, requestController.signal);
        if (stopped || requestController.signal.aborted) return;
        terminal = !isRoundActive(round.status);
        setState({ id, round, error: null });
        notifyRound(round);
      } catch (error) {
        if (stopped || requestController.signal.aborted) return;
        setState((previous) => ({
          id,
          round: previous.id === id ? previous.round : null,
          error: error instanceof Error ? error.message : "Couldn’t load round",
        }));
        terminal = error instanceof CouncilApiError && error.status === 404;
      }
      if (!stopped && !terminal && !document.hidden) timer = setTimeout(() => void poll(), 1500);
    };
    const visibility = () => {
      clearTimeout(timer);
      controller?.abort();
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [id, notifyRound]);
  return state.id === id ? state : { round: null, error: null };
}
