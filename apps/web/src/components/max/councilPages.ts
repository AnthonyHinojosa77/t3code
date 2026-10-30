import type {
  ContenderStatus,
  CouncilContenderState,
  CouncilRound,
  CouncilSynthesisState,
} from "./councilApi";

/** One e-book page of a council round. The synthesis is always the last page. */
export type CouncilPage =
  | { readonly kind: "contender"; readonly id: string; readonly contender: CouncilContenderState }
  | {
      readonly kind: "synthesis";
      readonly id: "synthesis";
      readonly synthesis: CouncilSynthesisState;
    };

const FINISHED: ReadonlySet<ContenderStatus> = new Set([
  "complete",
  "failed",
  "timed-out",
  "cancelled",
]);

export function isContenderFinished(status: ContenderStatus): boolean {
  return FINISHED.has(status);
}

function byFinishTime(a: CouncilContenderState, b: CouncilContenderState): number {
  const at = a.finishedAt ? Date.parse(a.finishedAt) : Number.POSITIVE_INFINITY;
  const bt = b.finishedAt ? Date.parse(b.finishedAt) : Number.POSITIVE_INFINITY;
  return at === bt ? a.key.localeCompare(b.key) : at - bt;
}

/**
 * Pages in reading order: successful answers in the order they finished, then failed or
 * timed-out answers, then answers blocked on an approval, then the synthesis. Everything is
 * derived from persisted timestamps, so the order is the same after a reload.
 */
export function buildCouncilPages(
  round: Pick<CouncilRound, "contenders" | "synthesis" | "status">,
): CouncilPage[] {
  const complete = round.contenders.filter((c) => c.status === "complete").sort(byFinishTime);
  const unsuccessful = round.contenders
    .filter((c) => c.status === "failed" || c.status === "timed-out" || c.status === "cancelled")
    .sort(byFinishTime);
  const blocked = round.contenders
    .filter((c) => c.status === "needs-attention")
    .sort((a, b) => a.key.localeCompare(b.key));
  const contenders = [...complete, ...unsuccessful, ...blocked];
  const roundActive = round.status === "running" || round.status === "synthesizing";
  if (contenders.length === 0 && roundActive) return [];
  return [
    ...contenders.map((contender) => ({
      kind: "contender" as const,
      id: contender.key,
      contender,
    })),
    { kind: "synthesis" as const, id: "synthesis" as const, synthesis: round.synthesis },
  ];
}

export function answeredCount(round: Pick<CouncilRound, "contenders">): number {
  return round.contenders.filter((c) => isContenderFinished(c.status)).length;
}

/** Keeps the reader on the page they were reading when pages are added or reordered. */
export function reconcilePageIndex(
  previousPages: ReadonlyArray<CouncilPage>,
  previousIndex: number,
  nextPages: ReadonlyArray<CouncilPage>,
): number {
  if (nextPages.length === 0) return 0;
  const currentId = previousPages[previousIndex]?.id;
  if (currentId !== undefined) {
    const found = nextPages.findIndex((page) => page.id === currentId);
    if (found >= 0) return found;
  }
  return Math.min(Math.max(previousIndex, 0), nextPages.length - 1);
}

export function pageTitle(
  page: CouncilPage,
  describe: (instanceId: string, model: string) => string,
): string {
  return page.kind === "synthesis"
    ? `Synthesis · ${describe(page.synthesis.instanceId, page.synthesis.model)}`
    : describe(page.contender.instanceId, page.contender.model);
}
