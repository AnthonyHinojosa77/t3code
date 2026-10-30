import { create } from "zustand";

import {
  councilApi,
  type CouncilRound,
  type CouncilRoundSummary,
  type CouncilTemplate,
} from "./councilApi";

interface CouncilHomeState {
  readonly templates: CouncilTemplate[];
  readonly rounds: CouncilRoundSummary[];
  readonly error: string | null;
  readonly loaded: boolean;
}

/** Templates and saved rounds shared by the composer, the chat window and the side panel. */
export const useCouncilHome = create<CouncilHomeState>(() => ({
  templates: [],
  rounds: [],
  error: null,
  loaded: false,
}));

let inflight: Promise<void> | null = null;

/** One request at a time: the side panel and the chat window may both ask on the same tick. */
export function refreshCouncilHome(): Promise<void> {
  if (inflight) return inflight;
  const request = Promise.all([councilApi.templates(), councilApi.rounds()])
    .then(([templates, rounds]) => {
      useCouncilHome.setState({ ...templates, ...rounds, error: null, loaded: true });
    })
    .catch((cause: unknown) => {
      useCouncilHome.setState({
        error: cause instanceof Error ? cause.message : "Couldn’t load council",
        loaded: true,
      });
    })
    .finally(() => {
      inflight = null;
    });
  inflight = request;
  return request;
}

export function summarizeCouncilRound(round: CouncilRound): CouncilRoundSummary {
  return {
    id: round.id,
    prompt: round.prompt.slice(0, 200),
    status: round.status,
    templateName: round.templateName,
    contenderCount: round.contenders.length,
    createdAt: round.createdAt,
    updatedAt: round.updatedAt,
  };
}

/** Called from the round poll: keeps the panel's status for the open round current. */
export function syncCouncilRoundSummary(round: CouncilRound): void {
  const known = useCouncilHome.getState().rounds.find((entry) => entry.id === round.id);
  if (known && known.status === round.status && known.updatedAt === round.updatedAt) return;
  upsertCouncilRoundSummary(summarizeCouncilRound(round));
}

/** Keeps the side panel current without another request. */
export function upsertCouncilRoundSummary(summary: CouncilRoundSummary): void {
  useCouncilHome.setState((state) => ({
    rounds: [summary, ...state.rounds.filter((entry) => entry.id !== summary.id)].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    ),
  }));
}
