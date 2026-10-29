import { pathToFileURL } from "node:url";

import { maximusSessionOwnerAuth } from "./ownerAuth.ts";
import { startTunnelServer } from "./tunnelServer.ts";

function allowListedSessions(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((session) => session.trim())
      .filter((session) => session.length > 0),
  );
}

export async function main(): Promise<void> {
  const tunnelSecret = process.env.MAX_TUNNEL_SECRET;
  if (!tunnelSecret) {
    process.stderr.write("MAX_TUNNEL_SECRET is required\n");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write("PORT must be a positive integer\n");
    process.exit(1);
  }
  // Task 0 stand-in for MAX login. Task 1 replaces this with maximus_session issuance.
  const allowed = allowListedSessions(process.env.MAX_OWNER_SESSION_ALLOWLIST);
  const server = await startTunnelServer({
    host: process.env.HOST ?? "0.0.0.0",
    port,
    tunnelSecret,
    isOwnerRequest: maximusSessionOwnerAuth((session) => allowed.has(session)),
  });
  process.stderr.write(`max-gateway listening on ${server.port}\n`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void main();
}
