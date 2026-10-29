// @effect-diagnostics nodeBuiltinImport:off - The session token is read from the Node request cookie or bearer header.
import type { IncomingMessage } from "node:http";

import { readCookie } from "../ownerAuth.ts";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from "./store.ts";

/**
 * Secure on HTTPS deployments. Local dev stays non-Secure so the cookie is
 * stored on http://127.0.0.1. Pass `env` in tests; the default is `process.env`.
 * A non-empty `RAILWAY_ENVIRONMENT` counts as Railway. The variables reference
 * also publishes `RAILWAY_ENVIRONMENT_NAME`; `NODE_ENV=production` is the
 * setting the runbook requires so the cookie is Secure either way.
 */
export function sessionCookieIsSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return true;
  const railway = env.RAILWAY_ENVIRONMENT?.trim();
  return railway !== undefined && railway.length > 0;
}

function secureAttribute(env: NodeJS.ProcessEnv): string {
  return sessionCookieIsSecure(env) ? "; Secure" : "";
}

/** HttpOnly, SameSite=Lax, Path=/, 30 days. Secure when `sessionCookieIsSecure` is true. */
export function sessionSetCookie(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttribute(env)}`;
}

export function sessionClearCookie(env: NodeJS.ProcessEnv = process.env): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute(env)}`;
}

/**
 * Cookie first, then `Authorization: Bearer`, matching MAX's session lookup.
 * The proxied-request owner check stays cookie-only.
 */
export function readSessionToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  const cookieHeader = Array.isArray(header) ? header.join("; ") : header;
  const fromCookie = readCookie(cookieHeader, SESSION_COOKIE);
  if (fromCookie) return fromCookie;
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
