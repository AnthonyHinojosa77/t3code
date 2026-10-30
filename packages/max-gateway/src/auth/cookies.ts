// @effect-diagnostics nodeBuiltinImport:off - The session token is read from the Node request cookie or bearer header.
import * as NodeHttp from "node:http";
type IncomingMessage = NodeHttp.IncomingMessage;

import { readCookie } from "../ownerAuth.ts";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from "./store.ts";

/** Secure in production or Railway; local HTTP dev remains non-Secure.
 * Tests pass an explicit environment instead of reading process.env. */
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
