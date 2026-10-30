import { describe, expect, it } from "vite-plus/test";

import { councilFixture } from "./councilRound.test-fixture";
import type { CouncilContenderState } from "./councilApi";
import { answeredCount, buildCouncilPages, reconcilePageIndex } from "./councilPages";

function contender(key: string, patch: Partial<CouncilContenderState>): CouncilContenderState {
  return { ...councilFixture().round.contenders[0]!, key, roleId: null, roleName: null, ...patch };
}

describe("buildCouncilPages", () => {
  it("has no pages while nobody has finished", () => {
    const { round } = councilFixture();
    round.contenders = [
      contender("c0", { status: "running" }),
      contender("c1", { status: "pending" }),
    ];
    expect(buildCouncilPages(round)).toEqual([]);
    expect(answeredCount(round)).toBe(0);
  });

  it("puts the first finisher in front, failures after, approvals next and synthesis last", () => {
    const { round } = councilFixture();
    round.contenders = [
      contender("c0", { status: "complete", finishedAt: "2026-10-29T18:00:09Z" }),
      contender("c1", { status: "complete", finishedAt: "2026-10-29T18:00:03Z" }),
      contender("c2", { status: "failed", finishedAt: "2026-10-29T18:00:01Z" }),
      contender("c3", { status: "needs-attention" }),
      contender("c4", { status: "running" }),
    ];
    expect(buildCouncilPages(round).map((page) => page.id)).toEqual([
      "c1",
      "c0",
      "c2",
      "c3",
      "synthesis",
    ]);
    expect(answeredCount(round)).toBe(3);
  });

  it("shows the skipped synthesis page when every model failed", () => {
    const { round } = councilFixture();
    round.status = "failed";
    round.synthesis.status = "skipped";
    round.contenders = [contender("c0", { status: "failed", finishedAt: "2026-10-29T18:00:01Z" })];
    expect(buildCouncilPages(round).map((page) => page.kind)).toEqual(["contender", "synthesis"]);
  });

  it("is stable: the same input gives the same order", () => {
    const { round } = councilFixture();
    round.contenders = [
      contender("c0", { status: "complete", finishedAt: "2026-10-29T18:00:05Z" }),
      contender("c1", { status: "complete", finishedAt: "2026-10-29T18:00:05Z" }),
    ];
    const first = buildCouncilPages(round).map((page) => page.id);
    round.contenders.reverse();
    expect(buildCouncilPages(round).map((page) => page.id)).toEqual(first);
  });
});

describe("reconcilePageIndex", () => {
  it("keeps the reader on the same page when a new page appears behind", () => {
    const { round } = councilFixture();
    round.contenders = [
      contender("c0", { status: "complete", finishedAt: "2026-10-29T18:00:01Z" }),
    ];
    const before = buildCouncilPages(round);
    round.contenders.push(
      contender("c1", { status: "complete", finishedAt: "2026-10-29T18:00:02Z" }),
    );
    const after = buildCouncilPages(round);
    expect(reconcilePageIndex(before, 1, after)).toBe(2);
    expect(reconcilePageIndex(before, 0, after)).toBe(0);
  });

  it("clamps when the previous page disappeared", () => {
    expect(reconcilePageIndex([], 4, buildCouncilPages(councilFixture().round))).toBe(0);
  });
});
