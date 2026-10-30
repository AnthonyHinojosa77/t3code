// @effect-diagnostics nodeBuiltinImport:off - Owner checks read the incoming Node request that the gateway already accepted.
import * as NodeHttp from "node:http";
type IncomingMessage = NodeHttp.IncomingMessage;

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
