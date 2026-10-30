import { describe, expect, it, vi } from "vite-plus/test";
import { createMaxSessionTransport } from "./maxSessionTransport";

describe("MAX logout transport", () => {
  it("aborts existing requests and blocks new telemetry before revoking the session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const transport = createMaxSessionTransport(fetch, "https://max.example");
    const request = transport.fetch("https://max.example/api/auth/session");
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await transport.stop();
    await rejected;
    await expect(
      transport.fetch("https://max.example/api/observability/v1/traces"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps logout and anonymous login available and resumes on a new session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    const transport = createMaxSessionTransport(fetch, "https://max.example");
    await transport.stop();
    await transport.fetch("https://max.example/api/auth/logout", { method: "POST" });
    await transport.fetch("https://max.example/api/auth/me");
    await transport.fetch("https://max.example/api/auth/login", { method: "POST" });
    transport.resume();
    await transport.fetch("https://max.example/api/council/templates");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
