// @effect-diagnostics nodeBuiltinImport:off - Static files are read from the local web build directory.
import * as NodeFS from "node:fs";
const { existsSync, statSync } = NodeFS;
import * as NodeFSP from "node:fs/promises";
const { readFile } = NodeFSP;
import * as NodeHttp from "node:http";
type IncomingMessage = NodeHttp.IncomingMessage;
type ServerResponse = NodeHttp.ServerResponse;
import * as NodePath from "node:path";
const path = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;

/** `packages/max-gateway/src` → repo `apps/web/dist`. */
export function defaultWebDist(): string {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../apps/web/dist");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function contentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Resolved path inside `distDir`, or null when the path escapes the directory. */
export function resolveInsideDist(distDir: string, pathname: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const root = path.resolve(distDir);
  const relative = decoded.replace(/^\/+/, "");
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function isNavigationPath(pathname: string): boolean {
  const last = pathname.split("/").pop() ?? "";
  return !last.includes(".");
}

function sendFile(res: ServerResponse, method: string, body: Buffer, type: string): void {
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  res.end(method === "HEAD" ? undefined : body);
}

function sendMissing(res: ServerResponse): void {
  const body = "not found\n";
  res.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Serves `distDir` for GET and HEAD; a navigation path with no file falls back to `index.html`.
 * API, websocket, `/__max`, `/.well-known` and `/oauth` paths are left to the gateway.
 * Returns false when this request is not a static-app request.
 */
export async function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string | null,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  if (!distDir) return false;
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/") ||
    pathname === "/__max" ||
    pathname.startsWith("/__max/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/")
  ) {
    return false;
  }
  if (!existsSync(distDir)) return false;
  req.resume();
  const resolved = resolveInsideDist(distDir, pathname);
  if (!resolved) {
    sendMissing(res);
    return true;
  }
  let filePath: string | null = null;
  if (existsSync(resolved)) {
    const stat = statSync(resolved);
    if (stat.isFile()) filePath = resolved;
    else if (stat.isDirectory()) {
      const index = path.join(resolved, "index.html");
      if (existsSync(index)) filePath = index;
    }
  }
  if (!filePath && isNavigationPath(pathname)) {
    const index = path.join(path.resolve(distDir), "index.html");
    if (existsSync(index)) filePath = index;
  }
  if (!filePath) {
    sendMissing(res);
    return true;
  }
  const body = await readFile(filePath);
  sendFile(res, method, body, contentType(filePath));
  return true;
}
