import { visualGates } from "./visualGates.mjs";
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.default;
import * as NodeChildProcess from "node:child_process";
const { spawn } = NodeChildProcess;
import * as NodeCrypto from "node:crypto";
const { randomBytes } = NodeCrypto;
import * as NodeEvents from "node:events";
const { once } = NodeEvents;
import * as NodeFSP from "node:fs/promises";
const { mkdir, mkdtemp, readFile, rm, writeFile } = NodeFSP;
import * as NodeModule from "node:module";
const { createRequire } = NodeModule;
import * as NodeNet from "node:net";
const { createServer } = NodeNet;
import * as NodeOS from "node:os";
const { homedir, tmpdir } = NodeOS;
import * as NodePath from "node:path";
const path = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;
import * as NodeSqlite from "node:sqlite";
const { DatabaseSync } = NodeSqlite;
import { EngineClient } from "../../packages/max-gateway/src/council/engineClient.ts";
import { CouncilStore } from "../../packages/max-gateway/src/council/councilStore.ts";
import { RoleTemplates } from "../../packages/max-gateway/src/council/roleTemplates.ts";
import { COMPANION_SCOPES } from "../../packages/max-gateway/src/bearerToken.ts";
import { buildSeededRound, SEEDED_PAGE_TITLES } from "./seedRound.mjs";

const researchRound = process.argv.includes("--research-round");
const lightScheme = process.argv.includes("--light");
const noRound = process.argv.includes("--no-round");
const desktop = process.argv.includes("--desktop");
const evidenceArg = process.argv.indexOf("--evidence");
const evidenceDir = evidenceArg >= 0 ? path.resolve(process.argv[evidenceArg + 1]) : null;
// Device profile: phones get touch and a 3x scale; the computer profile is a 1440x900 window with
// a mouse, a trackpad wheel and a keyboard. Both use the same build and the same seeded round.
const viewport = desktop
  ? { width: 1440, height: 900 }
  : noRound
    ? { width: 360, height: 780 }
    : { width: 390, height: 844 };
const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium, expect } = require("playwright/test");
// By default a full acceptance run covers both OS appearances; only the dark
// pass spends a real round. Explicit scheme flags support no-round iteration.
if (
  !process.argv.includes("--single-scheme") &&
  !process.argv.includes("--light") &&
  !process.argv.includes("--no-round") &&
  !desktop
) {
  for (const flags of [
    ["--single-scheme"],
    ["--single-scheme", "--light", "--no-round", "--skip-build"],
    ["--single-scheme", "--desktop", "--no-round", "--skip-build"],
    ["--single-scheme", "--desktop", "--light", "--no-round", "--skip-build"],
  ]) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2), ...flags],
      { stdio: "inherit" },
    );
    const [code] = await once(child, "close");
    if (code !== 0) process.exit(code ?? 1);
  }
  process.exit(0);
}
const dir = await mkdtemp(path.join(tmpdir(), "t3mc-e2e-"));
const artifacts = path.join(
  root,
  "artifacts/e2e-max",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(artifacts, { recursive: true });
const runLabel = `${lightScheme ? "light" : "dark"}-${desktop ? "desktop" : "phone"}-${viewport.width}x${viewport.height}`;
const summary = {
  colorScheme: lightScheme ? "light" : "dark",
  device: desktop ? "computer" : "phone",
  status: "running",
  viewport: `${viewport.width}x${viewport.height}@${desktop ? 2 : 3}`,
  steps: [],
  pageTurns: [],
  attachmentUploads: [],
  seededRound: null,
  gates: [],
  longTasks: [],
  usage: [],
  threadsCreated: [],
  realRounds: 0,
  researchRound,
  observedRoundStates: [],
  cleanup: {},
  cancelledAtLogout: [],
  cancelledAtReload: [],
};
const errors = [],
  network = [],
  consoleLog = [],
  children = new Set();
let loggingOut = false;
let reloading = false;
const activeRequests = new Set();
const startedDuringLogout = new WeakSet();
const providerEvidence = new Map();
function collectProviders(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.providers))
    for (const provider of value.providers) {
      if (provider.instanceId)
        providerEvidence.set(provider.instanceId, {
          instanceId: provider.instanceId,
          name: provider.displayName ?? provider.driver,
          windows: provider.usageLimits?.windows ?? [],
          provider,
        });
    }
  for (const nested of Object.values(value))
    if (nested && typeof nested === "object") collectProviders(nested);
}
const secrets = [];
const redact = (value) =>
  secrets
    .reduce((s, secret) => s.replaceAll(secret, "[REDACTED]"), String(value))
    .replace(/(https?:\/\/|wss?:\/\/)([^\s'"?]+)\?[^\s'"]*/g, "$1$2?[REDACTED]");
// Explicit environment prevents live MAX/railway credentials and URLs leaking into the test stack.
const env = Object.fromEntries(
  ["PATH", "HOME", "COREPACK_HOME", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR", "SYSTEMROOT"]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
const t3 = path.join(homedir(), ".t3/bin/t3");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone process supervisor selects POSIX process-group shutdown outside an Effect runtime.
const isWindows = NodeOS.platform() === "win32";
let sessionId,
  browser,
  page,
  stopping = false,
  engine,
  roundId;
function start(command, args, extra = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  if (args.some((arg) => /(?:start|miniCompanion)\.ts$/.test(arg))) {
    child.stderr.on("data", (chunk) =>
      consoleLog.push({ process: path.basename(args[0]), text: redact(chunk) }),
    );
    child.once("exit", (code, signal) =>
      consoleLog.push({ process: path.basename(args[0]), code, signal }),
    );
  }
  return child;
}
async function run(command, args, extra = {}, sensitive = false) {
  const child = start(command, args, extra);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => {
    stdout += x;
  });
  child.stderr.on("data", (x) => {
    stderr += x;
  });
  const deadline = setTimeout(
    () => {
      void stopChild(child);
    },
    sensitive ? 30000 : 300000,
  );
  const [code] = await once(child, "close").finally(() => clearTimeout(deadline));
  if (code !== 0)
    throw new Error(
      `${path.basename(command)} failed (${code})${sensitive ? "" : `: ${redact(stderr).slice(-4000)}`}`,
    );
  return stdout;
}
async function ready(child, marker) {
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${marker}`)), 30000);
    child.stderr.on("data", (chunk) => {
      output += chunk;
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Startup failed (${code}): ${redact(output)}`));
    });
    child.once("error", reject);
  });
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (isWindows) child.kill("SIGTERM");
  else process.kill(-child.pid, "SIGTERM");
  const timer = setTimeout(() => {
    if (isWindows) child.kill("SIGKILL");
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }, 5000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}
async function cleanup() {
  if (stopping) return;
  stopping = true;
  if (browser) {
    try {
      await browser.close();
    } catch {
      errors.push("Browser cleanup failed");
    }
  }
  const stopped = await Promise.allSettled([...children].map(stopChild));
  if (stopped.some((result) => result.status === "rejected"))
    errors.push("Child process cleanup failed");
  summary.cleanup.processesStopped = children.size === 0;
  if (engine) {
    // Read only our temporary store after the companion stops: logout cannot hide
    // a late-created synthesis thread from teardown.
    if (roundId) {
      const db = new DatabaseSync(path.join(dir, "council.sqlite"), { readOnly: true });
      try {
        const row = db.prepare("SELECT body FROM rounds WHERE id=?").get(roundId);
        const round = JSON.parse(row.body);
        const states = [...round.contenders, round.synthesis].filter((s) => s.threadId);
        summary.threadsCreated = [...new Set(states.map((s) => s.threadId))];
        for (const state of states)
          if (["pending", "running", "needs-attention"].includes(state.status))
            await engine.interrupt(state.threadId);
      } catch {
        errors.push("Could not collect or stop final round threads");
      } finally {
        db.close();
      }
    }
    summary.cleanup.threadsArchived = [];
    for (const id of summary.threadsCreated) {
      try {
        await engine.archive(id);
        summary.cleanup.threadsArchived.push(id);
      } catch {
        errors.push("Failed to archive test thread " + id);
      }
    }
    engine.close();
  }
  if (sessionId) {
    try {
      await run(t3, ["auth", "session", "revoke", sessionId], {}, true);
      summary.cleanup.sessionRevoked = true;
    } catch {
      summary.cleanup.sessionRevoked = false;
      errors.push("Failed to revoke the test session");
    }
  }
  await rm(dir, { recursive: true, force: true });
  summary.cleanup.tempRemoved = true;
}
async function copyEvidence() {
  if (!evidenceDir) return;
  const target = path.join(evidenceDir, runLabel);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await NodeFSP.cp(artifacts, target, { recursive: true });
  const videoDir = path.join(artifacts, "video");
  try {
    for (const file of await NodeFSP.readdir(videoDir))
      await NodeFSP.rename(
        path.join(videoDir, file),
        path.join(target, `page-turns-${runLabel}.webm`),
      );
  } catch {
    /* No video was recorded in this run. */
  }
  summary.evidence = target;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
// A rejected promise nobody awaited must still stop the processes this run owns.
process.on("unhandledRejection", (reason) => {
  errors.push("Unhandled rejection: " + redact(reason instanceof Error ? reason.stack : reason));
  void cleanup().finally(() => process.exit(1));
});
function safeUrl(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}
async function gates(name) {
  // Measure settled UI, not a fade's initial transparent frame. Infinite status
  // pulses are deliberately left running.
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  const result = await page.evaluate(
    (minimumTarget) => {
      const visible = (el) =>
        el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
      const titles = [...document.querySelectorAll(".max-wordmark,h1")].filter(
        (el) => visible(el) && el.textContent.trim() === "MAX",
      );
      const primary = [
        ...document.querySelectorAll(
          'button[type="submit"], [aria-label="Mode"] button, button[aria-label="Choose models"], button[aria-label="Choose contender models"], button[aria-label="Choose synthesizer model"], button[aria-label="Back to Council"], button[aria-label="Send to council"], .max-button, .max-council-button, .max-icon-button:not(.max-icon-button-small), .max-model-button, .max-council-models button, .max-scope select, .max-panel-new, .max-panel-item, .max-panel-footer-button',
        ),
      ].filter(visible);
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        truncatedTitles: titles.filter((el) => el.scrollWidth > el.clientWidth).length,
        smallTargets: primary
          .map((el) => ({
            label: el.getAttribute("aria-label") || el.textContent.trim(),
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
          }))
          // Touch needs 40 CSS px; the computer profile measures T3's own 28 px header controls
          // against a pointer-precision floor instead.
          .filter((x) => x.width < minimumTarget || x.height < minimumTarget),
      };
    },
    desktop ? 28 : 40,
  );
  const visual = await page.evaluate(visualGates);
  summary.gates.push({ step: name, ...result, ...visual });
}
async function step(name, fn) {
  const row = { name, status: "running", startedAt: new Date().toISOString() };
  summary.steps.push(row);
  const start = performance.now();
  console.log(`STEP ${name}`);
  try {
    await fn();
    row.status = "pass";
  } catch (error) {
    row.status = "fail";
    row.error = redact(error.message);
    throw error;
  } finally {
    if (page && !page.isClosed()) await gates(name);
    row.durationMs = Math.round(performance.now() - start);
    row.screenshot = path.join(
      artifacts,
      `${String(summary.steps.length).padStart(2, "0")}-${name}.png`,
    );
    if (page && !page.isClosed()) await page.screenshot({ path: row.screenshot, fullPage: true });
  }
}
async function reloadPage() {
  await page.waitForLoadState("networkidle");
  reloading = true;
  try {
    await page.reload();
    await page.waitForLoadState("networkidle");
  } finally {
    reloading = false;
  }
}

async function home() {
  await expect(page.getByText("MAX", { exact: true }).first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("textbox", { name: "Question for the council" })).toBeVisible({
    timeout: 60000,
  });
  await expect(page.getByRole("button", { name: "Choose models", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send to council", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Ask the council.", exact: true })).toBeVisible();
  await expect(
    page.getByText(/Unable to connect|Something went wrong|Connection failed/i),
  ).toHaveCount(0);
}
const modelWindow = () => page.getByRole("dialog", { name: "Models", exact: true });
async function openModelWindow() {
  if (await modelWindow().isVisible()) return;
  await page.getByRole("button", { name: "Choose models", exact: true }).click();
  await expect(modelWindow()).toBeVisible();
}
async function closeModelWindow() {
  await modelWindow().getByRole("button", { name: "Close", exact: true }).click();
  await expect(modelWindow()).toHaveCount(0);
}
const panel = () => page.getByRole("navigation", { name: "Past conversations" });
/** Phones keep the side panel in a drawer; computers dock it. */
async function openPanel() {
  if (!(await panel().isVisible())) {
    await page.getByRole("button", { name: "Toggle main sidebar" }).first().click();
    await expect(panel()).toBeVisible();
  }
}
async function closePanelIfDrawer() {
  if (viewport.width < 768 || (await page.evaluate(() => innerWidth)) < 768) {
    await page.keyboard.press("Escape");
    await expect(panel()).toBeHidden();
  }
}
const pages = () => page.getByRole("region", { name: "Council answers", exact: true });
const position = () => page.locator("[data-page-position]");
const frontPage = () => page.locator('[data-max-page][data-position="current"]');
async function pageOrder() {
  return page.locator("[data-max-page]").evaluateAll((els) => els.map((el) => el.dataset.pageId));
}
async function frontTitle() {
  return (await frontPage().locator(".max-page-title").textContent()).trim();
}
let cdp;
/** A real finger: CDP touch points through Chromium's gesture recognizer, not synthetic pointer events. */
async function swipe(direction) {
  // Diagnostic: which pointer events the stack actually received from the touch sequence.
  await page.evaluate(() => {
    const root = document.querySelector(".max-pages");
    window.__maxPointer = { down: 0, move: 0, up: 0, cancel: 0, touchstart: 0, touchmove: 0 };
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
      root.addEventListener(type, () => window.__maxPointer[type.slice(7)]++, { once: false });
    for (const type of ["touchstart", "touchmove"])
      root.addEventListener(type, () => window.__maxPointer[type]++, { passive: true });
  });
  const box = await pages().boundingBox();
  const y = box.y + box.height * 0.45;
  const from = box.x + box.width * (direction === "left" ? 0.85 : 0.15);
  const to = box.x + box.width * (direction === "left" ? 0.15 : 0.85);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from + ((to - from) * i) / steps, y }],
    });
    await page.waitForTimeout(12);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  summary.pointerTrace = await page.evaluate(() => window.__maxPointer);
}
async function dragWithMouse(direction) {
  const box = await pages().boundingBox();
  const y = box.y + box.height * 0.45;
  const from = box.x + box.width * (direction === "left" ? 0.85 : 0.15);
  const to = box.x + box.width * (direction === "left" ? 0.15 : 0.85);
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(from + (to - from) * 0.5, y, { steps: 8 });
  await page.mouse.move(to, y, { steps: 8 });
  await page.mouse.up();
}
/** Frame times while one page turns. Long frames here are the jank the owner called "jagged". */
async function measureTurn(name, turn) {
  await page.evaluate(() => {
    window.__maxFrames = [];
    let last = performance.now();
    const start = last;
    const tick = (t) => {
      window.__maxFrames.push(t - last);
      last = t;
      if (t - start < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await turn();
  await page.waitForTimeout(950);
  const frames = (await page.evaluate(() => window.__maxFrames)).slice(1);
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const longest = sorted.at(-1) ?? 0;
  const over34 = frames.filter((f) => f > 34).length;
  const row = {
    name,
    frames: frames.length,
    longestMs: +longest.toFixed(1),
    p95Ms: +p95.toFixed(1),
    over34,
    pass: longest <= 80 && over34 <= 2,
  };
  summary.pageTurns.push(row);
  return row;
}
async function expectPosition(text) {
  await expect(position()).toHaveText(text);
}
async function restoreScheme() {
  // Each run keeps its own appearance from here on; a toggle test must put it back.
  await page.evaluate(
    (mode) => localStorage.setItem("t3code:theme-appearance-mode", mode),
    lightScheme ? "light" : "dark",
  );
}
try {
  assert(
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "Set PLAYWRIGHT_BROWSERS_PATH to existing installed browsers (no download)",
  );
  if (!process.argv.includes("--skip-build"))
    await run("corepack", ["pnpm", "--filter", "@t3tools/web", "build"], {
      T3CODE_SINGLE_ORIGIN_DEV: "1",
    });
  await readFile(path.join(root, "apps/web/dist/index.html"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`,
    secret = randomBytes(32).toString("hex");
  secrets.push(secret);
  const common = {
    MAX_TUNNEL_SECRET: secret,
    MAX_DB_PATH: path.join(dir, "auth.sqlite"),
    MAX_COUNCIL_DB: path.join(dir, "council.sqlite"),
    MAX_TEMPLATES_DIR: path.join(dir, "templates"),
    MAX_COMPANION_TOKEN_PATH: path.join(dir, "companion.json"),
    MAX_COMPANION_TOKEN_TTL: "1h",
    OWNER_EMAIL: "owner@example.com",
    MAX_PERSONAL_MODE: "true",
    NODE_ENV: "development",
  };
  const gateway = start(process.execPath, ["packages/max-gateway/src/start.ts"], {
    ...common,
    PORT: String(port),
    HOST: "127.0.0.1",
    MAX_WEB_DIST: path.join(root, "apps/web/dist"),
  });
  await ready(gateway, "max-gateway listening");
  const issued = JSON.parse(
    await run(
      t3,
      [
        "auth",
        "session",
        "issue",
        "--ttl",
        "1h",
        "--label",
        `max-e2e-${path.basename(dir)}`,
        "--json",
        ...COMPANION_SCOPES.flatMap((scope) => ["--scope", scope]),
      ],
      {},
      true,
    ),
  );
  sessionId = issued.sessionId;
  engine = new EngineClient({ getToken: async () => issued.token });
  const config = await engine.rpc("server.getConfig", {});
  summary.advertisedRuntimeModes = config.providers.map((provider) => ({
    instanceId: provider.instanceId,
    modes: provider.supportedRuntimeModes ?? [],
  }));
  secrets.push(issued.token);
  assert(sessionId && issued.token, "CLI did not return session and token");
  await writeFile(
    common.MAX_COMPANION_TOKEN_PATH,
    JSON.stringify({
      token: issued.token,
      expiresAtMs: Date.parse(issued.expiresAt),
      ttl: "1h",
      scopes: issued.scopes,
    }),
    { mode: 0o600 },
  );
  {
    // Saved before the companion opens the same database; closed so the WAL hands over cleanly.
    const seededId = `seed-${randomBytes(4).toString("hex")}`;
    const store = new CouncilStore(common.MAX_COUNCIL_DB);
    const templates = new RoleTemplates(common.MAX_TEMPLATES_DIR);
    const seeded = buildSeededRound(seededId, Date.now() - 10 * 60000);
    store.save(seeded, templates.get("meta-debate"));
    store.close();
    summary.seededRound = { id: seededId, prompt: seeded.prompt };
  }
  const companion = start(process.execPath, ["packages/max-gateway/src/miniCompanion.ts"], {
    ...common,
    MAX_GATEWAY_URL: base,
    MAX_COMPANION_BEARER_TOKEN: issued.token,
    T3_BIN: t3,
  });
  await ready(companion, "max companion tunnel connected");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    colorScheme: summary.colorScheme,
    deviceScaleFactor: desktop ? 2 : 3,
    isMobile: !desktop,
    hasTouch: !desktop,
    ...(evidenceDir ? { recordVideo: { dir: path.join(artifacts, "video"), size: viewport } } : {}),
  });
  await context.exposeBinding("recordLongTask", (_source, duration) =>
    summary.longTasks.push(duration),
  );
  await context.addInitScript(() => {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.duration > 200) window.recordLongTask(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  cdp = await context.newCDPSession(page);
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin === base && req.method() === "POST" && /attachment|upload/i.test(u.pathname))
      summary.attachmentUploads.push({ path: u.pathname, step: summary.steps.at(-1)?.name });
  });
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      try {
        collectProviders(JSON.parse(typeof payload === "string" ? payload : payload.toString()));
      } catch {
        /* Non-JSON frames carry no provider evidence. */
      }
    }),
  );
  page.on("pageerror", (e) => errors.push(redact(e.message)));
  page.on("console", (msg) => {
    const location = msg.location();
    // Chromium logs expected anonymous /me 401 as a console error; no other console errors are exempt.
    const expected =
      msg.type() === "error" &&
      /Failed to load resource.*401/.test(msg.text()) &&
      location.url === `${base}/api/auth/me`;
    consoleLog.push({
      type: msg.type(),
      text: redact(msg.text()),
      url: location.url ? safeUrl(location.url) : "",
      expected,
    });
    if (msg.type() === "error" && !expected) errors.push(redact(msg.text()));
  });
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (
      u.origin === base &&
      res.status() >= 400 &&
      !(res.status() === 401 && u.pathname === "/api/auth/me")
    )
      network.push({ path: u.pathname, status: res.status() });
  });
  page.on("requestfinished", (req) => activeRequests.delete(req));
  page.on("request", (req) => {
    activeRequests.add(req);
    if (!loggingOut) return;
    startedDuringLogout.add(req);
    const url = new URL(req.url());
    if (
      url.origin === base &&
      url.pathname.startsWith("/api/") &&
      !["/api/auth/logout", "/api/auth/me"].includes(url.pathname)
    ) {
      network.push({
        path: url.pathname,
        failure: "Authenticated request started after logout began",
      });
    }
  });
  page.on("requestfailed", (req) => {
    activeRequests.delete(req);
    // A request active before, or started during, a deliberate reload is cancelled by that reload.
    if (reloading && req.failure()?.errorText === "net::ERR_ABORTED") {
      summary.cancelledAtReload.push(new URL(req.url()).pathname);
      return;
    }
    if (
      loggingOut &&
      !startedDuringLogout.has(req) &&
      req.failure()?.errorText === "net::ERR_ABORTED"
    ) {
      summary.cancelledAtLogout.push(new URL(req.url()).pathname);
      return;
    }
    if (stopping) return; // Closing our browser intentionally aborts outstanding reads.
    if (new URL(req.url()).origin === base)
      network.push({
        path: new URL(req.url()).pathname,
        step: summary.steps.at(-1)?.name,
        failure: req.failure()?.errorText,
      });
  });
  const anonymousTraffic = [];
  const recordAnonymous = (req) => {
    const u = new URL(req.url());
    if (
      u.origin === base &&
      (u.pathname === "/ws" || (u.pathname.startsWith("/api/") && u.pathname !== "/api/auth/me"))
    )
      anonymousTraffic.push(u.pathname);
  };
  page.on("request", recordAnonymous);
  page.on("websocket", (socket) => {
    if (
      !summary.steps.some((s) => s.name === "register") &&
      new URL(socket.url()).pathname === "/ws"
    )
      anonymousTraffic.push("/ws");
  });
  await step("login-page", async () => {
    await page.goto(base);
    await expect(page.getByRole("button", { name: "SIGN IN", exact: true })).toBeVisible();
  });
  assert.deepEqual(anonymousTraffic, [], "Authenticated traffic before MAX login");
  page.off("request", recordAnonymous);
  await step("register", async () => {
    await page.getByRole("button", { name: "NEED AN ACCOUNT? CREATE ONE" }).click();
    await page.getByLabel("EMAIL", { exact: true }).fill("owner@example.com");
    await page.getByLabel("PASSWORD", { exact: true }).fill("local-e2e-password");
    await page.getByLabel("CONFIRM PASSWORD", { exact: true }).fill("local-e2e-password");
    await page.getByRole("button", { name: "CREATE ACCOUNT", exact: true }).click();
    await home();
  });
  await step("logout-after-register", async () => {
    loggingOut = true;
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.getByRole("button", { name: "Sign out", exact: true }).click(),
    ]);
    await expect(page.getByRole("button", { name: "SIGN IN", exact: true })).toBeVisible();
    loggingOut = false;
  });
  await step("login-and-bootstrap", async () => {
    await page.getByLabel("EMAIL", { exact: true }).fill("owner@example.com");
    await page.getByLabel("PASSWORD", { exact: true }).fill("local-e2e-password");
    await page.getByRole("button", { name: "SIGN IN", exact: true }).click();
    await home();
  });
  await step("theme-toggle-persists", async () => {
    // Old MAX's light mode: a real light palette, remembered across reloads. A light run stays
    // light for every later gate; a dark run toggles there and back.
    const toggle = (name) => page.getByRole("button", { name, exact: true }).first();
    await toggle("Switch to light mode").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(toggle("Switch to dark mode")).toBeVisible();
    await reloadPage();
    await home();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    assert.equal(
      await page.locator(".max-window").evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(192, 192, 192)",
      "Light mode must render old MAX's chrome-gray surface",
    );
    await gates("light-home");
    await page.screenshot({ path: path.join(artifacts, "theme-light-home.png"), fullPage: true });
    if (!lightScheme) {
      await toggle("Switch to dark mode").click();
      await expect(page.locator("html")).toHaveClass(/dark/);
      await reloadPage();
      await home();
      await expect(page.locator("html")).toHaveClass(/dark/);
    }
  });
  await step("model-window", async () => {
    await openModelWindow();
    await expect(modelWindow().getByRole("heading", { name: "Contenders" })).toBeVisible();
    await expect(modelWindow().getByRole("heading", { name: "Synthesizer" })).toBeVisible();
    await expect(modelWindow().getByLabel("Project folder")).toBeVisible();
    await expect(modelWindow().getByLabel("Template")).toBeVisible();
  });
  await step("contender-picker", async () => {
    await modelWindow()
      .getByRole("button", { name: "Choose contender models", exact: true })
      .click();
    await expect(page.getByPlaceholder("Search models...")).toBeVisible();
  });
  await step("two-contenders", async () => {
    const options = page.getByRole("option").filter({ visible: true });
    await expect(options.first()).toBeVisible();
    assert((await options.count()) >= 2, "Need two real model options");
    const candidates = [...providerEvidence.values()]
      .flatMap(({ provider }) =>
        provider.models
          .filter((m) =>
            (researchRound
              ? /claude-sonnet-5-5|claude-haiku-5-5|gpt-6-luna/
              : /haiku|gpt-6-luna/i
            ).test(m.slug),
          )
          .map((m) => ({ provider, model: m })),
      )
      .filter(({ provider }) => provider.status === "ready");
    candidates.sort(
      (a, b) =>
        Number(
          !(researchRound ? /claude-sonnet-5-5|gpt-6-luna/ : /claude-haiku-5-5|gpt-6-luna/).test(
            a.model.slug,
          ),
        ) -
        Number(
          !(researchRound ? /claude-sonnet-5-5|gpt-6-luna/ : /claude-haiku-5-5|gpt-6-luna/).test(
            b.model.slug,
          ),
        ),
    );
    const selected = candidates
      .filter(
        (c, i, all) =>
          all.findIndex(
            (x) => x.provider.instanceId === c.provider.instanceId && x.model.slug === c.model.slug,
          ) === i,
      )
      .slice(0, 2);
    assert.equal(selected.length, 2, "Need two cheap ready engine models (Haiku or GPT-6 Luna)");
    summary.models = selected.map(({ provider, model }) => ({
      instanceId: provider.instanceId,
      model: model.slug,
      name: model.name,
    }));
    for (const { provider, model } of selected) {
      await page.getByPlaceholder("Search models...").fill("");
      await page.locator('[data-model-picker-provider="' + provider.instanceId + '"]').click();
      await page.getByPlaceholder("Search models...").fill(model.name);
      await page.getByRole("option").filter({ visible: true }).first().click();
    }
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("list", { name: "Contenders", exact: true }).getByRole("listitem"),
    ).toHaveCount(2);
  });
  await step("synthesizer", async () => {
    await modelWindow()
      .getByRole("button", { name: "Choose synthesizer model", exact: true })
      .click();
    const selected = researchRound
      ? [...providerEvidence.values()].flatMap(({ provider }) =>
          provider.status === "ready"
            ? provider.models
                .filter((m) => m.slug === "claude-haiku-5-5")
                .map((m) => ({ instanceId: provider.instanceId, name: m.name }))
            : [],
        )[0]
      : summary.models[0];
    assert(selected, "Need a ready Claude Haiku synthesizer");
    await page.locator('[data-model-picker-provider="' + selected.instanceId + '"]').click();
    await page.getByPlaceholder("Search models...").fill(selected.name);
    await page.getByRole("option").filter({ visible: true }).first().click();
    await expect(page.getByText(/^Synthesizer:/)).toBeVisible();
    summary.synthesizerDisplayName = (await page.getByText(/^Synthesizer:/).textContent())
      .replace(/^Synthesizer:\s*/, "")
      .trim();
  });
  await step("low-effort", async () => {
    await openModelWindow();
    const scopes = [
      ...(await page
        .getByRole("list", { name: "Contenders", exact: true })
        .getByRole("listitem")
        .all()),
      modelWindow()
        .locator("section")
        .filter({
          has: page.getByRole("button", { name: "Choose synthesizer model", exact: true }),
        }),
    ];
    for (const scope of scopes) {
      const traits = scope
        .getByRole("button")
        .filter({ hasText: /Low|Medium|High|Default|Effort/i });
      if (!(await traits.count())) continue;
      await traits.first().click();
      const low = page.getByRole("menuitemradio").filter({ hasText: /^Low/ }).first();
      await expect(page.getByRole("menu")).toBeVisible();
      await low.click();
      // Choosing closes the menu; an extra Escape would close the model window around it.
      if (await page.getByRole("menu").count()) await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  });
  await step("traits-menu", async () => {
    await openModelWindow();
    const traits = page
      .getByRole("list", { name: "Contenders", exact: true })
      .getByRole("button")
      .filter({ hasText: /Low|Medium|High|Default|Effort/i })
      .first();
    await traits.click();
    await expect(page.getByRole("menu")).toBeVisible();
  });
  await page.keyboard.press("Escape");
  await step("manage-templates", async () => {
    await openModelWindow();
    await modelWindow().getByRole("button", { name: "Manage templates", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Manage templates" })).toBeVisible();
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Manage templates" })).toHaveCount(0);
  await step("provider-usage", async () => {
    await openModelWindow();
    await modelWindow()
      .getByRole("button", { name: "Choose contender models", exact: true })
      .click();
    const providers = page.getByRole("toolbar", { name: "Providers" }).getByRole("button");
    assert((await providers.count()) > 0, "No providers in picker");
    for (let i = 0; i < (await providers.count()); i++) {
      const button = providers.nth(i);
      if (await button.isDisabled()) continue;
      const name = await button.getAttribute("aria-label");
      if (name === "Favorites") continue;
      await button.click();
      const instanceId = await button.evaluate((el) =>
        el.closest("[data-model-picker-provider]").getAttribute("data-model-picker-provider"),
      );
      const evidence = providerEvidence.get(instanceId);
      assert(evidence, `No engine snapshot received for ${name}`);
      const usage = page.locator('section[aria-label$=" usage limits"]');
      if (evidence.windows.length) {
        await expect(usage).toBeVisible();
        await expect(usage.getByText(/% left/)).toHaveCount(evidence.windows.length);
        for (const window of evidence.windows)
          await expect(usage.getByText(window.label, { exact: true })).toBeVisible();
        summary.usage.push({ provider: name, status: "pass", windows: evidence.windows.length });
      } else
        summary.usage.push({
          provider: name,
          status: "skip",
          reason: "Engine snapshot reports zero usage windows",
        });
    }
    await page.keyboard.press("Escape");
  });
  await step("model-window-closes", async () => {
    await closeModelWindow();
    await expect(page.getByRole("button", { name: "Choose models", exact: true })).toHaveText(
      /2 models · judge set/,
    );
  });
  await step("seeded-round-from-panel", async () => {
    await openPanel();
    await panel().getByRole("button", { name: summary.seededRound.prompt }).click();
    await expect(page).toHaveURL(new RegExp("[?&]round=" + summary.seededRound.id));
    await closePanelIfDrawer();
    await expect(pages()).toBeVisible();
    await expectPosition("1 of 4");
    assert.deepEqual(await pageOrder(), ["c1", "c0", "c2", "synthesis"]);
    assert.equal(await frontTitle(), SEEDED_PAGE_TITLES[0], "First finisher must be in front");
    await expect(frontPage().locator(".max-council-status")).toHaveText("complete");
    await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await page.screenshot({ path: path.join(artifacts, "seeded-front-page.png"), fullPage: true });
  });
  await step(desktop ? "turn-by-mouse-drag" : "turn-by-touch", async () => {
    const turn = desktop ? dragWithMouse : swipe;
    const first = await measureTurn(desktop ? "mouse-drag-forward" : "touch-swipe-forward", () =>
      turn("left"),
    );
    await expectPosition("2 of 4");
    assert.equal(await frontTitle(), SEEDED_PAGE_TITLES[1]);
    await measureTurn(desktop ? "mouse-drag-back" : "touch-swipe-back", () => turn("right"));
    await expectPosition("1 of 4");
    assert(first.frames > 20, "Frame sampler saw too few frames during the turn");
  });
  await step("turn-by-keyboard-to-synthesis", async () => {
    await pages().focus();
    await measureTurn("keyboard-forward", () => page.keyboard.press("ArrowRight"));
    await expectPosition("2 of 4");
    await page.keyboard.press("ArrowRight");
    await expectPosition("3 of 4");
    assert.equal(
      await frontTitle(),
      SEEDED_PAGE_TITLES[2],
      "Failed model page sits after the answers",
    );
    await expect(frontPage().getByText("Provider unavailable")).toBeVisible();
    await expect(frontPage().locator(".max-council-status")).toHaveText("failed");
    await gates("seeded-failed-page");
    await page.keyboard.press("ArrowRight");
    await expectPosition("4 of 4");
    assert.equal(await frontTitle(), SEEDED_PAGE_TITLES[3], "Synthesis is always the last page");
    await expect(frontPage().getByRole("heading", { name: "Verdict", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" }).last()).toBeDisabled();
    await gates("seeded-synthesis-page");
    await page.screenshot({
      path: path.join(artifacts, "seeded-synthesis-page.png"),
      fullPage: true,
    });
    await page.keyboard.press("Home");
    await expectPosition("1 of 4");
  });
  await step("turn-by-buttons-and-edge", async () => {
    await page.getByRole("button", { name: "Next page" }).last().click();
    await expectPosition("2 of 4");
    await page.getByRole("button", { name: "Previous page" }).click();
    await expectPosition("1 of 4");
    await page.locator(".max-page-edge").click();
    await expectPosition("2 of 4");
    await page.getByRole("button", { name: "Previous page" }).click();
    await expectPosition("1 of 4");
  });
  await step("page-keeps-own-scroll", async () => {
    const body = frontPage().locator(".max-page-body");
    await body.evaluate((el) => {
      el.scrollTop = 120;
    });
    const before = await body.evaluate((el) => el.scrollTop);
    assert(before > 0, "Seeded answer must be long enough to scroll");
    await page.getByRole("button", { name: "Next page" }).last().click();
    await expectPosition("2 of 4");
    await page.getByRole("button", { name: "Previous page" }).click();
    await expectPosition("1 of 4");
    assert.equal(
      await body.evaluate((el) => el.scrollTop),
      before,
      "Scroll position must survive a turn",
    );
  });
  await step("seeded-order-after-reload", async () => {
    await reloadPage();
    await expect(pages()).toBeVisible();
    await expectPosition("1 of 4");
    assert.deepEqual(await pageOrder(), ["c1", "c0", "c2", "synthesis"]);
    assert.equal(await frontTitle(), SEEDED_PAGE_TITLES[0]);
    // The models chosen before the reload are still chosen.
    await expect(page.getByRole("button", { name: "Choose models", exact: true })).toHaveText(
      /2 models · judge set/,
    );
  });
  await step("new-chat-from-panel", async () => {
    await openPanel();
    await panel().getByRole("button", { name: "New chat", exact: true }).click();
    await closePanelIfDrawer();
    await home();
  });
  if (!noRound) {
    let completed;
    let lastRoundState;
    await step("real-round-send", async () => {
      // The displayed chips are the expected card titles, including the provider label.
      summary.displayNames = await page
        .getByRole("list", { name: "Contenders", exact: true })
        .locator("li > span")
        .allTextContents();
      // The chips in the model window are the expected page titles, including the provider label.
      await openModelWindow();
      summary.displayNames = await modelWindow()
        .getByRole("list", { name: "Contenders", exact: true })
        .locator("li > span")
        .allTextContents();
      await closeModelWindow();
      await page
        .getByRole("textbox", { name: "Question for the council" })
        .fill(
          researchRound
            ? "Use a web search to find today’s top headline on reuters.com and reply in one sentence naming the source and linking the article."
            : "Reply with exactly one word: ready",
        );
      // A 1x1 PNG through the plus button: it must reach every contender through the tunnel.
      await page.locator('input[type="file"]').setInputFiles({
        name: "dot.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
      await expect(page.getByRole("list", { name: "Attached files" })).toContainText("dot.png");
      // Files upload first, then the round is created; a failure shows in the composer's own line.
      const created = page
        .waitForResponse(
          (res) =>
            new URL(res.url()).pathname === "/api/council/rounds" &&
            res.request().method() === "POST",
          { timeout: 60000 },
        )
        .catch((error) => error);
      await page.getByRole("button", { name: "Send to council", exact: true }).click();
      const response = await created;
      if (response instanceof Error) {
        const composerSays = await page
          .locator("#max-council-send-reason")
          .textContent()
          .catch(() => null);
        throw new Error(
          `Round was not created: ${response.message}; composer says: ${composerSays}`,
        );
      }
      const { round } = await response.json();
      roundId = round.id;
      summary.realRounds++;
      summary.threadsCreated = [
        ...round.contenders.map((c) => c.threadId),
        round.synthesis.threadId,
      ].filter(Boolean);
      assert.equal(response.status(), 201);
      const sent = JSON.parse(response.request().postData());
      assert.equal(sent.contenders.length, 2);
      for (const c of sent.contenders)
        assert.equal(c.attachments?.length, 1, "Each contender gets the file");
      assert.notEqual(
        sent.contenders[0].attachments[0].id,
        sent.contenders[1].attachments[0].id,
        "Each contender needs its own pending upload",
      );
      assert.equal(summary.attachmentUploads.length, 2, "Two upload POSTs must cross the gateway");
      summary.sentAttachments = sent.contenders.map((c) => c.attachments[0]);
      await expect(page).toHaveURL(new RegExp("[?&]round=" + roundId));
      await expect(page.getByRole("list", { name: "Files sent" })).toContainText("dot.png");
      // Before anyone finishes: the calm thinking state with live progress. A fast model can beat
      // this check, in which case the first page is already in front.
      const thinking = page.locator("[data-answered-count]");
      if (await thinking.isVisible()) {
        await expect(thinking).toHaveText(/[0-2] of 2 answered/);
        await gates("thinking-state");
        await page.screenshot({ path: path.join(artifacts, "thinking-state.png"), fullPage: true });
      } else summary.thinkingStateSeen = false;
    });
    await step("real-round-first-finisher", async () => {
      await expect(pages()).toBeVisible({ timeout: 240000 });
      const order = await pageOrder();
      const snapshot = await page.evaluate(
        async (id) => (await (await fetch("/api/council/rounds/" + id)).json()).round,
        roundId,
      );
      const finished = snapshot.contenders
        .filter((c) => c.finishedAt)
        .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
      assert(finished.length >= 1, "A page appeared before any contender finished");
      assert.equal(order[0], finished[0].key, "The first model to finish is the front page");
      summary.firstFinisher = { key: finished[0].key, model: finished[0].model };
      await gates("first-finisher-front");
      await page.screenshot({
        path: path.join(artifacts, "first-finisher-front.png"),
        fullPage: true,
      });
    });
    await step("real-round-complete", async () => {
      await expect(async () => {
        completed = await page.evaluate(
          async (id) => (await (await fetch("/api/council/rounds/" + id)).json()).round,
          roundId,
        );
        const state = JSON.stringify({
          status: completed.status,
          contenders: completed.contenders.map((c) => c.status),
          synthesis: completed.synthesis.status,
        });
        if (state !== lastRoundState) {
          console.log("ROUND", state);
          summary.observedRoundStates.push(JSON.parse(state));
        }
        lastRoundState = state;
        assert(!["failed", "cancelled"].includes(completed.status), JSON.stringify(completed));
        if (completed.contenders.some((c) => c.status === "needs-attention")) return;
        assert.equal(completed.status, "complete");
      }).toPass({ timeout: 240000, intervals: [1500] });
      summary.researchEvidence = researchRound ? completed : undefined;
      await expect(async () => {
        for (const state of [...completed.contenders, completed.synthesis]) {
          const projection = await engine.rpc("orchestration.getThreadProjection", {
            threadId: state.threadId,
          });
          assert(projection.thread?.archivedAt, "Coordinator has not archived " + state.threadId);
          assert(
            projection.messages.some((m) => m.role === "assistant" && m.text.trim()),
            "Archived answer is unreadable",
          );
        }
      }).toPass({ timeout: 30000 });
      summary.projections = await Promise.all(
        [...completed.contenders, completed.synthesis]
          .filter((c) => c.threadId)
          .map(async (c) => {
            const projection = await engine.rpc("orchestration.getThreadProjection", {
              threadId: c.threadId,
            });
            return {
              threadId: c.threadId,
              runtimeMode: projection.thread?.runtimeMode,
              archivedAt: projection.thread?.archivedAt,
              runs: projection.runs,
              runtimeRequests: projection.runtimeRequests,
              turnItems: projection.turnItems,
              // Role and attachment metadata only: enough to prove the file reached the thread.
              messages: (projection.messages ?? []).map((m) => ({
                role: m.role,
                attachments: (m.attachments ?? []).map((a) => ({
                  type: a.type,
                  id: a.id,
                  name: a.name,
                  mimeType: a.mimeType,
                  sizeBytes: a.sizeBytes,
                })),
              })),
            };
          }),
      );
      assert(
        !summary.observedRoundStates.some((r) => r.contenders.includes("needs-attention")),
        "STOP: contender requested attention; see recorded projection requests",
      );
      summary.threadsCreated = [
        ...completed.contenders.map((c) => c.threadId),
        completed.synthesis.threadId,
      ].filter(Boolean);
      assert.equal(completed.contenders.length, 2);
      for (const c of completed.contenders) {
        const projection = summary.projections.find((p) => p.threadId === c.threadId);
        const userMessage = projection.messages?.find((m) => m.role === "user");
        assert.equal(
          userMessage?.attachments?.length,
          1,
          "The engine thread must hold the attachment that crossed the tunnel",
        );
        assert.equal(userMessage.attachments[0].name, "dot.png");
      }
      summary.attachmentsOnThreads = completed.contenders.map((c) => ({
        threadId: c.threadId,
        attachment: summary.projections
          .find((p) => p.threadId === c.threadId)
          ?.messages?.find((m) => m.role === "user")?.attachments?.[0],
      }));
      // Pages: finish order, then the synthesis. Titles are the chips from the model window.
      const byFinish = [...completed.contenders].sort(
        (a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt),
      );
      assert.deepEqual(await pageOrder(), [...byFinish.map((c) => c.key), "synthesis"]);
      assert.equal(
        await pageOrder().then((o) => o[0]),
        summary.firstFinisher.key,
        "Order stayed stable",
      );
      await pages().focus();
      await page.keyboard.press("Home");
      await expectPosition("1 of 3");
      for (let i = 0; i < 2; i++) {
        const contender = byFinish[i];
        const index = completed.contenders.indexOf(contender);
        assert.equal(contender.status, "complete");
        assert(contender.text.trim());
        assert(!/Mode:/i.test(contender.text), "Contender leaked mode boilerplate");
        assert(["auto", "approval-required"].includes(contender.runtimeMode));
        if (researchRound) {
          assert.equal(contender.runtimeMode, "auto");
          const projection = summary.projections.find((p) => p.threadId === contender.threadId);
          assert.equal(projection.runtimeMode, "auto");
          assert.equal(
            projection.runtimeRequests.length,
            0,
            "Research requested approval or input",
          );
        }
        await expectPosition(`${i + 1} of 3`);
        await expect(frontPage()).not.toContainText(/Mode:/i);
        await expect(
          frontPage().getByRole("heading", { name: summary.displayNames[index], exact: true }),
        ).toBeVisible();
        await expect(frontPage().locator(".max-council-status")).toHaveText("complete");
        await gates(`completed-answer-page-${i + 1}`);
        if (i === 0)
          await measureTurn("keyboard-forward-real", () => page.keyboard.press("ArrowRight"));
      }
      await page.keyboard.press("ArrowRight");
      await expectPosition("3 of 3");
      summary.runtimeModes = completed.contenders.map((c) => ({
        threadId: c.threadId,
        runtimeMode: c.runtimeMode,
      }));
      summary.synthesisRuntimeMode = completed.synthesis.runtimeMode;
      assert.equal(completed.synthesis.status, "complete");
      assert(completed.synthesis.text.trim());
      assert(!/Mode:/i.test(completed.synthesis.text), "Synthesis leaked mode boilerplate");
      const synthesis = frontPage();
      await expect(
        synthesis.getByRole("heading", {
          name: "Synthesis · " + summary.synthesizerDisplayName,
          exact: true,
        }),
      ).toBeVisible();
      await expect(synthesis.locator(".max-council-status")).toHaveText("complete");
      await expect(page.getByRole("button", { name: "Next page" }).last()).toBeDisabled();
      await gates("completed-synthesis-text");
      assert(
        ((await synthesis.getByRole("heading", { name: "Verdict", exact: true }).count()) &&
          (await synthesis.getByRole("heading", { name: "consensus", exact: true }).count())) ||
          (await synthesis
            .getByText("Couldn’t read the structured format. The full answer is below.")
            .count()),
        "Missing synthesis sections or parse fallback",
      );
    });
    await step("continue-real-answer", async () => {
      await pages().focus();
      await page.keyboard.press("Home");
      await expectPosition("1 of 3");
      const frontKey = (await pageOrder())[0];
      const frontContender = completed.contenders.find((c) => c.key === frontKey);
      const renderedAnswer = await frontPage().locator(".max-council-answer").innerText();
      await frontPage().getByRole("button", { name: "Continue in Agent Mode" }).click();
      await expect(page).toHaveURL(new RegExp(frontContender.threadId));
      await expect(
        page
          .locator('[data-message-role="assistant"]')
          .filter({ hasText: renderedAnswer.trim() })
          .first(),
      ).toBeVisible();
    });
    await step("restored-thread-replies", async () => {
      const threadId = completed.contenders[0].threadId;
      const before = await engine.rpc("orchestration.getThreadProjection", { threadId });
      assert(!before.thread.archivedAt, "Continue did not restore the thread");
      const expand = page.getByRole("button", { name: "Expand composer", exact: true });
      if (await expand.isVisible()) await expand.click();
      await page
        .locator('[contenteditable="true"]:visible, textarea:visible')
        .first()
        .fill("Reply with exactly one word: restored");
      await page
        .locator('[contenteditable="true"]:visible, textarea:visible')
        .first()
        .press("Enter");
      await expect(async () => {
        const after = await engine.rpc("orchestration.getThreadProjection", { threadId });
        assert(after.runs.length > before.runs.length, "No new provider turn");
        assert.equal(after.runs.at(-1).status, "completed");
        assert(
          after.messages.filter((m) => m.role === "assistant").length >
            before.messages.filter((m) => m.role === "assistant").length,
          "No resumed reply",
        );
        assert(!after.thread.archivedAt, "Continued thread was re-archived");
      }).toPass({ timeout: 120000 });
      summary.continuedThread = threadId;
      completed = await page.evaluate(
        async (id) => (await (await fetch("/api/council/rounds/" + id)).json()).round,
        roundId,
      );
    });
    await step("return-same-round", async () => {
      await page.getByRole("button", { name: "Back to Council" }).click();
      await expect(page).toHaveURL(new RegExp("[?&]round=" + roundId));
    });
    await step("reload-complete-round", async () => {
      await reloadPage();
      await expect(pages()).toBeVisible();
      await expectPosition("1 of 3");
      assert.equal((await pageOrder())[0], summary.firstFinisher.key, "Order survives a reload");
      await expect(frontPage().locator(".max-council-status")).toHaveText("complete");
      const resumed = await page.evaluate(
        async (id) => (await (await fetch("/api/council/rounds/" + id)).json()).round,
        roundId,
      );
      assert.deepEqual(resumed, completed);
    });
    await step("recent-round-reopen", async () => {
      await openPanel();
      await panel().getByRole("button", { name: "New chat", exact: true }).click();
      await closePanelIfDrawer();
      await home();
      await openPanel();
      await panel().getByRole("button", { name: completed.prompt }).click();
      await closePanelIfDrawer();
      await expect(page).toHaveURL(new RegExp("[?&]round=" + roundId));
      await expect(pages()).toBeVisible();
      await expectPosition("1 of 3");
      await openPanel();
      await panel().getByRole("button", { name: "New chat", exact: true }).click();
      await closePanelIfDrawer();
      await home();
    });
  }
  await step("agent-mode", async () => {
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Question for the council" })).toHaveCount(0);
  });
  await step("thread-view", async () => {
    // Agent mode follows the chosen appearance: MAX's branded dark theme, or T3's light theme.
    if (lightScheme) {
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      await expect(page.locator("html")).not.toHaveAttribute("data-max-default-theme");
    } else {
      await expect(page.locator("html")).toHaveClass(/dark/);
      assert.equal(
        await page
          .locator("html")
          .evaluate((el) => getComputedStyle(el).getPropertyValue("--primary").trim()),
        "#00ff41",
      );
    }
    // Agent landing automatically opens a local draft for the most recent project.
    await expect(page.getByRole("button", { name: "Back to Council" })).toBeVisible();
  });
  await step("return-council", async () => {
    await page.getByRole("button", { name: "Back to Council" }).click();
    await home();
  });
  await step("reload-session", async () => {
    await reloadPage();
    await home();
  });
  await step("explicit-appearance-preference", async () => {
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.locator(".tiptap:visible").first()).toBeVisible();
    await page.evaluate(() => localStorage.setItem("t3code:theme-appearance-mode", "light"));
    await reloadPage();
    await expect(page.getByRole("button", { name: "Back to Council" })).toBeVisible();
    await expect(page.locator(".tiptap:visible").first()).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.locator("html")).not.toHaveAttribute("data-max-default-theme");
    await page.evaluate(() => localStorage.removeItem("t3code:theme-appearance-mode"));
    await reloadPage();
    await expect(page.getByRole("button", { name: "Back to Council" })).toBeVisible();
    await expect(page.locator(".tiptap:visible").first()).toBeVisible();
    // With no stored preference MAX starts dark: the first-visit default.
    await expect(page.locator("html")).toHaveClass(/dark/);
    await restoreScheme();
    await reloadPage();
    await page.getByRole("button", { name: "Back to Council" }).click();
    await home();
  });
  await step("viewport-matrix", async () => {
    // Layout must follow the window live: phones (and a phone held sideways) get a drawer and a
    // full-height column; wider windows dock the panel. No reload between sizes.
    for (const size of VIEWPORTS) {
      const label = `${size.width}x${size.height}`;
      await page.setViewportSize(size);
      await home();
      const docked = size.width >= 768;
      if (docked) await expect(panel()).toBeVisible();
      else await expect(panel()).toBeHidden();
      await gates(`viewport-${label}-home`);
      await page.screenshot({ path: path.join(artifacts, `viewport-${label}-home.png`) });
      await openPanel();
      await expect(panel()).toBeVisible();
      await gates(`viewport-${label}-panel`);
      await page.screenshot({ path: path.join(artifacts, `viewport-${label}-panel.png`) });
      await panel().getByRole("button", { name: summary.seededRound.prompt }).click();
      if (!docked) {
        await page.keyboard.press("Escape");
        await expect(panel()).toBeHidden();
      }
      await expect(pages()).toBeVisible();
      await expectPosition("1 of 4");
      const composer = await page
        .getByRole("button", { name: "Send to council", exact: true })
        .boundingBox();
      assert(
        composer && composer.y + composer.height <= size.height + 1,
        `Composer must stay inside the ${label} viewport`,
      );
      await gates(`viewport-${label}-pages`);
      await page.screenshot({ path: path.join(artifacts, `viewport-${label}-pages.png`) });
      await openModelWindow();
      await modelWindow()
        .getByRole("button", { name: "Choose contender models", exact: true })
        .click();
      await expect(page.getByPlaceholder("Search models...")).toBeVisible();
      await gates(`viewport-${label}-picker`);
      await page.screenshot({ path: path.join(artifacts, `viewport-${label}-picker.png`) });
      await page.keyboard.press("Escape");
      await closeModelWindow();
      await openPanel();
      await panel().getByRole("button", { name: "New chat", exact: true }).click();
      if (!docked) {
        await page.keyboard.press("Escape");
        await expect(panel()).toBeHidden();
      }
      await home();
    }
    await page.setViewportSize(viewport);
    await home();
  });
  await step("logout", async () => {
    loggingOut = true;
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.getByRole("button", { name: "Sign out", exact: true }).click(),
    ]);
    await expect(page.getByRole("button", { name: "SIGN IN", exact: true })).toBeVisible();
    loggingOut = false;
  });
} catch (error) {
  errors.push(redact(error.stack));
} finally {
  await cleanup();
  await copyEvidence();
  const gateFailures = summary.gates.filter(
    (g) =>
      g.overflow ||
      g.truncatedTitles ||
      g.smallTargets.length ||
      g.contrast.length ||
      g.transparentPanels.length,
  );
  // Ten >200ms tasks across cold boots and a complete walkthrough allow startup work,
  // but fail sustained main-thread stalls. Keep raw durations for comparison across machines.
  summary.smoothness = {
    thresholdMs: 200,
    maxCount: 10,
    count: summary.longTasks.length,
    pass: summary.longTasks.length <= 10,
  };
  // Page turns: no frame longer than 80 ms and at most two over 34 ms while a page moves.
  summary.pageTurnSmoothness = {
    longestFrameMs: 80,
    maxFramesOver34: 2,
    turns: summary.pageTurns.length,
    pass: summary.pageTurns.length > 0 && summary.pageTurns.every((turn) => turn.pass),
  };
  summary.errors = errors;
  summary.networkFailures = network;
  summary.status =
    errors.length ||
    network.length ||
    gateFailures.length ||
    !summary.smoothness.pass ||
    !summary.pageTurnSmoothness.pass
      ? "fail"
      : "pass";
  await writeFile(path.join(artifacts, "network-failures.json"), JSON.stringify(network, null, 2));
  await writeFile(path.join(artifacts, "console.json"), JSON.stringify(consoleLog, null, 2));
  await writeFile(path.join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      {
        status: summary.status,
        steps: summary.steps.map(({ name, status }) => ({ name, status })),
        gateFailures,
        errors,
        network,
        cleanup: summary.cleanup,
        pageTurns: summary.pageTurns,
        artifacts,
        evidence: summary.evidence,
      },
      null,
      2,
    ),
  );
  process.exitCode = summary.status === "pass" ? 0 : 1;
}
