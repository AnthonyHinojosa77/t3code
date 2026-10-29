// @effect-diagnostics nodeBuiltinImport:off - Startup opens the local account file and checks the web build directory.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isPersonalMode, readOwnerEmail, warnIfOwnerEmailMissing } from "./auth/personalMode.ts";
import { openAuthStore, resolveAuthDbPath } from "./auth/store.ts";
import { maximusSessionOwnerAuth } from "./ownerAuth.ts";
import { defaultWebDist } from "./staticApp.ts";
import { startTunnelServer } from "./tunnelServer.ts";

function resolveWebDist(): string | null {
  const configured = process.env.MAX_WEB_DIST?.trim();
  const candidate =
    configured && configured.length > 0 ? path.resolve(configured) : defaultWebDist();
  return existsSync(candidate) ? candidate : null;
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
  warnIfOwnerEmailMissing();
  const authStore = openAuthStore(resolveAuthDbPath());
  authStore.pruneExpired();
  const server = await startTunnelServer({
    host: process.env.HOST ?? "0.0.0.0",
    port,
    tunnelSecret,
    authStore,
    personalMode: isPersonalMode(),
    ownerEmail: readOwnerEmail(),
    webDist: resolveWebDist(),
    isOwnerRequest: maximusSessionOwnerAuth((session) => authStore.readSession(session) !== null),
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
