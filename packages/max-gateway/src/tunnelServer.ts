// @effect-diagnostics nodeBuiltinImport:off - The gateway is a raw HTTP and WebSocket multiplexer, not an Effect HTTP client.
// @effect-diagnostics globalTimers:off - Idle deadlines are socket timers so a stalled stream cannot hang a request.
import * as NodeCrypto from "node:crypto";
const { timingSafeEqual } = NodeCrypto;
import * as NodeHttp from "node:http";
type IncomingMessage = NodeHttp.IncomingMessage;
type Server = NodeHttp.Server;
type ServerResponse = NodeHttp.ServerResponse;
const { createServer } = NodeHttp;
import * as NodeStream from "node:stream";
type Duplex = NodeStream.Duplex;
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { isMaxAuthRoute } from "./auth/http.ts";
import type { AuthStore } from "./auth/store.ts";
import { handleOwnedHttp } from "./ownedRoutes.ts";
import type { OwnerRequestCheck } from "./ownerAuth.ts";
import { tryServeStatic } from "./staticApp.ts";
import {
  ANONYMOUS_REQUEST_HEADER,
  FrameDecoder,
  FrameType,
  decodeWsMessage,
  encodeWsMessage,
  jsonBuffer,
  parseJsonPayload,
  sendFrames,
  sendableCloseCode,
  type HttpRequestFrame,
  type HttpResponseHeadFrame,
  type StreamErrorFrame,
  type WsCloseFrame,
  type WsOpenResultFrame,
} from "./protocol.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Default idle limit for one proxied HTTP stream. Activity resets this clock. */
const IDLE_TIMEOUT_MS = 60_000;
const UPGRADE_TIMEOUT_MS = 15_000;

export type GatewayPathKind = "health" | "version" | "tunnel" | "owned" | "proxy";

/**
 * `owned` paths are answered by the gateway; `proxy` paths go to the Mini behind the owner
 * check. Under `/api/auth/` only MAX's exact endpoints are owned; the rest is T3's
 * environment auth API and is proxied. WebSocket upgrades classify as GET.
 */
export function classifyPath(pathname: string, method = "GET"): GatewayPathKind {
  if (pathname === "/__max/health") return "health";
  if (pathname === "/__max/version") return "version";
  if (pathname === "/__max/tunnel") return "tunnel";
  if (
    pathname === "/__max" ||
    pathname.startsWith("/__max/") ||
    isMaxAuthRoute(method, pathname) ||
    pathname === "/api/billing" ||
    pathname.startsWith("/api/billing/")
  ) {
    return "owned";
  }
  return "proxy";
}

export interface TunnelServerOptions {
  readonly tunnelSecret: string;
  readonly isOwnerRequest: OwnerRequestCheck;
  readonly host?: string;
  readonly port?: number;
  /** HTTP idle deadline resets on request data or response head/chunk/end.
   * Expires with 504 and httpAbort; defaults to 60000, overriding responseTimeoutMs.
   * WebSocket upgrades use the separate, non-resetting upgradeTimeoutMs. */
  readonly idleTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly upgradeTimeoutMs?: number;
  /** Account database. Auth routes 404 when this is missing. */
  readonly authStore?: AuthStore | null;
  /** Defaults to true so a forgotten flag stays locked to the owner. */
  readonly personalMode?: boolean;
  readonly ownerEmail?: string | null;
  /**
   * Built web app directory. Null or omitted keeps the Task 0 behavior:
   * page loads are proxied, and nothing is read from `apps/web/dist`.
   */
  readonly webDist?: string | null;
  /**
   * Env used for the session cookie Secure flag. Omitted means `process.env`.
   * Tests pass a plain object so they do not edit the process environment.
   */
  readonly cookieEnv?: NodeJS.ProcessEnv;
  /** Deployment identity; null for an unlabelled local build. */
  readonly commit?: string | null;
}

export interface RunningTunnelServer {
  readonly port: number;
  readonly url: string;
  close: () => Promise<void>;
}

interface HeaderMap {
  readonly [name: string]: string | readonly string[];
}

interface BufferedHead {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
}

interface HttpStream {
  readonly kind: "http";
  readonly res: ServerResponse;
  /** True only after the status line has been written to the phone. */
  headSent: boolean;
  /**
   * Response head received from the tunnel. Held until the first body chunk
   * or the end frame so a head followed by silence can still return 504.
   * Holding it is what makes the idle timeout observable; the first chunk
   * flushes it, so a live body is not buffered.
   */
  bufferedHead: BufferedHead | null;
  readonly pendingChunks: Buffer[];
  timeout: NodeJS.Timeout | undefined;
}

interface WsStream {
  readonly kind: "ws";
  client: WebSocket | null;
  upstreamReady: boolean;
  readonly pendingToUpstream: Array<{ data: Buffer; binary: boolean }>;
  readonly pendingToClient: Array<{ data: Buffer; binary: boolean }>;
  timeout: NodeJS.Timeout;
}

type LiveStream = HttpStream | WsStream;

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || expected.length === 0) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

/** The marker is always dropped from the client; only `anonymous` sets it. */
function copyRequestHeaders(req: IncomingMessage, anonymous = false): HeaderMap {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === ANONYMOUS_REQUEST_HEADER) continue;
    headers[name] = value;
  }
  if (anonymous) headers[ANONYMOUS_REQUEST_HEADER] = "1";
  return headers;
}

/**
 * T3's bootstrap reads these before anyone can sign in to MAX. They return metadata and
 * `authenticated:false` to a caller without the bearer, so they need no MAX session.
 */
export function isPublicBootstrapRequest(method: string, pathname: string): boolean {
  return (
    method === "GET" &&
    (pathname === "/api/auth/session" || pathname === "/.well-known/t3/environment")
  );
}

function writeHttp(socket: Duplex, status: number, body: string): void {
  const payload = Buffer.from(body);
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 502 ? "Bad Gateway" : "Error"}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${payload.length}\r\n\r\n`,
  );
  socket.end(payload);
}

function sendPlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}

export async function startTunnelServer(
  options: TunnelServerOptions,
): Promise<RunningTunnelServer> {
  if (options.tunnelSecret.length === 0) {
    throw new Error("MAX_TUNNEL_SECRET is required");
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? options.responseTimeoutMs ?? IDLE_TIMEOUT_MS;
  const upgradeTimeoutMs = options.upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS;
  const streams = new Map<number, LiveStream>();
  let nextStreamId = 1;
  let tunnel: WebSocket | null = null;

  const httpServer: Server = createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) sendPlain(res, 500, "gateway error\n");
      else res.destroy();
    });
  });
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
  });

  function allocateStreamId(): number {
    const id = nextStreamId;
    nextStreamId = nextStreamId >= 0xffffffff ? 1 : nextStreamId + 1;
    return id;
  }

  function tunnelOpen(): boolean {
    return tunnel !== null && tunnel.readyState === WebSocket.OPEN;
  }

  function send(streamId: number, type: number, payload: Buffer): void {
    const socket = tunnel;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("tunnel is not connected");
    }
    sendFrames((frame) => socket.send(frame), streamId, type, payload);
  }

  function dropStream(streamId: number, stream: LiveStream): void {
    clearTimeout(stream.timeout);
    if (streams.get(streamId) === stream) streams.delete(streamId);
  }

  function armHttpIdle(streamId: number, stream: HttpStream): void {
    clearTimeout(stream.timeout);
    stream.timeout = setTimeout(() => {
      if (streams.get(streamId) !== stream) return;
      try {
        send(streamId, FrameType.httpAbort, Buffer.alloc(0));
      } catch {
        // The tunnel is already gone; the response is failed below.
      }
      failHttp(streamId, stream, 504);
    }, idleTimeoutMs).unref();
  }

  function noteHttpActivity(streamId: number, stream: HttpStream): void {
    if (streams.get(streamId) !== stream) return;
    armHttpIdle(streamId, stream);
  }

  function flushHttpHead(stream: HttpStream): void {
    if (stream.headSent || !stream.bufferedHead) return;
    stream.res.writeHead(stream.bufferedHead.status, stream.bufferedHead.headers);
    stream.headSent = true;
    for (const chunk of stream.pendingChunks) stream.res.write(chunk);
    stream.pendingChunks.length = 0;
  }

  function failHttp(streamId: number, stream: HttpStream, status: number): void {
    dropStream(streamId, stream);
    if (!stream.res.headersSent)
      sendPlain(stream.res, status, status === 504 ? "gateway timeout\n" : "bad gateway\n");
    else stream.res.destroy();
  }

  function failTunnel(socket: WebSocket): void {
    if (tunnel !== socket) return;
    tunnel = null;
    for (const [streamId, stream] of streams) {
      if (stream.kind === "http") failHttp(streamId, stream, 502);
      else {
        dropStream(streamId, stream);
        stream.client?.close(1011, "tunnel closed");
      }
    }
  }

  function onTunnelFrame(frame: { streamId: number; type: number; payload: Buffer }): void {
    if (frame.streamId === 0) {
      if (frame.type === FrameType.ping && tunnelOpen()) send(0, FrameType.pong, Buffer.alloc(0));
      return;
    }
    const stream = streams.get(frame.streamId);
    if (!stream) return;
    if (stream.kind === "http") {
      onHttpFrame(frame.streamId, stream, frame.type, frame.payload);
      return;
    }
    onWsFrame(frame.streamId, stream, frame.type, frame.payload);
  }

  function onHttpFrame(streamId: number, stream: HttpStream, type: number, payload: Buffer): void {
    if (type === FrameType.httpResponseHead) {
      if (stream.bufferedHead || stream.headSent) return;
      const head = parseJsonPayload<HttpResponseHeadFrame>(payload);
      stream.bufferedHead = { status: head.status, headers: sanitizeResponseHeaders(head.headers) };
      noteHttpActivity(streamId, stream);
      if (stream.pendingChunks.length > 0) flushHttpHead(stream);
      return;
    }
    if (type === FrameType.httpResponseChunk) {
      noteHttpActivity(streamId, stream);
      if (!stream.bufferedHead && !stream.headSent) {
        stream.pendingChunks.push(payload);
        return;
      }
      flushHttpHead(stream);
      stream.res.write(payload);
      return;
    }
    if (type === FrameType.httpResponseEnd) {
      noteHttpActivity(streamId, stream);
      if (!stream.bufferedHead && !stream.headSent) {
        dropStream(streamId, stream);
        sendPlain(stream.res, 502, "bad gateway\n");
        return;
      }
      flushHttpHead(stream);
      dropStream(streamId, stream);
      stream.res.end();
      return;
    }
    if (type === FrameType.streamError) {
      failHttp(streamId, stream, 502);
    }
  }

  function onWsFrame(streamId: number, stream: WsStream, type: number, payload: Buffer): void {
    if (type === FrameType.wsOpenResult) {
      const result = parseJsonPayload<WsOpenResultFrame>(payload);
      clearTimeout(stream.timeout);
      if (!result.ok || !stream.client) {
        dropStream(streamId, stream);
        stream.client?.close(1011, "upstream rejected");
        return;
      }
      stream.upstreamReady = true;
      for (const message of stream.pendingToUpstream) {
        send(streamId, FrameType.wsMessage, encodeWsMessage(message.data, message.binary));
      }
      stream.pendingToUpstream.length = 0;
      return;
    }
    if (type === FrameType.wsMessage) {
      const message = decodeWsMessage(payload);
      if (!stream.client) {
        stream.pendingToClient.push(message);
        return;
      }
      stream.client.send(message.data, { binary: message.binary });
      return;
    }
    if (type === FrameType.wsClose) {
      const close = parseJsonPayload<WsCloseFrame>(payload);
      dropStream(streamId, stream);
      stream.client?.close(sendableCloseCode(close.code), close.reason);
      return;
    }
    if (type === FrameType.streamError) {
      const error = parseJsonPayload<StreamErrorFrame>(payload);
      dropStream(streamId, stream);
      stream.client?.close(1011, error.message.slice(0, 80));
    }
  }

  function acceptTunnel(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const provided = headerValue(req.headers["x-max-tunnel-secret"]);
    if (!secretMatches(provided, options.tunnelSecret)) {
      writeHttp(socket, 401, "unauthorized\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (tunnel && tunnel !== ws) tunnel.close(4000, "replaced");
      tunnel = ws;
      const localDecoder = new FrameDecoder();
      ws.on("message", (data, isBinary) => {
        if (tunnel !== ws || !isBinary) return;
        try {
          localDecoder.push(asBuffer(data), onTunnelFrame);
        } catch {
          ws.close(1002, "bad frame");
        }
      });
      ws.on("close", () => failTunnel(ws));
      ws.on("error", () => {
        ws.close();
      });
    });
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const kind = classifyPath(url.pathname, req.method ?? "GET");
    if (kind === "health" || kind === "version") {
      req.resume();
      const body = `${JSON.stringify(kind === "health" ? { ok: true } : { commit: options.commit ?? null })}\n`;
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const personalMode = options.personalMode ?? true;
    try {
      const served = await tryServeStatic(req, res, options.webDist ?? null, url.pathname);
      if (served) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "static file error";
      process.stderr.write(`static file error: ${message}\n`);
      if (!res.headersSent) sendPlain(res, 500, "static file error\n");
      return;
    }
    const providerLocked =
      personalMode &&
      (url.pathname === "/api/providers" || url.pathname.startsWith("/api/providers/"));
    if (kind !== "proxy" || providerLocked) {
      try {
        const handled = await handleOwnedHttp(req, res, url, {
          authStore: options.authStore ?? null,
          personalMode,
          ownerEmail: options.ownerEmail ?? null,
          cookieEnv: options.cookieEnv ?? process.env,
        });
        if (!handled) {
          req.resume();
          sendPlain(res, 404, "not found\n");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "internal error";
        process.stderr.write(`owned route error: ${message}\n`);
        if (!res.headersSent) {
          req.resume();
          sendPlain(res, 500, "internal error\n");
        }
      }
      return;
    }
    const anonymous = !(await options.isOwnerRequest(req));
    if (anonymous && !isPublicBootstrapRequest(req.method ?? "GET", url.pathname)) {
      req.resume();
      sendPlain(res, 401, "unauthorized\n");
      return;
    }
    if (!tunnelOpen()) {
      req.resume();
      sendPlain(res, 502, "bad gateway\n");
      return;
    }
    const streamId = allocateStreamId();
    const stream: HttpStream = {
      kind: "http",
      res,
      headSent: false,
      bufferedHead: null,
      pendingChunks: [],
      timeout: undefined,
    };
    streams.set(streamId, stream);
    armHttpIdle(streamId, stream);
    const requestFrame: HttpRequestFrame = {
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: copyRequestHeaders(req, anonymous),
    };
    try {
      send(streamId, FrameType.httpRequest, jsonBuffer(requestFrame));
    } catch {
      failHttp(streamId, stream, 502);
      return;
    }
    req.on("data", (chunk: Buffer) => {
      if (streams.get(streamId) !== stream) return;
      noteHttpActivity(streamId, stream);
      try {
        send(streamId, FrameType.httpRequestChunk, chunk);
      } catch {
        failHttp(streamId, stream, 502);
      }
    });
    req.on("end", () => {
      if (!streams.has(streamId)) return;
      try {
        send(streamId, FrameType.httpRequestEnd, Buffer.alloc(0));
      } catch {
        failHttp(streamId, stream, 502);
      }
    });
    req.on("error", () => failHttp(streamId, stream, 502));
    res.on("close", () => {
      if (res.writableEnded || !streams.has(streamId)) return;
      try {
        send(streamId, FrameType.httpAbort, Buffer.alloc(0));
      } catch {
        // Ignore a tunnel that closed first.
      }
      dropStream(streamId, stream);
    });
  }

  function handleClientUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void (async () => {
      if (classifyPath(url.pathname, req.method ?? "GET") !== "proxy") {
        writeHttp(socket, 404, "not found\n");
        return;
      }
      if (!(await options.isOwnerRequest(req))) {
        writeHttp(socket, 401, "unauthorized\n");
        return;
      }
      if (!tunnelOpen()) {
        writeHttp(socket, 502, "bad gateway\n");
        return;
      }
      const streamId = allocateStreamId();
      const protocols =
        headerValue(req.headers["sec-websocket-protocol"])
          ?.split(",")
          .map((protocol) => protocol.trim())
          .filter((protocol) => protocol.length > 0) ?? [];
      const stream: WsStream = {
        kind: "ws",
        client: null,
        upstreamReady: false,
        pendingToUpstream: [],
        pendingToClient: [],
        timeout: setTimeout(() => {
          dropStream(streamId, stream);
          stream.client?.close(1011, "upstream timeout");
          try {
            send(streamId, FrameType.httpAbort, Buffer.alloc(0));
          } catch {
            // Tunnel already closed.
          }
        }, upgradeTimeoutMs).unref(),
      };
      streams.set(streamId, stream);
      let upgraded = false;
      sockets.handleUpgrade(req, socket, head, (client) => {
        upgraded = true;
        stream.client = client;
        for (const message of stream.pendingToClient) {
          client.send(message.data, { binary: message.binary });
        }
        stream.pendingToClient.length = 0;
        client.on("message", (data, isBinary) => {
          const payload = asBuffer(data);
          if (!stream.upstreamReady) {
            stream.pendingToUpstream.push({ data: payload, binary: isBinary });
            return;
          }
          try {
            send(streamId, FrameType.wsMessage, encodeWsMessage(payload, isBinary));
          } catch {
            client.close(1011, "tunnel closed");
          }
        });
        client.on("close", (code, reason) => {
          if (!streams.has(streamId)) return;
          try {
            send(
              streamId,
              FrameType.wsClose,
              jsonBuffer({ code, reason: reason.toString("utf8") } satisfies WsCloseFrame),
            );
          } catch {
            // Tunnel already closed.
          }
          dropStream(streamId, stream);
        });
      });
      try {
        send(
          streamId,
          FrameType.wsOpen,
          jsonBuffer({
            path: `${url.pathname}${url.search}`,
            headers: copyRequestHeaders(req),
            protocols,
          }),
        );
      } catch {
        dropStream(streamId, stream);
        if (!upgraded) writeHttp(socket, 502, "bad gateway\n");
        else stream.client?.close(1011, "tunnel closed");
      }
    })().catch(() => {
      if (!socket.destroyed) writeHttp(socket, 500, "gateway error\n");
    });
  }

  httpServer.on("upgrade", (req, socket, head) => {
    // An anonymous client may reset after rejection; its socket must not crash the gateway.
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (classifyPath(url.pathname) === "tunnel") {
      acceptTunnel(req, socket, head);
      return;
    }
    handleClientUpgrade(req, socket, head);
  });

  const host = options.host ?? "127.0.0.1";
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      const address = httpServer.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("gateway failed to listen"));
    });
  });

  return {
    port,
    url: `http://${host}:${port}`,
    close: async () => {
      tunnel?.close(1000, "shutdown");
      tunnel = null;
      for (const [streamId, stream] of streams) {
        if (stream.kind === "http") failHttp(streamId, stream, 502);
        else {
          dropStream(streamId, stream);
          stream.client?.close(1001, "shutdown");
        }
      }
      sockets.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

function sanitizeResponseHeaders(headers: HeaderMap): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[lower] = typeof value === "string" ? value : [...value];
  }
  return out;
}
