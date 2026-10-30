import { describe, expect, it } from "vite-plus/test";

import {
  lift,
  liftingPage,
  pageTransform,
  restingX,
  settleDecision,
  settleDuration,
  shadedPage,
  turningX,
} from "./MaxPageStack";

describe("page geometry", () => {
  it("steps pages behind to the right so their edges show, and parks turned pages off left", () => {
    expect(restingX(0, 390)).toBe(0);
    expect(restingX(1, 390)).toBe(8);
    expect(restingX(2, 390)).toBe(16);
    expect(restingX(5, 390)).toBe(24);
    expect(restingX(-1, 390)).toBe(-390);
  });

  it("slides each page to its next resting place as the turn progresses", () => {
    expect(turningX(0, 390, -1, true)).toBe(-390);
    expect(turningX(1, 390, -1, true)).toBe(0);
    expect(turningX(1, 390, -0.5, true)).toBe(4);
    expect(turningX(0, 390, 1, true)).toBe(8);
    expect(turningX(-1, 390, 1, true)).toBe(0);
  });

  it("rubber-bands at the ends", () => {
    expect(turningX(0, 390, -1, false)).toBeCloseTo(-117);
  });
});

describe("settle", () => {
  it("turns on distance or on a flick, in the allowed direction only", () => {
    expect(settleDecision({ progress: -0.3, velocity: 0, canNext: true, canPrev: true })).toBe(1);
    expect(settleDecision({ progress: -0.1, velocity: -0.8, canNext: true, canPrev: true })).toBe(
      1,
    );
    expect(settleDecision({ progress: -0.1, velocity: 0, canNext: true, canPrev: true })).toBe(0);
    expect(settleDecision({ progress: 0.5, velocity: 0, canNext: true, canPrev: false })).toBe(0);
    expect(settleDecision({ progress: 0.5, velocity: 0, canNext: true, canPrev: true })).toBe(-1);
  });

  it("settles faster after a fast flick, within bounds", () => {
    expect(settleDuration(390, 0)).toBe(420);
    expect(settleDuration(390, 3)).toBe(180);
    expect(settleDuration(300, 1)).toBe(300);
  });
});

describe("depth", () => {
  it("lifts only the moving page, flat at both ends and highest halfway", () => {
    expect(lift(0, 0, true)).toBe(0);
    expect(lift(0, -0.5, true)).toBeCloseTo(1);
    expect(lift(0, -1, true)).toBeCloseTo(0);
    expect(lift(1, -0.5, true)).toBe(0);
    expect(lift(-1, 0.5, true)).toBeCloseTo(1);
    expect(lift(0, 0.5, true)).toBe(0);
    expect(lift(0, -0.5, false)).toBe(0);
  });

  it("casts the shadow on the page under the moving one", () => {
    expect(liftingPage(-0.3)).toBe(0);
    expect(shadedPage(-0.3)).toBe(1);
    expect(liftingPage(0.3)).toBe(-1);
    expect(shadedPage(0.3)).toBe(0);
  });

  it("tilts the moving page about its spine mid-turn and not at rest", () => {
    expect(pageTransform(0, 390, 0, true)).toBe("translateX(0px)");
    expect(pageTransform(0, 390, -0.5, true)).toBe("translateX(-195px) rotateY(-12.000deg)");
    expect(pageTransform(1, 390, -0.5, true)).toBe("translateX(4px)");
    expect(pageTransform(0, 390, -1, true)).toBe("translateX(-390px)");
  });
});
