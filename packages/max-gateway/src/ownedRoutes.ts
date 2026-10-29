// @effect-diagnostics nodeBuiltinImport:off - Owned routes answer the Node request the gateway already accepted.
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleAuthHttp, isMaxAuthRoute, type AuthHttpContext } from "./auth/http.ts";
import type { AuthStore } from "./auth/store.ts";
import { handleBillingHttp } from "./billing/http.ts";
import { sendJson } from "./httpUtil.ts";

export interface OwnedRouteContext {
  readonly authStore: AuthStore | null;
  readonly personalMode: boolean;
  readonly ownerEmail: string | null;
  readonly cookieEnv: NodeJS.ProcessEnv;
}

function isProviderPath(pathname: string): boolean {
  return pathname === "/api/providers" || pathname.startsWith("/api/providers/");
}

function isBillingPath(pathname: string): boolean {
  return pathname === "/api/billing" || pathname.startsWith("/api/billing/");
}

/**
 * Gateway-owned HTTP. Returns false when the path should stay a 404.
 * Personal mode answers every `/api/billing/*` and `/api/providers/*` with 403
 * before billing code or Stripe runs, including when the caller has no session.
 */
export async function handleOwnedHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: OwnedRouteContext,
): Promise<boolean> {
  if (ctx.personalMode && isProviderPath(url.pathname)) {
    req.resume();
    sendJson(res, 403, { error: "Provider settings are disabled in personal mode." });
    return true;
  }
  if (isBillingPath(url.pathname)) {
    if (ctx.personalMode) {
      req.resume();
      sendJson(res, 403, { error: "Billing is disabled in personal mode." });
      return true;
    }
    if (!ctx.authStore) return false;
    return handleBillingHttp(req, res, url, ctx.authStore);
  }
  if (isMaxAuthRoute(req.method ?? "GET", url.pathname)) {
    if (!ctx.authStore) return false;
    const auth: AuthHttpContext = {
      authStore: ctx.authStore,
      personalMode: ctx.personalMode,
      ownerEmail: ctx.ownerEmail,
      cookieEnv: ctx.cookieEnv,
    };
    return handleAuthHttp(req, res, url, auth);
  }
  return false;
}
