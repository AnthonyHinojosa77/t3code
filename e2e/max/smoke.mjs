import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.default;
import * as NodeModule from "node:module";
const { createRequire } = NodeModule;
import * as NodeUtil from "node:util";
const { parseArgs } = NodeUtil;
const require = createRequire(new URL("../../packages/max-gateway/package.json", import.meta.url));
const { WebSocket } = require("ws");
const { values } = parseArgs({
  options: { url: { type: "string" }, "expect-commit": { type: "string" } },
  args: process.argv.slice(2).filter((x) => x !== "--"),
});
assert(values.url, "--url is required");
const base = new URL(values.url);
assert(["http:", "https:"].includes(base.protocol));
const rows = [];
async function check(name, run) {
  try {
    await run();
    rows.push({ check: name, result: "PASS" });
  } catch (error) {
    rows.push({ check: name, result: "FAIL", detail: error.message });
  }
}
async function get(path, type) {
  const res = await fetch(new URL(path, base), {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(res.status, 200, `${path}: HTTP ${res.status}`);
  if (type) assert.match(res.headers.get("content-type") ?? "", type, `${path}: content-type`);
  return res;
}
await check("health", async () =>
  assert.equal((await (await get("/__max/health", /application\/json/)).json()).ok, true),
);
await check("anonymous session", async () =>
  assert.equal(
    (await (await get("/api/auth/session", /application\/json/)).json()).authenticated,
    false,
  ),
);
await check("anonymous descriptor", async () => {
  const r = await fetch(new URL("/.well-known/t3/environment", base), {
    headers: { "x-max-anonymous": "1" },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  const d = await r.json();
  assert(d && typeof d === "object" && Object.keys(d).length > 0);
});
for (const path of ["/api/council/rounds", "/api/environment"])
  await check(`gated ${path}`, async () => {
    const r = await fetch(new URL(path, base), {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(r.status, 401);
  });
await check(
  "gated /ws upgrade",
  () =>
    new Promise((resolve, reject) => {
      const url = new URL("/ws", base);
      url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url, { handshakeTimeout: 20000 });
      ws.on("open", () => {
        ws.close();
        reject(new Error("Anonymous socket accepted"));
      });
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        ws.terminate();
        try {
          assert.equal(res.statusCode, 401);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      ws.on("error", reject);
    }),
);
await check("index and all referenced JS/CSS", async () => {
  const html = await (await get("/", /text\/html/)).text();
  assert.match(html, /<html/i);
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map(
    (m) => m[1],
  );
  assert(
    assets.some((x) => /\.js/.test(x)),
    "No entry JS found",
  );
  for (const asset of new Set(assets)) {
    assert.equal(new URL(asset, base).origin, base.origin, "Unexpected external asset");
    await get(asset, /\.css/.test(asset) ? /text\/css/ : /(?:javascript|ecmascript)/);
  }
});
await check("manifest and icons", async () => {
  const manifest = await (
    await get("/manifest.webmanifest", /(?:application\/manifest\+json|application\/json)/)
  ).json();
  assert.match(manifest.name, /MAX/i);
  assert.equal(manifest.display, "standalone");
  for (const key of ["theme_color", "background_color"])
    assert.match(manifest[key], /^#[\da-f]{3,8}$/i);
  assert(manifest.icons?.length);
  for (const icon of manifest.icons) await get(icon.src, /image\//);
});
if (values["expect-commit"])
  await check("deployment commit", async () =>
    assert.equal(
      (await (await get("/__max/version", /application\/json/)).json()).commit,
      values["expect-commit"],
    ),
  );
console.table(rows);
process.exitCode = rows.some((row) => row.result === "FAIL") ? 1 : 0;
