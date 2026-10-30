import { describe, expect, it } from "vite-plus/test";

import { isPhoneLayout, MAX_PHONE_LAYOUT_QUERY } from "./maxLayout";

describe("phone layout", () => {
  it("treats narrow windows and sideways phones as phones, and tablets and laptops as computers", () => {
    expect(isPhoneLayout({ width: 390, height: 844, coarsePointer: true })).toBe(true);
    expect(isPhoneLayout({ width: 844, height: 390, coarsePointer: true })).toBe(true);
    expect(isPhoneLayout({ width: 844, height: 390, coarsePointer: false })).toBe(false);
    expect(isPhoneLayout({ width: 768, height: 1024, coarsePointer: true })).toBe(false);
    expect(isPhoneLayout({ width: 1440, height: 900, coarsePointer: false })).toBe(false);
  });

  // The stylesheet repeats this query; e2e/max/walkthrough.mjs checks the two still agree.
  it("is the query the stylesheet repeats", () => {
    expect(MAX_PHONE_LAYOUT_QUERY).toBe(
      "(max-width: 767px), (pointer: coarse) and (max-height: 500px)",
    );
  });
});
