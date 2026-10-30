// @effect-diagnostics nodeBuiltinImport:off - These tests drive real sockets against an in-process stub.
// @effect-diagnostics globalTimers:off - The upstream fixture simulates dripping and stalled socket I/O.
import * as NodeHttp from "node:http";
type IncomingMessage = NodeHttp.IncomingMessage;
const { createServer, request: httpRequest } = NodeHttp;
import * as NodeNet from "node:net";
type AddressInfo = NodeNet.AddressInfo;
import * as NodeFSP from "node:fs/promises";
const { chmod, mkdtemp, readFile, rm, stat, writeFile } = NodeFSP;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const path = NodePath;
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
  readonly anonymousMarker: string | null;
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

interface CapturedUpgrade {
  readonly url: string;
  readonly authorization: string | null;
  readonly cookie: string | null;
}

interface Upstream {
  readonly port: number;
  readonly url: string;
  readonly wsUrl: string;
  readonly requests: CapturedRequest[];
  readonly wsMessages: CapturedWs[];
  readonly upgrades: string[];
  readonly upgradeRequests: CapturedUpgrade[];
  stallAborted: Promise<void>;
  close: () => Promise<void>;
}

async function startUpstream(
  binary: Buffer,
  script: "default" | "drip" | "stall" = "default",
): Promise<Upstream> {
  const requests: CapturedRequest[] = [];
  const wsMessages: CapturedWs[] = [];
  const upgrades: string[] = [];
  const upgradeRequests: CapturedUpgrade[] = [];
  let releaseSecondHalf = (): void => {};
  const secondHalf = new Promise<void>((resolve) => {
    releaseSecondHalf = resolve;
  });
  let markStallAborted = () => {};
  const stallAborted = new Promise<void>((resolve) => {
    markStallAborted = resolve;
  });
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
        anonymousMarker:
          typeof req.headers["x-max-anonymous"] === "string"
            ? req.headers["x-max-anonymous"]
            : null,
        body,
      });
      if (url === "/.well-known/t3/environment") {
        const payload = JSON.stringify({ environmentId: "stub-environment" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
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
        // Like T3: authenticated only when the companion injected the bearer.
        const payload = JSON.stringify({
          authenticated: typeof req.headers.authorization === "string",
        });
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
          if (!res.writableEnded) markStallAborted();
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
    const authorization =
      typeof req.headers.authorization === "string" ? req.headers.authorization : null;
    upgradeRequests.push({
      url: req.url ?? "/",
      authorization,
      cookie: typeof req.headers.cookie === "string" ? req.headers.cookie : null,
    });
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    // Like T3: with no wsTicket the upgrade must carry the bearer.
    if (!req.url.includes("wsTicket=") && authorization !== `Bearer ${TOKEN}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (req.url?.includes("terminate=1")) {
        // An abnormal drop, as when T3 restarts: no close frame, so the code is 1006.
        ws.send("upstream-hello", () => ws.terminate());
        return;
      }
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
    upgradeRequests,
    stallAborted,
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
  readonly webDist?: string | null;
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
    webDist: options?.webDist ?? null,
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
      env: {
        MAX_COUNCIL_DB: path.join(tokenDir, "council.sqlite"),
        MAX_TEMPLATES_DIR: path.join(tokenDir, "templates"),
      },
    });
    await companion.ready;
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
  return new Promise((resolve, reject) => {
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init?.body) req.end(init.body);
    else req.end();
  });
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
      const missing = await sendHttp(`${stack.gateway.url}/api/auth/clients`);
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
      const rejected = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${stack.gateway.port}/__max/tunnel`, {
          headers: { "x-max-tunnel-secret": "wrong-secret" },
        });
        ws.on("unexpected-response", (_req, res: IncomingMessage) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        ws.on("open", () => reject(new Error("wrong secret was accepted")));
        ws.on("error", () => {});
      });
      expect(rejected).toBe(401);
      const proxied = await sendHttp(`${stack.gateway.url}/api/auth/session`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(proxied.status).toBe(502);
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

  it("lets T3's bootstrap reach the Mini without a MAX session, and without the bearer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3mc-bootstrap-"));
    await writeFile(path.join(dir, "index.html"), "<html>MAX-SHELL</html>");
    const stack = await startStack({ webDist: dir });
    try {
      const session = await sendHttp(`${stack.gateway.url}/api/auth/session`);
      expect(session.status).toBe(200);
      expect(JSON.parse(session.body.toString("utf8"))).toEqual({ authenticated: false });
      const environment = await sendHttp(`${stack.gateway.url}/.well-known/t3/environment`);
      expect(environment.status).toBe(200);
      expect(environment.body.toString("utf8")).not.toContain("MAX-SHELL");
      expect(JSON.parse(environment.body.toString("utf8"))).toEqual({
        environmentId: "stub-environment",
      });
      expect(stack.upstream.requests.map((request) => request.url)).toEqual([
        "/api/auth/session",
        "/.well-known/t3/environment",
      ]);
      for (const request of stack.upstream.requests) {
        expect(request.authorization).toBeNull();
        expect(request.anonymousMarker).toBeNull();
        expect(request.cookie).toBeNull();
      }

      const ownerSession = await sendHttp(`${stack.gateway.url}/api/auth/session`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(JSON.parse(ownerSession.body.toString("utf8"))).toEqual({ authenticated: true });
      const ownerEnvironment = await sendHttp(`${stack.gateway.url}/.well-known/t3/environment`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(ownerEnvironment.status).toBe(200);
      for (const request of stack.upstream.requests.slice(2)) {
        expect(request.authorization).toBe(`Bearer ${TOKEN}`);
        expect(request.anonymousMarker).toBeNull();
      }

      // Only those two exact GETs are public; nearby paths still need the MAX session.
      const before = stack.upstream.requests.length;
      for (const [method, pathname] of [
        ["POST", "/api/auth/session"],
        ["GET", "/.well-known/t3/other"],
        ["GET", "/oauth/token"],
        ["POST", "/api/auth/websocket-ticket"],
      ] as const) {
        const refused = await sendHttp(`${stack.gateway.url}${pathname}`, { method });
        expect(refused.status, `${method} ${pathname}`).toBe(401);
        expect(refused.body.toString("utf8")).not.toContain("MAX-SHELL");
      }
      expect(stack.upstream.requests).toHaveLength(before);

      const shell = await sendHttp(`${stack.gateway.url}/`);
      expect(shell.status).toBe(200);
      expect(shell.body.toString("utf8")).toContain("MAX-SHELL");
    } finally {
      await stack.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never trusts an anonymous marker sent by the client", async () => {
    const stack = await startStack();
    try {
      const forged = await sendHttp(`${stack.gateway.url}/api/orchestration/shell`, {
        headers: { "x-max-anonymous": "1" },
      });
      expect(forged.status).toBe(401);
      expect(stack.upstream.requests).toHaveLength(0);

      await sendHttp(`${stack.gateway.url}/api/orchestration/shell`, {
        headers: ownerHeaders(stack.sessionToken, { "x-max-anonymous": "1" }),
      });
      const seen = stack.upstream.requests[0];
      expect(seen?.url).toBe("/api/orchestration/shell");
      expect(seen?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen?.anonymousMarker).toBeNull();

      // A forged marker on a public path changes nothing either: still anonymous, no bearer.
      const session = await sendHttp(`${stack.gateway.url}/api/auth/session`, {
        headers: { "x-max-anonymous": "0" },
      });
      expect(JSON.parse(session.body.toString("utf8"))).toEqual({ authenticated: false });
      expect(stack.upstream.requests[1]?.anonymousMarker).toBeNull();
    } finally {
      await stack.close();
    }
  });

  it("injects the scoped bearer into the upstream websocket handshake", async () => {
    const stack = await startStack();
    try {
      // The browser-primary shape: no wsTicket, only the session cookie and a protocol param.
      const client = new WebSocket(
        `ws://127.0.0.1:${stack.gateway.port}/ws?orchestrationProtocol=2`,
        { headers: ownerHeaders(stack.sessionToken, { authorization: "Bearer intruder" }) },
      );
      // The gateway accepts the client first, so wait for the upstream's own greeting.
      await new Promise<void>((resolve, reject) => {
        client.once("message", (data) => {
          if (asBuffer(data).toString("utf8") === "upstream-hello") resolve();
          else reject(new Error("unexpected first message"));
        });
        client.once("close", (code) => reject(new Error(`closed with ${code} before upstream`)));
        client.once("error", reject);
      });
      const ticketless = stack.upstream.upgradeRequests.find((request) =>
        request.url.startsWith("/ws?orchestrationProtocol=2"),
      );
      expect(ticketless?.url).toBe("/ws?orchestrationProtocol=2");
      expect(ticketless?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(ticketless?.cookie).toBeNull();
      // No close code arrives as 1005; the tunnel must survive it for the next socket.
      client.close();

      // A ticketed socket carries the bearer too, over the same tunnel.
      const ticketed = new WebSocket(`ws://127.0.0.1:${stack.gateway.port}/ws?wsTicket=ticket-2`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      await new Promise<void>((resolve, reject) => {
        ticketed.once("message", () => resolve());
        ticketed.once("close", (code) => reject(new Error(`closed with ${code}`)));
        ticketed.once("error", reject);
      });
      expect(
        stack.upstream.upgradeRequests.find((request) => request.url === "/ws?wsTicket=ticket-2")
          ?.authorization,
      ).toBe(`Bearer ${TOKEN}`);
      ticketed.close();
    } finally {
      await stack.close();
    }
  });

  it("survives an upstream socket that drops without a close frame", async () => {
    const stack = await startStack();
    try {
      const dropped = new WebSocket(
        `ws://127.0.0.1:${stack.gateway.port}/ws?wsTicket=ticket-3&terminate=1`,
        { headers: ownerHeaders(stack.sessionToken) },
      );
      const closeCode = await new Promise<number>((resolve, reject) => {
        dropped.once("close", (code) => resolve(code));
        dropped.once("error", reject);
      });
      expect(closeCode).toBe(1000);

      const next = new WebSocket(`ws://127.0.0.1:${stack.gateway.port}/ws?wsTicket=ticket-4`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      await new Promise<void>((resolve, reject) => {
        next.once("message", (data) => {
          if (asBuffer(data).toString("utf8") === "upstream-hello") resolve();
          else reject(new Error("unexpected first message"));
        });
        next.once("close", (code, reason) =>
          reject(new Error(`closed with ${code} ${reason.toString()}`)),
        );
        next.once("error", reject);
      });
      next.close(1000);
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
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });
      client.send("hello-text");
      client.send(Buffer.from([0, 1, 2, 255]));
      await waitForMessage(client, () => {
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
      });
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
      const response = await openGet(
        `${stack.gateway.url}/attachments/file.bin`,
        ownerHeaders(stack.sessionToken),
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      const first = await readSome(response, 1);
      expect(first.length).toBeGreaterThan(0);
      expect(first.length).toBeLessThan(binary.length);
      expect(binary.subarray(0, first.length).equals(first)).toBe(true);
      const release = await sendHttp(`${stack.upstream.url}/__test/release`);
      expect(release.status).toBe(200);
      const rest = await readRest(response, first);
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
    using deadlines = vi.spyOn(globalThis, "setTimeout");
    try {
      const response = await sendHttp(`${stack.gateway.url}/__test/stall`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(response.status).toBe(504);
      expect(response.body.toString("utf8")).toBe("gateway timeout\n");
      expect(deadlines.mock.calls.filter(([, delay]) => delay === 500)).toHaveLength(2);
      await stack.upstream.stallAborted;
    } finally {
      await stack.close();
    }
  });

  it("fails fast with 502 when no tunnel is connected", async () => {
    const stack = await startStack({ connect: false });
    try {
      const response = await sendHttp(`${stack.gateway.url}/api/auth/session`, {
        headers: ownerHeaders(stack.sessionToken),
      });
      expect(response.status).toBe(502);
      const upgrade = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${stack.gateway.port}/ws?wsTicket=ticket-1`, {
          headers: ownerHeaders(stack.sessionToken),
        });
        ws.on("unexpected-response", (_req, res: IncomingMessage) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        ws.on("open", () => reject(new Error("websocket opened without a tunnel")));
        ws.on("error", () => {});
      });
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
import * as NodeFS from "node:fs";
const { appendFileSync } = NodeFS;
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

function waitForMessage(client: WebSocket, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        client.off("message", check);
        client.off("error", reject);
        resolve();
      }
    };
    client.on("message", check);
    client.once("error", reject);
    check();
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

it("serves council only for the owner through the tunnel and never forwards it upstream", async () => {
  const stack = await startStack();
  try {
    const anonymous = await sendHttp(`${stack.gateway.url}/api/council/rounds`);
    expect(anonymous.status).toBe(401);
    const owner = await sendHttp(`${stack.gateway.url}/api/council/rounds`, {
      headers: ownerHeaders(stack.sessionToken),
    });
    expect(owner.status).toBe(200);
    expect(JSON.parse(owner.body.toString("utf8"))).toEqual({ rounds: [] });
    const unknown = await sendHttp(`${stack.gateway.url}/api/council/unknown`, {
      headers: ownerHeaders(stack.sessionToken),
    });
    expect(unknown.status).toBe(404);
    expect(stack.upstream.requests.filter((r) => r.url.startsWith("/api/council"))).toHaveLength(0);
  } finally {
    await stack.close();
  }
});
