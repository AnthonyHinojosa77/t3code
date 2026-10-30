import { describe, expect, it } from "vite-plus/test";

import { isOwnerSession } from "../src/ownerAuth.ts";

const sessions: Record<string, { email: string }> = {
  owner: { email: "owner@example.com" },
  other: { email: "someone@example.com" },
};
const read = (token: string) => sessions[token] ?? null;

describe("isOwnerSession", () => {
  it("lets only the configured owner's session through", () => {
    const check = isOwnerSession(read, "Owner@Example.com ");
    expect(check("owner")).toBe(true);
    expect(check("other")).toBe(false);
    expect(check("missing")).toBe(false);
  });

  it("rejects every session when no owner is configured", () => {
    const check = isOwnerSession(read, null);
    expect(check("owner")).toBe(false);
  });
});
