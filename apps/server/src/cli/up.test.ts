import { expect, it } from "@effect/vitest";

import { upsertServiceEnv } from "./up.ts";

it("rewrites only the service.env keys t3 up owns and keeps the user's lines", () => {
  const before = [
    "# my settings",
    "T3CODE_PORT=4000",
    "export T3CODE_TAILSCALE_ONLY=0",
    "T3CODE_TAILSCALE_OWNER=123",
    "T3CODE_TAILSCALE_ONLY=0",
    "",
  ].join("\n");
  expect(
    upsertServiceEnv(before, {
      T3CODE_TAILSCALE_SIGN_IN: "1",
      T3CODE_TAILSCALE_ONLY: "1",
      T3CODE_TAILSCALE_OWNER: undefined,
    }),
  ).toBe(
    [
      "# my settings",
      "T3CODE_PORT=4000",
      "T3CODE_TAILSCALE_ONLY=1",
      "T3CODE_TAILSCALE_SIGN_IN=1",
      "",
    ].join("\n"),
  );
  expect(upsertServiceEnv("", { T3CODE_TAILSCALE_SIGN_IN: "1" })).toBe(
    "T3CODE_TAILSCALE_SIGN_IN=1\n",
  );
});
