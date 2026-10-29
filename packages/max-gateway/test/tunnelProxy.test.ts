// @effect-diagnostics nodeBuiltinImport:off - These tests drive real sockets against an in-process stub.
// @effect-diagnostics globalTimers:off - Timeouts and polling wait on real socket I/O.
// @effect-diagnostics globalDate:off - The 502 check measures wall-clock elapsed time.
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openAuthStore, type AuthStore } from "../src/auth/store.ts";
import { BearerTokenSource, sessionIssueArgs } from "../src/bearerToken.ts";
import { startMiniCompanion, type RunningMiniCompanion } from "../src/miniCompanion.ts";
import { maximusSessionOwnerAuth } from "../src/ownerAuth.ts";
import { classifyPath, startTunnelServer, type RunningTunnelServer } from "../src/tunnelServer.ts";

const SECRET = "task0-test-secret";
const TOKEN = "scoped-bearer-token";

beforeEach(() => {
  vi.useRealTimers();
});

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly cookie: string | null;
  readonly body: Buffer;
}

interface CapturedWs {
  data: Buffer;
  binary: boolean;
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface Upstream {
  readonly port: number;
  readonly url: string;
  readonly wsUrl: string;
  readonly requests: CapturedRequest[];
  readonly wsMessages: CapturedWs[];
  readonly upgrades: string[];
  stallAborted: () => boolean;
  close: () => Promise<void>;
}

async function startUpstream(
  binary: Buffer,
  script: "default" | "drip" | "stall" = "default",
): Promise<Upstream> {
  const requests: CapturedRequest[] = [];
  const wsMessages: CapturedWs[] = [];
  const upgrades: string[] = [];
  let releaseSecondHalf = (): void => {};
  const secondHalf = new Promise<void>((resolve) => {
    releaseSecondHalf = resolve;
  });
  let stallAborted = false;
  let dripTimer: ReturnType<typeof setInterval> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (url.startsWith("/__test/release")) {
        releaseSecondHalf();
        res.end("released");
        return;
      }
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? "GET",
        url,
        authorization:
          typeof req.headers.authorization === "string" ? req.headers.authorization : null,
        cookie: typeof req.headers.cookie === "string" ? req.headers.cookie : null,
        body,
      });
      if (url.startsWith("/api/auth/websocket-ticket") && req.method === "POST") {
        const payload = JSON.stringify({ ticket: "upstream-ticket" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      if (url.startsWith("/api/auth/session")) {
        const payload = JSON.stringify({ authenticated: true });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      if (script === "drip" && url.startsWith("/__test/drip")) {
        const parts = ["a", "b", "c", "d", "e", "f", "g", "h"];
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": String(parts.length),
        });
        res.socket?.setNoDelay(true);
        let index = 0;
        dripTimer = setInterval(() => {
          const part = parts[index];
          if (part === undefined) {
            if (dripTimer) clearInterval(dripTimer);
            if (!res.writableEnded) res.end();
            return;
          }
          index += 1;
          if (!res.writableEnded) res.write(part);
        }, 80);
        return;
      }
      if (script === "stall" && url.startsWith("/__test/stall")) {
        // Head goes out after a short pause, then nothing. The pause is long
        // enough that a timer which does not reset on the head fires first.
        res.socket?.setNoDelay(true);
        res.on("close", () => {
          if (!res.writableEnded) stallAborted = true;
        });
        stallTimer = setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          // writeHead can leave the status queued until the first body byte.
          // Flush so the gateway sees the head while the body stays silent.
          res.flushHeaders();
        }, 200);
        return;
      }
      if (url.startsWith("/attachments/")) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": binary.length,
        });
        res.socket?.setNoDelay(true);
        res.write(binary.subarray(0, 128));
        void secondHalf.then(() => {
          if (!res.writableEnded) res.end(binary.subarray(128));
        });
        return;
      }
      if (url.startsWith("/__test/upload")) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push(req.url ?? "/");
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.send("upstream-hello");
      ws.send(Buffer.from([9, 8, 7]));
      ws.on("message", (data, isBinary) => {
        const payload = asBuffer(data);
        wsMessages.push({ data: Buffer.from(payload), binary: isBinary });
        ws.send(payload, { binary: isBinary });
      });
    });
  });
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    requests,
    wsMessages,
    upgrades,
    stallAborted: () => stallAborted,
    close: async () => {
      releaseSecondHalf();
      if (dripTimer) clearInterval(dripTimer);
      if (stallTimer) clearTimeout(stallTimer);
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Stack {
  readonly gateway: RunningTunnelServer;
  readonly upstream: Upstream;
  readonly sessionToken: string;
  readonly companion?: RunningMiniCompanion;
  close: () => Promise<void>;
}

async function startStack(options?: {
  readonly connect?: boolean;
  readonly binary?: Buffer;
  readonly idleTimeoutMs?: number;
  readonly script?: "default" | "drip" | "stall";
}): Promise<Stack> {
  const upstream = await startUpstream(
    options?.binary ?? Buffer.alloc(0),
    options?.script ?? "default",
  );
  const tokenDir = await mkdtemp(path.join(tmpdir(), "t3mc-token-"));
  const auth: AuthStore = openAuthStore(path.join(tokenDir, "auth.sqlite"));
  const owner = auth.insertUser({
    email: "owner@example.com",
    passwordHash: "task0-not-a-login",
    displayName: "Owner",
  });
  const session = auth.createSession(owner.id);
  const gateway = await startTunnelServer({
    host: "127.0.0.1",
    tunnelSecret: SECRET,
    personalMode: true,
    ownerEmail: "owner@example.com",
    webDist: null,
    authStore: auth,
    isOwnerRequest: maximusSessionOwnerAuth((token) => auth.readSession(token) !== null),
    ...(options?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
  const previousToken = process.env.MAX_COMPANION_BEARER_TOKEN;
  const previousPath = process.env.MAX_COMPANION_TOKEN_PATH;
  process.env.MAX_COMPANION_BEARER_TOKEN = TOKEN;
  process.env.MAX_COMPANION_TOKEN_PATH = path.join(tokenDir, "should-not-write.json");
  let companion: RunningMiniCompanion | undefined;
  if (options?.connect !== false) {
    companion = startMiniCompanion({
      gatewayUrl: gateway.url,
      tunnelSecret: SECRET,
      upstreamHttpBase: upstream.url,
      upstreamWsBase: upstream.wsUrl,
    });
    await withTimeout(companion.ready, 3_000, "companion ready");
  }
  return {
    gateway,
    upstream,
    sessionToken: session.token,
    ...(companion ? { companion } : {}),
    close: async () => {
      if (previousToken === undefined) delete process.env.MAX_COMPANION_BEARER_TOKEN;
      else process.env.MAX_COMPANION_BEARER_TOKEN = previousToken;
      if (previousPath === undefined) delete process.env.MAX_COMPANION_TOKEN_PATH;
      else process.env.MAX_COMPANION_TOKEN_PATH = previousPath;
      if (companion) {
        void companion.ready.catch(() => {});
        await companion.close();
      }
      await gateway.close();
      auth.close();
      await upstream.close();
      await rm(tokenDir, { recursive: true, force: true });
    },
  };
}

function ownerHeaders(
  sessionToken: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return { cookie: `maximus_session=${sessionToken}`, ...extra };
}

function sendHttp(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: Buffer },
): Promise<{ status: number; body: Buffer }> {
  const target = new URL(url);
  return withTimeout(
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: init?.method ?? "GET",
          headers: init?.headers,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (init?.body) req.end(init.body);
      else req.end();
    }),
    3_000,
    `${init?.method ?? "GET"} ${target.pathname}`,
  );
}

describe("classifyPath", () => {
  it("owns only MAX's exact auth endpoints and proxies the rest of /api/auth", () => {
    const owned: ReadonlyArray<readonly [string, string]> = [
      ["POST", "/api/auth/register"],
      ["POST", "/api/auth/login"],
      ["POST", "/api/auth/logout"],
      ["GET", "/api/auth/me"],
      ["GET", "/api/auth/plan-status"],
      ["GET", "/api/auth/turn-status"],
      ["GET", "/api/billing/plans"],
      ["GET", "/__max/anything"],
    ];
    for (const [method, pathname] of owned) {
      expect(classifyPath(pathname, method), `${method} ${pathname}`).toBe("owned");
    }
    // T3's environment auth API (packages/contracts/src/environmentHttp.ts), plus the
    // MAX paths under the wrong method, which MAX does not answer.
    const proxied: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/browser-session"],
      ["POST", "/api/auth/websocket-ticket"],
      ["POST", "/api/auth/websocket-ticket/terminal"],
      ["POST", "/api/auth/pairing-token"],
      ["GET", "/api/auth/pairing-links"],
      ["POST", "/api/auth/pairing-links/revoke"],
      ["GET", "/api/auth/clients"],
      ["POST", "/api/auth/clients/revoke"],
      ["POST", "/api/auth/clients/revoke-others"],
      ["GET", "/api/auth"],
      ["GET", "/api/auth/login"],
      ["POST", "/api/auth/me"],
      ["GET", "/api/providers/keys"],
      ["GET", "/ws"],
    ];
    for (const [method, pathname] of proxied) {
      expect(classifyPath(pathname, method), `${method} ${pathname}`).toBe("proxy");
    }
    expect(classifyPath("/__max/health")).toBe("health");
    expect(classifyPath("/__max/tunnel")).toBe("tunnel");
  });
});

describe("max gateway tunnel", () => {
  it("rejects an unauthenticated proxied request with 401", async () => {
    const stack = await startStack();
    try {
      const missing = await sendHttp(`${stack.gateway.url}/api/auth/session`);
      expect(missing.status).toBe(401);
      const ticket = await sendHttp(`${stack.gateway.url}/api/auth/websocket-ticket`, {
        method: "POST",
      });
      expect(ticket.status).toBe(401);
      const wrong = await sendHttp(`${stack.gateway.url}/attachments/file.bin`, {
        headers: { cookie: "maximus_session=not-the-owner" },
      });
      expect(wrong.status).toBe(401);
      expect(stack.upstream.requests).toHaveLength(0);

      // These routes are gateway-owned now. A real session reaches /api/auth/me.
      // Personal mode rejects billing before the proxy. Neither is forwarded.
      const owned = await sendHttp(`${stack.gateway.url}/api/auth/me`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      const billing = await sendHttp(`${stack.gateway.url}/api/billing/plans`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(owned.status).toBe(200);
      expect(billing.status).toBe(403);
      expect(stack.upstream.requests).toHaveLength(0);
    } finally {
      await stack.close();
    }
  });

  it("rejects a tunnel handshake with the wrong secret", async () => {
    const stack = await startStack({ connect: false });
    try {
      const rejected = await withTimeout(
        new Promise<number>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${stack.gateway.port}/__max/tunnel`, {
            headers: { "x-max-tunnel-secret": "wrong-secret" },
          });
          ws.on("unexpected-response", (_req, res: IncomingMessage) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          ws.on("open", () => reject(new Error("wrong secret was accepted")));
          ws.on("error", () => {});
        }),
        3_000,
        "wrong secret handshake",
      );
      expect(rejected).toBe(401);
      const started = Date.now();
      const proxied = await sendHttp(`${stack.gateway.url}/api/auth/session`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(proxied.status).toBe(502);
      expect(Date.now() - started).toBeLessThan(500);
      expect(stack.upstream.requests).toHaveLength(0);
    } finally {
      await stack.close();
    }
  });

  it("round-trips an owner session request and injects the scoped bearer token", async () => {
    const stack = await startStack();
    try {
      const response = await sendHttp(`${stack.gateway.url}/api/auth/session?probe=1`, {
        headers: ownerHeaders(stack.sessionToken, { authorization: "Bearer intruder" }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({ authenticated: true });
      expect(stack.upstream.requests).toHaveLength(1);
      const seen = stack.upstream.requests[0];
      expect(seen?.method).toBe("GET");
      expect(seen?.url).toBe("/api/auth/session?probe=1");
      expect(seen?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen?.cookie).toBeNull();
      await expect(stat(process.env.MAX_COMPANION_TOKEN_PATH ?? "")).rejects.toThrow();

      const upload = Buffer.from([0, 1, 2, 255, 10, 13]);
      const posted = await sendHttp(`${stack.gateway.url}/__test/upload?name=a`, {
        method: "POST",
        headers: ownerHeaders(stack.sessionToken, { "content-type": "application/octet-stream" }),
        body: upload,
      });
      expect(posted.status).toBe(204);
      const postedSeen = stack.upstream.requests[1];
      expect(postedSeen?.method).toBe("POST");
      expect(postedSeen?.url).toBe("/__test/upload?name=a");
      expect(postedSeen?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(postedSeen?.body.equals(upload)).toBe(true);
    } finally {
      await stack.close();
    }
  });

  it("proxies T3 environment auth endpoints and keeps MAX's own auth endpoints", async () => {
    const stack = await startStack();
    try {
      const ticket = await sendHttp(`${stack.gateway.url}/api/auth/websocket-ticket`, {
        method: "POST",
        headers: ownerHeaders(stack.sessionToken, { "content-type": "application/json" }),
        body: Buffer.from("{}"),
      });
      expect(ticket.status).toBe(200);
      expect(JSON.parse(ticket.body.toString("utf8"))).toEqual({ ticket: "upstream-ticket" });
      const ticketSeen = stack.upstream.requests[0];
      expect(ticketSeen?.method).toBe("POST");
      expect(ticketSeen?.url).toBe("/api/auth/websocket-ticket");
      expect(ticketSeen?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(ticketSeen?.cookie).toBeNull();

      for (const path of [
        "/api/auth/websocket-ticket/terminal",
        "/api/auth/pairing-links/revoke",
        "/api/auth/clients/revoke",
      ]) {
        await sendHttp(`${stack.gateway.url}${path}`, {
          method: "POST",
          headers: ownerHeaders(stack.sessionToken),
        });
      }
      await sendHttp(`${stack.gateway.url}/api/auth/clients`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(stack.upstream.requests.slice(1).map((request) => request.url)).toEqual([
        "/api/auth/websocket-ticket/terminal",
        "/api/auth/pairing-links/revoke",
        "/api/auth/clients/revoke",
        "/api/auth/clients",
      ]);
      expect(
        stack.upstream.requests.every((request) => request.authorization === `Bearer ${TOKEN}`),
      ).toBe(true);

      const before = stack.upstream.requests.length;
      const me = await sendHttp(`${stack.gateway.url}/api/auth/me`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(me.status).toBe(200);
      expect(JSON.parse(me.body.toString("utf8"))).toHaveProperty("user");
      const plan = await sendHttp(`${stack.gateway.url}/api/auth/plan-status`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(plan.status).toBe(200);
      expect(stack.upstream.requests).toHaveLength(before);
    } finally {
      await stack.close();
    }
  });

  it("echoes websocket text and binary frames in both directions", async () => {
    const stack = await startStack();
    try {
      const client = new WebSocket(`ws://127.0.0.1:${stack.gateway.port}/ws?wsTicket=ticket-1`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      const received: CapturedWs[] = [];
      client.on("message", (data, isBinary) => {
        received.push({ data: asBuffer(data), binary: isBinary });
      });
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          client.once("open", () => resolve());
          client.once("error", reject);
        }),
        3_000,
        "client websocket open",
      );
      client.send("hello-text");
      client.send(Buffer.from([0, 1, 2, 255]));
      await withTimeout(
        waitFor(() => {
          const texts = received
            .filter((message) => !message.binary)
            .map((message) => message.data.toString("utf8"));
          const binaries = received
            .filter((message) => message.binary)
            .map((message) => message.data);
          const sawUpstream =
            texts.includes("upstream-hello") &&
            binaries.some((data) => data.equals(Buffer.from([9, 8, 7])));
          const sawEcho =
            texts.includes("hello-text") &&
            binaries.some((data) => data.equals(Buffer.from([0, 1, 2, 255])));
          const forwardedText = stack.upstream.wsMessages.some(
            (message) => !message.binary && message.data.toString("utf8") === "hello-text",
          );
          const forwardedBinary = stack.upstream.wsMessages.some(
            (message) => message.binary && message.data.equals(Buffer.from([0, 1, 2, 255])),
          );
          return sawUpstream && sawEcho && forwardedText && forwardedBinary;
        }),
        3_000,
        "websocket echo",
      );
      expect(stack.upstream.upgrades.some((url) => url.startsWith("/ws?wsTicket=ticket-1"))).toBe(
        true,
      );
      client.close();
    } finally {
      await stack.close();
    }
  });

  it("streams an attachment body byte-for-byte without waiting for the whole file", async () => {
    const binary = Buffer.alloc(4096);
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 256;
    const stack = await startStack({ binary });
    try {
      const response = await withTimeout(
        openGet(`${stack.gateway.url}/attachments/file.bin`, ownerHeaders(stack.sessionToken)),
        3_000,
        "attachment response headers",
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      const first = await withTimeout(readSome(response, 1), 3_000, "attachment first bytes");
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThan(binary.length);
      expect(binary.subarray(0, first.length).equals(first)).toBe(true);
      const release = await sendHttp(`${stack.upstream.url}/__test/release`);
      expect(release.status).toBe(200);
      const rest = await withTimeout(readRest(response, first), 3_000, "attachment rest");
      expect(rest.equals(binary)).toBe(true);
    } finally {
      await stack.close();
    }
  });

  it("completes a slow-drip response that outlives the idle timeout", async () => {
    const stack = await startStack({ idleTimeoutMs: 250, script: "drip" });
    try {
      const response = await sendHttp(`${stack.gateway.url}/__test/drip`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(response.status).toBe(200);
      expect(response.body.toString("utf8")).toBe("abcdefgh");
    } finally {
      await stack.close();
    }
  });

  it("returns 504 when a response sends its head and then stalls", async () => {
    const stack = await startStack({ idleTimeoutMs: 500, script: "stall" });
    try {
      const started = Date.now();
      const response = await sendHttp(`${stack.gateway.url}/__test/stall`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      const elapsed = Date.now() - started;
      expect(response.status).toBe(504);
      expect(response.body.toString("utf8")).toBe("gateway timeout\n");
      // Head is delayed 200ms and the idle limit is 500ms, so a clock that
      // resets on the head finishes after ~700ms. A clock that does not
      // reset finishes at ~500ms.
      expect(elapsed).toBeGreaterThanOrEqual(620);
      expect(elapsed).toBeLessThan(2_500);
      await waitFor(() => stack.upstream.stallAborted());
    } finally {
      await stack.close();
    }
  });

  it("fails fast with 502 when no tunnel is connected", async () => {
    const stack = await startStack({ connect: false });
    try {
      const started = Date.now();
      const response = await sendHttp(`${stack.gateway.url}/api/auth/session`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      const elapsed = Date.now() - started;
      expect(response.status).toBe(502);
      expect(elapsed).toBeLessThan(500);
      const upgrade = await withTimeout(
        new Promise<number>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${stack.gateway.port}/ws?wsTicket=ticket-1`, {
            headers: ownerHeaders(stack.sessionToken),
          });
          ws.on("unexpected-response", (_req, res: IncomingMessage) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          ws.on("open", () => reject(new Error("websocket opened without a tunnel")));
          ws.on("error", () => {});
        }),
        3_000,
        "websocket without tunnel",
      );
      expect(upgrade).toBe(502);
      expect(stack.upstream.requests).toHaveLength(0);
      expect(stack.upstream.upgrades).toHaveLength(0);
    } finally {
      await stack.close();
    }
  });

  it("issues the scoped bearer with --scope and stores it in a 0600 file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3mc-issue-"));
    const logPath = path.join(dir, "calls.log");
    const tokenPath = path.join(dir, "token.json");
    const bin = path.join(dir, "t3");
    await writeFile(logPath, "");
    await writeFile(
      bin,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("issued-token-value\\n");
`,
    );
    await chmod(bin, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CALL_LOG: logPath,
      MAX_COMPANION_TOKEN_PATH: tokenPath,
    };
    delete env.MAX_COMPANION_BEARER_TOKEN;
    delete env.MAX_COMPANION_TOKEN_TTL;
    let now = 1_700_000_000_000;
    try {
      const source = new BearerTokenSource({
        env,
        bin,
        tokenPath,
        now: () => now,
      });
      const first = await source.getToken();
      expect(first).toBe("issued-token-value");
      const calls = await readCalls(logPath);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(sessionIssueArgs("365d"));
      expect(calls[0]?.includes("--scopes")).toBe(false);
      expect(calls[0]?.filter((arg) => arg === "--scope")).toHaveLength(7);
      const info = await stat(tokenPath);
      expect(info.mode & 0o777).toBe(0o600);
      const directory = await stat(dir);
      expect(directory.mode & 0o777).toBe(0o700);

      await source.getToken();
      expect(await readCalls(logPath)).toHaveLength(1);

      now += 365 * 86_400_000 - 6 * 86_400_000;
      await source.getToken();
      expect(await readCalls(logPath)).toHaveLength(2);
      source.stop();

      const injected = new BearerTokenSource({
        env: {
          MAX_COMPANION_BEARER_TOKEN: "env-token",
          MAX_COMPANION_TOKEN_PATH: path.join(dir, "absent.json"),
        },
        runIssue: () => Promise.reject(new Error("CLI should not run")),
      });
      expect(await injected.getToken()).toBe("env-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function readCalls(logPath: string): Promise<string[][]> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 2_800) {
        clearInterval(timer);
        reject(new Error("condition was not met"));
      }
    }, 15);
  });
}

function openGet(url: string, headers: Record<string, string>): Promise<IncomingMessage> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

function readSome(response: IncomingMessage, minimum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= minimum) {
        response.pause();
        response.off("data", onData);
        resolve(Buffer.concat(chunks));
      }
    };
    response.on("data", onData);
    response.on("error", reject);
    response.on("end", () => {
      if (size < minimum) reject(new Error("response ended before the first bytes"));
    });
  });
}

function readRest(response: IncomingMessage, already: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks = [already];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
    response.resume();
  });
}
