import { describe, expect, it, vi } from "@effect/vitest";
import { settledAuthFetch } from "./settledAuthFetch";

describe("settled auth transport", () => {
  it("keeps a completed auth response intact when the request scope closes", async () => {
    let transportSignal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      transportSignal = init?.signal;
      return new Response('{"authenticated":true}');
    });
    const scope = new AbortController();
    const response = await settledAuthFetch(fetch)("https://example.com/api/auth/session", {
      signal: scope.signal,
    });
    scope.abort();
    expect(transportSignal?.aborted).toBe(false);
    expect(await response.json()).toEqual({ authenticated: true });
  });

  it("lets an auth read settle when its subscriber leaves during the request", async () => {
    const scope = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      scope.abort();
      expect(init?.signal?.aborted).toBe(false);
      return new Response('{"authenticated":true}');
    });
    const response = await settledAuthFetch(fetch)("https://example.com/api/auth/session", {
      signal: scope.signal,
    });
    expect(await response.json()).toEqual({ authenticated: true });
  });

  it("preserves streaming and cancellation for other requests", async () => {
    const response = new Response("stream");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const scope = new AbortController();
    const init = { signal: scope.signal };
    expect(await settledAuthFetch(fetch)("https://example.com/api/messages", init)).toBe(response);
    expect(fetch).toHaveBeenCalledWith("https://example.com/api/messages", init);
    expect(response.bodyUsed).toBe(false);
  });
});
