/** Session reads must settle even when a short-lived Effect subscriber unmounts.
 * They are small idempotent requests; a bounded independent signal prevents
 * subscriber churn from repeatedly aborting the browser's auth transport. */
export function settledAuthFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname !== "/api/auth/session") return fetch(input, init);
    const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
    await response.clone().arrayBuffer();
    return response;
  };
}
