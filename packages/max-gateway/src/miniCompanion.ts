// @effect-diagnostics nodeBuiltinImport:off - The companion forwards raw HTTP and WebSocket bytes to the local T3 server.
// @effect-diagnostics globalTimers:off - Reconnect backoff and heartbeats are socket timers.
// @effect-diagnostics globalDate:off - Heartbeat deadlines use wall-clock time.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
const http = NodeHttp;
import * as NodeHttps from "node:https";
const https = NodeHttps;
type IncomingMessage = NodeHttp.IncomingMessage;
type ClientRequest = NodeHttp.ClientRequest;
import * as NodeURL from "node:url";
const { pathToFileURL } = NodeURL;
import { WebSocket, type RawData } from "ws";

import { BearerTokenSource, type BearerTokenOptions } from "./bearerToken.ts";
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
  type WsCloseFrame,
  type WsOpenFrame,
} from "./protocol.ts";

import { CouncilStore } from "./council/councilStore.ts";
import { RoleTemplates } from "./council/roleTemplates.ts";
import { EngineClient } from "./council/engineClient.ts";
import { CouncilCoordinator } from "./council/councilCoordinator.ts";
import { councilRoute, COUNCIL_BODY_LIMIT } from "./council/councilRoutes.ts";

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

const DEFAULT_HTTP = "http://127.0.0.1:3773";
const DEFAULT_WS = "ws://127.0.0.1:3773";
const PING_INTERVAL_MS = 15_000;
const PONG_DEADLINE_MS = 45_000;

export function tunnelWebSocketUrl(gateway: string): string {
  const url = new URL(gateway);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.pathname !== "/__max/tunnel") {
    url.pathname = "/__max/tunnel";
    url.search = "";
    url.hash = "";
  }
  return url.toString();
}

export interface MiniCompanionOptions {
  readonly gatewayUrl: string;
  readonly tunnelSecret: string;
  readonly upstreamHttpBase?: string;
  readonly upstreamWsBase?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly reconnect?: boolean;
  readonly token?: BearerTokenOptions;
  readonly council?: CouncilCoordinator;
}

export interface RunningMiniCompanion {
  readonly ready: Promise<void>;
  close: () => Promise<void>;
}

interface HeaderMap {
  readonly [name: string]: string | readonly string[];
}

interface LiveHttp {
  readonly kind: "http";
  req: ClientRequest | null;
  ended: boolean;
  readonly chunks: Buffer[];
}

interface LiveWs {
  readonly kind: "ws";
  socket: WebSocket | null;
  readonly pending: Array<{ data: Buffer; binary: boolean }>;
  open: boolean;
}

interface LiveCouncil {
  readonly kind: "council";
  readonly request: HttpRequestFrame;
  readonly chunks: Buffer[];
  size: number;
}
type LiveStream = LiveHttp | LiveWs | LiveCouncil;

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function upstreamHttpUrl(base: string, pathAndQuery: string): URL {
  const url = new URL(base);
  const incoming = new URL(pathAndQuery, "http://placeholder");
  url.pathname = incoming.pathname;
  url.search = incoming.search;
  return url;
}

function upstreamWsUrl(base: string, pathAndQuery: string): string {
  const url = new URL(base);
  const incoming = new URL(pathAndQuery, "http://placeholder");
  url.pathname = incoming.pathname;
  url.search = incoming.search;
  return url.toString();
}

/** A null token forwards the request with no Authorization, as T3 sees an anonymous visitor. */
function upstreamHeaders(
  headers: HeaderMap,
  host: string,
  token: string | null,
): NodeHttp.OutgoingHttpHeaders {
  const out: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower === "cookie" ||
      lower === "authorization" ||
      lower === ANONYMOUS_REQUEST_HEADER
    ) {
      continue;
    }
    out[lower] = typeof value === "string" ? value : [...value];
  }
  out.host = host;
  if (token !== null) out.authorization = `Bearer ${token}`;
  return out;
}

function isAnonymousRequest(headers: HeaderMap): boolean {
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === ANONYMOUS_REQUEST_HEADER && value === "1",
  );
}

export function startMiniCompanion(options: MiniCompanionOptions): RunningMiniCompanion {
  if (options.tunnelSecret.length === 0) {
    throw new Error("MAX_TUNNEL_SECRET is required");
  }
  const reconnect = options.reconnect ?? true;
  const httpBase = options.upstreamHttpBase ?? process.env.T3_UPSTREAM_HTTP ?? DEFAULT_HTTP;
  const wsBase = options.upstreamWsBase ?? process.env.T3_UPSTREAM_WS ?? DEFAULT_WS;
  const tokens = new BearerTokenSource(options.token);
  tokens.startRenewalLoop();
  let ownedStore: CouncilStore | undefined;
  let council = options.council;
  const getCouncil = () => {
    if (!council) {
      const env = options.env ?? process.env;
      ownedStore = new CouncilStore(env.MAX_COUNCIL_DB);
      council = new CouncilCoordinator(
        ownedStore,
        new RoleTemplates(env.MAX_TEMPLATES_DIR),
        new EngineClient(tokens, wsBase),
        Number(env.MAX_COUNCIL_CONTENDER_TIMEOUT_MS ?? 900000),
      );
      council.resume();
    }
    return council;
  };
  getCouncil();
  const streams = new Map<number, LiveStream>();
  let stopped = false;
  let generation = 0;
  let socket: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let lastPong = 0;
  let attempt = 0;
  let readySettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function send(streamId: number, type: number, payload: Buffer): void {
    const current = socket;
    if (!current || current.readyState !== WebSocket.OPEN) return;
    sendFrames((frame) => current.send(frame), streamId, type, payload);
  }

  function failStream(streamId: number): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    if (stream.kind === "http") stream.req?.destroy();
    else if (stream.kind === "ws") stream.socket?.close(1011, "tunnel closed");
  }

  function failAllStreams(): void {
    for (const streamId of streams.keys()) failStream(streamId);
  }

  function scheduleReconnect(): void {
    if (stopped || !reconnect) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  function onFrame(frame: { streamId: number; type: number; payload: Buffer }): void {
    if (frame.streamId === 0) {
      if (frame.type === FrameType.ping) send(0, FrameType.pong, Buffer.alloc(0));
      if (frame.type === FrameType.pong) lastPong = Date.now();
      return;
    }
    if (frame.type === FrameType.httpRequest) {
      const request = parseJsonPayload<HttpRequestFrame>(frame.payload);
      if (new URL(request.path, "http://localhost").pathname.startsWith("/api/council")) {
        streams.set(frame.streamId, { kind: "council", request, chunks: [], size: 0 });
      } else openHttp(frame.streamId, request);
      return;
    }
    if (frame.type === FrameType.httpRequestChunk) {
      const stream = streams.get(frame.streamId);
      if (stream?.kind === "council") {
        stream.size += frame.payload.length;
        if (stream.size > COUNCIL_BODY_LIMIT) {
          replyCouncil(frame.streamId, {
            status: 400,
            body: { error: "Request body exceeds 256 KB" },
          });
        } else stream.chunks.push(frame.payload);
        return;
      }
      if (stream?.kind !== "http") return;
      if (stream.req) stream.req.write(frame.payload);
      else stream.chunks.push(frame.payload);
      return;
    }
    if (frame.type === FrameType.httpRequestEnd) {
      const stream = streams.get(frame.streamId);
      if (stream?.kind === "council") {
        replyCouncil(
          frame.streamId,
          isAnonymousRequest(stream.request.headers)
            ? { status: 401, body: { error: "Owner authentication required" } }
            : councilRoute(
                getCouncil(),
                stream.request.method,
                stream.request.path,
                Buffer.concat(stream.chunks),
              ),
        );
        return;
      }
      if (stream?.kind !== "http" || stream.ended) return;
      stream.ended = true;
      stream.req?.end();
      return;
    }
    if (frame.type === FrameType.httpAbort) {
      failStream(frame.streamId);
      return;
    }
    if (frame.type === FrameType.wsOpen) {
      openWs(frame.streamId, parseJsonPayload<WsOpenFrame>(frame.payload));
      return;
    }
    if (frame.type === FrameType.wsMessage) {
      const stream = streams.get(frame.streamId);
      if (stream?.kind !== "ws") return;
      const message = decodeWsMessage(frame.payload);
      if (!stream.open || !stream.socket) {
        stream.pending.push(message);
        return;
      }
      stream.socket.send(message.data, { binary: message.binary });
      return;
    }
    if (frame.type === FrameType.wsClose) {
      const stream = streams.get(frame.streamId);
      const close = parseJsonPayload<WsCloseFrame>(frame.payload);
      streams.delete(frame.streamId);
      if (stream?.kind === "ws") stream.socket?.close(sendableCloseCode(close.code), close.reason);
    }
  }

  function replyCouncil(streamId: number, result: { status: number; body?: unknown }) {
    streams.delete(streamId);
    send(
      streamId,
      FrameType.httpResponseHead,
      jsonBuffer({
        status: result.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    if (result.body !== undefined)
      send(streamId, FrameType.httpResponseChunk, jsonBuffer(result.body));
    send(streamId, FrameType.httpResponseEnd, Buffer.alloc(0));
  }

  function openHttp(streamId: number, request: HttpRequestFrame): void {
    const stream: LiveHttp = { kind: "http", req: null, ended: false, chunks: [] };
    streams.set(streamId, stream);
    void finishHttp(streamId, stream, request);
  }

  async function finishHttp(
    streamId: number,
    stream: LiveHttp,
    request: HttpRequestFrame,
  ): Promise<void> {
    // The gateway marks T3's public bootstrap from a visitor with no MAX session.
    let token: string | null = null;
    if (!isAnonymousRequest(request.headers)) {
      try {
        token = await tokens.getToken();
      } catch {
        streams.delete(streamId);
        send(streamId, FrameType.streamError, jsonBuffer({ message: "bearer token unavailable" }));
        return;
      }
    }
    if (streams.get(streamId) !== stream) return;
    const target = upstreamHttpUrl(httpBase, request.path);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: upstreamHeaders(request.headers, target.host, token),
    });
    req.on("response", (res: IncomingMessage) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        headers[name] = value;
      }
      const head: HttpResponseHeadFrame = { status: res.statusCode ?? 502, headers };
      send(streamId, FrameType.httpResponseHead, jsonBuffer(head));
      res.on("data", (chunk: Buffer) => {
        send(streamId, FrameType.httpResponseChunk, chunk);
      });
      res.on("end", () => {
        streams.delete(streamId);
        send(streamId, FrameType.httpResponseEnd, Buffer.alloc(0));
      });
      res.on("error", () => {
        streams.delete(streamId);
        send(streamId, FrameType.streamError, jsonBuffer({ message: "upstream unavailable" }));
      });
    });
    req.on("error", () => {
      streams.delete(streamId);
      send(streamId, FrameType.streamError, jsonBuffer({ message: "upstream unavailable" }));
    });
    stream.req = req;
    for (const chunk of stream.chunks) req.write(chunk);
    stream.chunks.length = 0;
    if (stream.ended) req.end();
  }

  function openWs(streamId: number, request: WsOpenFrame): void {
    const stream: LiveWs = { kind: "ws", socket: null, pending: [], open: false };
    streams.set(streamId, stream);
    void finishWs(streamId, stream, request);
  }

  async function finishWs(streamId: number, stream: LiveWs, request: WsOpenFrame): Promise<void> {
    // Sockets are never public bootstrap, so the upgrade always carries the bearer. The
    // browser's primary socket has no wsTicket, and T3 then authenticates the bearer header.
    let token: string;
    try {
      token = await tokens.getToken();
    } catch {
      if (streams.get(streamId) !== stream) return;
      streams.delete(streamId);
      send(streamId, FrameType.wsOpenResult, jsonBuffer({ ok: false }));
      return;
    }
    if (streams.get(streamId) !== stream) return;
    const wsOptions = {
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024,
      headers: { authorization: `Bearer ${token}` },
    } as const;
    const upstream =
      request.protocols.length > 0
        ? new WebSocket(upstreamWsUrl(wsBase, request.path), [...request.protocols], wsOptions)
        : new WebSocket(upstreamWsUrl(wsBase, request.path), wsOptions);
    stream.socket = upstream;
    upstream.on("open", () => {
      stream.open = true;
      send(
        streamId,
        FrameType.wsOpenResult,
        jsonBuffer({ ok: true, ...(upstream.protocol ? { protocol: upstream.protocol } : {}) }),
      );
      for (const message of stream.pending) upstream.send(message.data, { binary: message.binary });
      stream.pending.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      send(streamId, FrameType.wsMessage, encodeWsMessage(asBuffer(data), isBinary));
    });
    upstream.on("close", (code, reason) => {
      if (streams.get(streamId) !== stream) return;
      streams.delete(streamId);
      send(streamId, FrameType.wsClose, jsonBuffer({ code, reason: reason.toString("utf8") }));
    });
    upstream.on("unexpected-response", () => {
      streams.delete(streamId);
      send(streamId, FrameType.wsOpenResult, jsonBuffer({ ok: false }));
      upstream.terminate();
    });
    upstream.on("error", () => {
      if (stream.open) return;
      if (streams.get(streamId) !== stream) return;
      streams.delete(streamId);
      send(streamId, FrameType.wsOpenResult, jsonBuffer({ ok: false }));
    });
  }

  function connect(): void {
    if (stopped) return;
    const gen = ++generation;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const ws = new WebSocket(tunnelWebSocketUrl(options.gatewayUrl), {
      headers: { "x-max-tunnel-secret": options.tunnelSecret },
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024,
    });
    socket = ws;
    const decoder = new FrameDecoder();
    let disconnected = false;
    const disconnect = () => {
      if (stopped || gen !== generation || disconnected) return;
      disconnected = true;
      if (heartbeat) clearInterval(heartbeat);
      if (socket === ws) socket = null;
      failAllStreams();
      if (!readySettled && !reconnect) {
        readySettled = true;
        rejectReady(new Error("tunnel connection failed"));
      }
      scheduleReconnect();
    };
    ws.on("open", () => {
      if (gen !== generation) {
        ws.close(4000, "replaced");
        return;
      }
      attempt = 0;
      lastPong = Date.now();
      if (!readySettled) {
        readySettled = true;
        resolveReady();
      }
      heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPong > PONG_DEADLINE_MS) {
          ws.terminate();
          return;
        }
        send(0, FrameType.ping, Buffer.alloc(0));
      }, PING_INTERVAL_MS);
      heartbeat.unref?.();
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary || gen !== generation) return;
      lastPong = Date.now();
      try {
        decoder.push(asBuffer(data), onFrame);
      } catch {
        ws.close(1002, "bad frame");
      }
    });
    ws.on("close", disconnect);
    ws.on("error", () => {
      // `close` follows `error` for a failed handshake. Disconnect once there.
    });
    ws.on("unexpected-response", () => {
      disconnect();
      ws.terminate();
    });
  }

  connect();

  return {
    ready,
    close: async () => {
      stopped = true;
      generation += 1;
      tokens.stop();
      council?.close();
      ownedStore?.close();
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      failAllStreams();
      const current = socket;
      socket = null;
      if (current) {
        await new Promise<void>((resolve) => {
          current.once("close", () => resolve());
          current.close(1000, "shutdown");
          setTimeout(() => {
            current.terminate();
            resolve();
          }, 500).unref?.();
        });
      }
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("companion closed"));
      }
    },
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(NodeFS.realpathSync(entry)).href;
}

if (isDirectRun()) {
  const gatewayUrl = process.env.MAX_GATEWAY_URL ?? process.env.MAX_TUNNEL_URL;
  const tunnelSecret = process.env.MAX_TUNNEL_SECRET;
  if (!tunnelSecret) {
    process.stderr.write("MAX_TUNNEL_SECRET is required\n");
    process.exit(1);
  }
  if (!gatewayUrl) {
    process.stderr.write("MAX_GATEWAY_URL is required\n");
    process.exit(1);
  }
  const companion = startMiniCompanion({ gatewayUrl, tunnelSecret });
  void companion.ready.then(
    () => {
      process.stderr.write("max companion tunnel connected\n");
    },
    () => {
      process.stderr.write("max companion tunnel failed\n");
      process.exit(1);
    },
  );
  const shutdown = () => {
    void companion.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
