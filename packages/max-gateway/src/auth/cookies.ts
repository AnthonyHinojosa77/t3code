// @effect-diagnostics nodeBuiltinImport:off - The session token is read from the Node request cookie or bearer header.
import type { IncomingMessage } from "node:http";

import { readCookie } from "../ownerAuth.ts";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from "./store.ts";

function secureAttribute(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

/** HttpOnly, SameSite=Lax, Path=/, 30 days. Secure only when NODE_ENV is production. */
export function sessionSetCookie(token: string): string {
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttribute()}`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute()}`;
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
