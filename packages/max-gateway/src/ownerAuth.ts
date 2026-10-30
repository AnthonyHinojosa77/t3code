// @effect-diagnostics nodeBuiltinImport:off - Owner checks read the incoming Node request that the gateway already accepted.
import type { IncomingMessage } from "node:http";

export type OwnerRequestCheck = (req: IncomingMessage) => boolean | Promise<boolean>;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Task 0 owner check. Task 1 replaces `isValidSession` with the real
 * `maximus_session` lookup. Missing or unknown cookies are not the owner.
 */
export function maximusSessionOwnerAuth(
  isValidSession: (session: string) => boolean | Promise<boolean>,
  cookieName = "maximus_session",
): OwnerRequestCheck {
  return (req) => {
    const header = req.headers.cookie;
    const cookie = Array.isArray(header) ? header.join("; ") : header;
    const session = readCookie(cookie, cookieName);
    if (!session) return false;
    return isValidSession(session);
  };
}

/**
 * Only the configured owner's session reaches the Mini. Any other account (for example
 * one created while public plans are enabled) is treated as anonymous.
 */
export function isOwnerSession(
  readSession: (session: string) => { readonly email: string } | null,
  ownerEmail: string | null,
): (session: string) => boolean {
  const owner = ownerEmail?.trim().toLowerCase();
  return (session) => {
    if (!owner) return false;
    return readSession(session)?.email.trim().toLowerCase() === owner;
  };
}
