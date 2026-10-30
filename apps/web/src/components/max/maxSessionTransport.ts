/** Fence page-lifetime T3 services before MAX revokes its cookie session. */
export function createMaxSessionTransport(fetch: typeof globalThis.fetch, origin: string) {
  let stopped = false;
  const pending = new Map<AbortController, Promise<Response>>();
  const sessionFetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    const protectedRequest =
      url.origin === origin &&
      url.pathname.startsWith("/api/") &&
      !["/api/auth/me", "/api/auth/login", "/api/auth/register", "/api/auth/logout"].includes(
        url.pathname,
      );
    if (!protectedRequest) return fetch(input, init);
    if (stopped) return Promise.reject(new DOMException("MAX session is closing", "AbortError"));
    const controller = new AbortController();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const request = fetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    }).finally(() => pending.delete(controller));
    pending.set(controller, request);
    return request;
  };
  return {
    fetch: sessionFetch,
    resume() {
      stopped = false;
    },
    stop() {
      stopped = true;
      const requests = [...pending.values()];
      for (const controller of pending.keys()) controller.abort();
      return Promise.allSettled(requests).then(() => undefined);
    },
  };
}

let transport: ReturnType<typeof createMaxSessionTransport> | undefined;
export function installMaxSessionTransport(): void {
  if (transport) return;
  transport = createMaxSessionTransport(globalThis.fetch.bind(globalThis), window.location.origin);
  globalThis.fetch = transport.fetch;
}
export function resumeMaxSessionTransport(): void {
  transport?.resume();
}
export async function stopMaxSessionServices(): Promise<void> {
  await (transport?.stop() ?? Promise.resolve());
  const { stopClientTracing } = await import("../../observability/clientTracing");
  await stopClientTracing();
}
