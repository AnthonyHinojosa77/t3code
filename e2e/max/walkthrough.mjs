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
import { COMPANION_SCOPES } from "../../packages/max-gateway/src/bearerToken.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium, expect } = require("playwright/test");
// By default a full acceptance run covers both OS appearances; only the dark
// pass spends a real round. Explicit scheme flags support no-round iteration.
if (
  !process.argv.includes("--single-scheme") &&
  !process.argv.includes("--light") &&
  !process.argv.includes("--no-round")
) {
  for (const flags of [
    ["--single-scheme"],
    ["--single-scheme", "--light", "--no-round", "--skip-build"],
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
const summary = {
  colorScheme: process.argv.includes("--light") ? "light" : "dark",
  status: "running",
  viewport: process.argv.includes("--no-round") ? "360x780@3" : "390x844@3",
  steps: [],
  gates: [],
  longTasks: [],
  usage: [],
  threadsCreated: [],
  realRounds: 0,
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
const requestsBeforeReload = new WeakSet();
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
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
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
  const result = await page.evaluate(() => {
    const visible = (el) =>
      el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
    const titles = [...document.querySelectorAll(".max-wordmark,h1")].filter(
      (el) => visible(el) && el.textContent.trim() === "MAX",
    );
    const primary = [
      ...document.querySelectorAll(
        'button[type="submit"], [aria-label="Mode"] button, button[aria-label="Choose contender models"], button[aria-label="Choose synthesizer model"], button[aria-label="Back to Council"], .max-council-button, .max-council-models button, .max-scope select',
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
        .filter((x) => x.width < 40 || x.height < 40),
    };
  });
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
  for (const request of activeRequests) requestsBeforeReload.add(request);
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
  await expect(
    page.getByRole("button", { name: "Choose contender models", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose synthesizer model", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Council", exact: true })).toBeVisible();
  await expect(page.getByText("Synthesizer", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Unable to connect|Something went wrong|Connection failed/i),
  ).toHaveCount(0);
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
  const companion = start(process.execPath, ["packages/max-gateway/src/miniCompanion.ts"], {
    ...common,
    MAX_GATEWAY_URL: base,
    MAX_COMPANION_BEARER_TOKEN: issued.token,
    T3_BIN: t3,
  });
  await ready(companion, "max companion tunnel connected");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: process.argv.includes("--no-round")
      ? { width: 360, height: 780 }
      : { width: 390, height: 844 },
    colorScheme: summary.colorScheme,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
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
    if (
      reloading &&
      requestsBeforeReload.has(req) &&
      req.failure()?.errorText === "net::ERR_ABORTED"
    ) {
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
  await step("contender-picker", async () => {
    await page.getByRole("button", { name: "Choose contender models", exact: true }).click();
    await expect(page.getByPlaceholder("Search models...")).toBeVisible();
  });
  await step("two-contenders", async () => {
    const options = page.getByRole("option").filter({ visible: true });
    await expect(options.first()).toBeVisible();
    assert((await options.count()) >= 2, "Need two real model options");
    const candidates = [...providerEvidence.values()]
      .flatMap(({ provider }) =>
        provider.models
          .filter((m) => /haiku|gpt-6-luna/i.test(m.slug))
          .map((m) => ({ provider, model: m })),
      )
      .filter(({ provider }) => provider.status === "ready");
    candidates.sort(
      (a, b) =>
        Number(!/claude-haiku-5-5|gpt-6-luna/.test(a.model.slug)) -
        Number(!/claude-haiku-5-5|gpt-6-luna/.test(b.model.slug)),
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
    await page.getByRole("button", { name: "Choose synthesizer model", exact: true }).click();
    const selected = summary.models[0];
    await page.locator('[data-model-picker-provider="' + selected.instanceId + '"]').click();
    await page.getByPlaceholder("Search models...").fill(selected.name);
    await page.getByRole("option").filter({ visible: true }).first().click();
    await expect(page.getByText(/^Synthesizer:/)).toBeVisible();
    summary.synthesizerDisplayName = (await page.getByText(/^Synthesizer:/).textContent())
      .replace(/^Synthesizer:\s*/, "")
      .trim();
  });
  await step("low-effort", async () => {
    const scopes = [
      ...(await page
        .getByRole("list", { name: "Contenders", exact: true })
        .getByRole("listitem")
        .all()),
      page.locator(".max-council-models > div").filter({
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
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  });
  await step("traits-menu", async () => {
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
    await page.getByRole("button", { name: "Manage templates", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
  await page.keyboard.press("Escape");
  await step("provider-usage", async () => {
    await page.getByRole("button", { name: "Choose contender models", exact: true }).click();
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
  if (!process.argv.includes("--no-round")) {
    let completed;
    let lastRoundState;
    await step("real-round-send", async () => {
      // The displayed chips are the expected card titles, including the provider label.
      summary.displayNames = await page
        .getByRole("list", { name: "Contenders", exact: true })
        .locator("li > span")
        .allTextContents();
      await page
        .getByRole("textbox", { name: "Question for the council" })
        .fill("Reply with exactly one word: ready");
      const created = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/council/rounds" &&
          res.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Send to council", exact: true }).click();
      const response = await created;
      const { round } = await response.json();
      roundId = round.id;
      summary.realRounds++;
      summary.threadsCreated = [
        ...round.contenders.map((c) => c.threadId),
        round.synthesis.threadId,
      ].filter(Boolean);
      assert.equal(response.status(), 201);
      await expect(page).toHaveURL(new RegExp("[?&]round=" + roundId));
      await expect(
        page.getByRole("region", { name: "Council responses" }).locator("article"),
      ).toHaveCount(2);
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
        if (state !== lastRoundState) console.log("ROUND", state);
        lastRoundState = state;
        assert(!["failed", "cancelled"].includes(completed.status), JSON.stringify(completed));
        assert.equal(completed.status, "complete");
      }).toPass({ timeout: 240000, intervals: [1500] });
      summary.threadsCreated = [
        ...completed.contenders.map((c) => c.threadId),
        completed.synthesis.threadId,
      ].filter(Boolean);
      assert.equal(completed.contenders.length, 2);
      const cards = page.getByRole("region", { name: "Council responses" }).locator("article");
      for (let i = 0; i < 2; i++) {
        assert.equal(completed.contenders[i].status, "complete");
        assert(completed.contenders[i].text.trim());
        assert(!/Mode:/i.test(completed.contenders[i].text), "Contender leaked mode boilerplate");
        assert(["auto", "approval-required"].includes(completed.contenders[i].runtimeMode));
        await expect(cards.nth(i)).not.toContainText(/Mode:/i);
        await expect(
          cards.nth(i).getByRole("heading", { name: summary.displayNames[i], exact: true }),
        ).toBeVisible();
        await expect(cards.nth(i).locator(".max-council-status")).toHaveText("complete");
      }
      await cards.first().scrollIntoViewIfNeeded();
      await gates("completed-answer-text");
      summary.runtimeModes = completed.contenders.map((c) => ({
        threadId: c.threadId,
        runtimeMode: c.runtimeMode,
      }));
      summary.synthesisRuntimeMode = completed.synthesis.runtimeMode;
      assert.equal(completed.synthesis.status, "complete");
      assert(completed.synthesis.text.trim());
      const synthesis = page.getByRole("region", { name: "Council synthesis" });
      await expect(
        synthesis.getByRole("heading", {
          name: "Synthesis · " + summary.synthesizerDisplayName,
          exact: true,
        }),
      ).toBeVisible();
      await expect(synthesis.locator(".max-council-status")).toHaveText("complete");
      await synthesis.scrollIntoViewIfNeeded();
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
      await page
        .getByRole("region", { name: "Council responses" })
        .locator("article")
        .first()
        .getByRole("button", { name: "Continue in Agent Mode" })
        .click();
      await expect(page).toHaveURL(new RegExp(completed.contenders[0].threadId));
      await expect(
        page
          .locator('[data-message-role="assistant"]')
          .filter({ hasText: completed.contenders[0].text.trim() })
          .first(),
      ).toBeVisible();
    });
    await step("return-same-round", async () => {
      await page.getByRole("button", { name: "Back to Council" }).click();
      await expect(page).toHaveURL(new RegExp("[?&]round=" + roundId));
    });
    await step("reload-complete-round", async () => {
      await reloadPage();
      await expect(
        page.getByRole("region", { name: "Council responses" }).locator(".max-council-status"),
      ).toHaveText(["complete", "complete"]);
      const resumed = await page.evaluate(
        async (id) => (await (await fetch("/api/council/rounds/" + id)).json()).round,
        roundId,
      );
      assert.deepEqual(resumed, completed);
    });
    await step("recent-round-reopen", async () => {
      await page.getByRole("button", { name: "New question", exact: true }).click();
      await home();
      await page.getByRole("button", { name: /Reply with exactly one word: ready/ }).click();
      await expect(page).toHaveURL(new RegExp("[?&]round=" + roundId));
      await expect(
        page.getByRole("region", { name: "Council responses" }).locator(".max-council-status"),
      ).toHaveText(["complete", "complete"]);
      await page.getByRole("button", { name: "New question", exact: true }).click();
      await home();
    });
  }
  await step("agent-mode", async () => {
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Question for the council" })).toHaveCount(0);
  });
  await step("thread-view", async () => {
    await expect(page.locator("html")).toHaveClass(/dark/);
    assert.equal(
      await page
        .locator("html")
        .evaluate((el) => getComputedStyle(el).getPropertyValue("--primary").trim()),
      "#00ff41",
    );
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
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Back to Council" }).click();
    await home();
  });
  await step("phone-360-gates", async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    await home();
    await page.getByRole("button", { name: "Choose contender models", exact: true }).click();
    await expect(page.getByPlaceholder("Search models...")).toBeVisible();
    await gates("phone-360-picker");
    await page.screenshot({ path: path.join(artifacts, "phone-360-picker.png"), fullPage: true });
    await page.keyboard.press("Escape");
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
  summary.errors = errors;
  summary.networkFailures = network;
  summary.status =
    errors.length || network.length || gateFailures.length || !summary.smoothness.pass
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
        artifacts,
      },
      null,
      2,
    ),
  );
  process.exitCode = summary.status === "pass" ? 0 : 1;
}
