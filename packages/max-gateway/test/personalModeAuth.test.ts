// @effect-diagnostics nodeBuiltinImport:off - These tests drive real sockets and a temp SQLite file.
// @effect-diagnostics globalTimers:off - Request deadlines wait on real socket I/O.
// @effect-diagnostics globalDate:off - The owner-email warning test does not use fake timers.
import * as NodeHttp from "node:http";
type IncomingMessage = NodeHttp.IncomingMessage;
const { request: httpRequest } = NodeHttp;
import * as NodeFSP from "node:fs/promises";
const { mkdtemp, rm, writeFile, mkdir } = NodeFSP;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const path = NodePath;
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { warnIfOwnerEmailMissing } from "../src/auth/personalMode.ts";
import { openAuthStore, resolveAuthDbPath, type AuthStore } from "../src/auth/store.ts";
import { resetStripeClientForTests } from "../src/billing/stripe.ts";
import { maximusSessionOwnerAuth } from "../src/ownerAuth.ts";
import { resolveInsideDist } from "../src/staticApp.ts";
import { startTunnelServer, type RunningTunnelServer } from "../src/tunnelServer.ts";

const SECRET = "task1-test-secret";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = "dummy-password";
const OTHER_EMAIL = "other@example.com";
const OTHER_PASSWORD = "other-dummy-password";

beforeEach(() => {
  vi.useRealTimers();
});

interface HttpResult {
  readonly status: number;
  readonly body: string;
  readonly setCookie: string | null;
}

function send(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<HttpResult> {
  const target = new URL(url);
  const body = init?.body;
  const headers = { ...init?.headers };
  if (body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? "GET",
        headers,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const rawCookie = res.headers["set-cookie"];
          const setCookie = Array.isArray(rawCookie) ? (rawCookie[0] ?? null) : (rawCookie ?? null);
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            setCookie,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function sessionCookie(setCookie: string | null): string {
  const match = setCookie?.match(/maximus_session=([^;]+)/);
  const token = match?.[1];
  if (!token) throw new Error("response did not set maximus_session");
  return `maximus_session=${token}`;
}

interface Gateway {
  readonly url: string;
  readonly store: AuthStore;
  readonly server: RunningTunnelServer;
  close: () => Promise<void>;
}

async function startGateway(options: {
  readonly dir: string;
  readonly personalMode: boolean;
  readonly ownerEmail: string | null;
  readonly webDist?: string | null;
  /** Empty by default so a developer machine's env cannot flip the cookie to Secure. */
  readonly cookieEnv?: NodeJS.ProcessEnv;
}): Promise<Gateway> {
  const store = openAuthStore(path.join(options.dir, "auth.sqlite"));
  const server = await startTunnelServer({
    host: "127.0.0.1",
    tunnelSecret: SECRET,
    personalMode: options.personalMode,
    ownerEmail: options.ownerEmail,
    webDist: options.webDist ?? null,
    cookieEnv: options.cookieEnv ?? {},
    authStore: store,
    isOwnerRequest: maximusSessionOwnerAuth((token) => store.readSession(token) !== null),
  });
  return {
    url: server.url,
    store,
    server,
    close: async () => {
      await server.close();
      store.close();
    },
  };
}

describe("personal mode auth", () => {
  it("joins max.sqlite onto a volume directory and does not open that path", () => {
    expect(resolveAuthDbPath({ RAILWAY_VOLUME_MOUNT_PATH: "/data" })).toBe(
      `${path.sep}data${path.sep}max.sqlite`,
    );
    expect(resolveAuthDbPath({ MAX_DB_PATH: path.join(tmpdir(), "unused-max.sqlite") })).toContain(
      "unused-max.sqlite",
    );
  });

  it("logs once when personal mode has no owner email", () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      warnIfOwnerEmailMissing({ MAX_PERSONAL_MODE: "true" });
      warnIfOwnerEmailMissing({ MAX_PERSONAL_MODE: "true" });
    } finally {
      process.stderr.write = original;
    }
    expect(lines).toEqual([
      "OWNER_EMAIL is unset; personal mode rejects every register and login\n",
    ]);
  });

  it("registers and logs in the owner, and rejects everyone else", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3mc-auth-"));
    const gateway = await startGateway({ dir, personalMode: true, ownerEmail: OWNER_EMAIL });
    try {
      const unknown = await send(`${gateway.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(unknown.status).toBe(401);
      expect(JSON.parse(unknown.body)).toEqual({ error: "Invalid email or password." });

      const shortPassword = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: "short" }),
      });
      expect(shortPassword.status).toBe(400);

      const badEmail = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email", password: OWNER_PASSWORD }),
      });
      expect(badEmail.status).toBe(400);

      const registered = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({
          email: "Owner@Example.com",
          password: OWNER_PASSWORD,
          displayName: "Owner",
        }),
      });
      expect(registered.status).toBe(201);
      expect(registered.setCookie).toContain("maximus_session=");
      expect(registered.setCookie).toContain("HttpOnly");
      expect(registered.setCookie).toContain("SameSite=Lax");
      expect(registered.setCookie).not.toContain("Secure");
      const created = JSON.parse(registered.body) as { user: { email: string; plan: string } };
      expect(created.user.email).toBe(OWNER_EMAIL);
      expect(created.user.plan).toBe("beta");

      const duplicate = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(duplicate.status).toBe(409);

      const wrong = await send(`${gateway.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: "wrong-password" }),
      });
      expect(wrong.status).toBe(401);
      expect(JSON.parse(wrong.body)).toEqual({ error: "Invalid email or password." });

      const loggedIn = await send(`${gateway.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(loggedIn.status).toBe(200);
      expect(loggedIn.setCookie).not.toContain("Secure");
      const cookie = sessionCookie(loggedIn.setCookie);
      const me = await send(`${gateway.url}/api/auth/me`, { headers: { cookie } });
      expect(me.status).toBe(200);
      expect(JSON.parse(me.body)).toMatchObject({
        personalMode: true,
        user: { email: OWNER_EMAIL, displayName: "Owner" },
      });

      const plan = await send(`${gateway.url}/api/auth/plan-status`, { headers: { cookie } });
      expect(plan.status).toBe(200);
      const planBody = JSON.parse(plan.body) as {
        plan: string;
        dailyTurnCap: unknown;
        monthlyTurnCap: unknown;
        capped: boolean;
        usagePercent: number;
      };
      expect(planBody.plan).toBe("owner");
      expect(planBody.dailyTurnCap).toBeNull();
      expect(planBody.monthlyTurnCap).toBeNull();
      expect(planBody.capped).toBe(false);
      expect(planBody.usagePercent).toBe(0);

      const turns = await send(`${gateway.url}/api/auth/turn-status`, { headers: { cookie } });
      expect(JSON.parse(turns.body)).toEqual({ plan: "owner", unlimited: true, models: [] });

      const nonOwner = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({ email: OTHER_EMAIL, password: OTHER_PASSWORD }),
      });
      expect(nonOwner.status).toBe(403);

      gateway.store.insertUser({
        email: OTHER_EMAIL,
        passwordHash: "planted-not-a-login",
        displayName: "Other",
      });
      const planted = await send(`${gateway.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: OTHER_EMAIL, password: OTHER_PASSWORD }),
      });
      expect(planted.status).toBe(403);

      const billing = await send(`${gateway.url}/api/billing/plans`, { headers: { cookie } });
      expect(billing.status).toBe(403);
      const billingAnon = await send(`${gateway.url}/api/billing/status`);
      expect(billingAnon.status).toBe(403);
      const providers = await send(`${gateway.url}/api/providers/keys`, { headers: { cookie } });
      expect(providers.status).toBe(403);

      const proxied = await send(`${gateway.url}/api/auth/session`, {
        headers: { cookie },
      });
      expect(proxied.status).toBe(502);
      const missing = await send(`${gateway.url}/api/auth/clients`);
      expect(missing.status).toBe(401);
      // T3's bootstrap session check is public; with no tunnel it fails at the proxy, not 401.
      const bootstrap = await send(`${gateway.url}/api/auth/session`);
      expect(bootstrap.status).toBe(502);

      const loggedOut = await send(`${gateway.url}/api/auth/logout`, {
        method: "POST",
        headers: { cookie },
      });
      expect(loggedOut.status).toBe(200);
      const afterLogout = await send(`${gateway.url}/api/auth/clients`, {
        headers: { cookie },
      });
      expect(afterLogout.status).toBe(401);

      const again = await send(`${gateway.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      const fresh = sessionCookie(again.setCookie);
      gateway.store.expireSession(decodeURIComponent(fresh.slice("maximus_session=".length)));
      const expired = await send(`${gateway.url}/api/auth/clients`, {
        headers: { cookie: fresh },
      });
      expect(expired.status).toBe(401);
    } finally {
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sets a Secure session cookie on register and login when RAILWAY_ENVIRONMENT is set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3mc-auth-"));
    const gateway = await startGateway({
      dir,
      personalMode: true,
      ownerEmail: OWNER_EMAIL,
      cookieEnv: { RAILWAY_ENVIRONMENT: "production" },
    });
    try {
      const registered = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(registered.status).toBe(201);
      expect(registered.setCookie).toContain("maximus_session=");
      expect(registered.setCookie).toContain("HttpOnly");
      expect(registered.setCookie).toContain("SameSite=Lax");
      expect(registered.setCookie).toContain("Secure");

      const loggedIn = await send(`${gateway.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(loggedIn.status).toBe(200);
      expect(loggedIn.setCookie).toContain("maximus_session=");
      expect(loggedIn.setCookie).toContain("HttpOnly");
      expect(loggedIn.setCookie).toContain("SameSite=Lax");
      expect(loggedIn.setCookie).toContain("Secure");
    } finally {
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when personal mode has no owner email", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3mc-auth-"));
    const gateway = await startGateway({ dir, personalMode: true, ownerEmail: null });
    try {
      const registered = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(registered.status).toBe(403);
      const loggedIn = await send(`${gateway.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      });
      expect(loggedIn.status).toBe(403);
    } finally {
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opens registration and billing when personal mode is off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3mc-auth-"));
    const gateway = await startGateway({ dir, personalMode: false, ownerEmail: OWNER_EMAIL });
    const previousKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    resetStripeClientForTests();
    try {
      const registered = await send(`${gateway.url}/api/auth/register`, {
        method: "POST",
        body: JSON.stringify({
          email: OTHER_EMAIL,
          password: OTHER_PASSWORD,
          displayName: "Other",
        }),
      });
      expect(registered.status).toBe(201);
      const cookie = sessionCookie(registered.setCookie);
      const me = await send(`${gateway.url}/api/auth/me`, { headers: { cookie } });
      expect(JSON.parse(me.body)).toMatchObject({
        personalMode: false,
        user: { email: OTHER_EMAIL },
      });

      const billing = await send(`${gateway.url}/api/billing/status`, { headers: { cookie } });
      expect(billing.status).not.toBe(403);
      expect(billing.status).toBe(200);

      const checkout = await send(`${gateway.url}/api/billing/checkout`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ plan: "alpha", interval: "monthly" }),
      });
      expect(checkout.status).toBe(500);
      const checkoutBody = JSON.parse(checkout.body) as { error?: string; url?: string };
      expect(checkoutBody.error).toContain("STRIPE_SECRET_KEY");
      expect(checkoutBody.url).toBeUndefined();
      expect(checkout.body).not.toContain("checkout.stripe.com");
    } finally {
      if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = previousKey;
      resetStripeClientForTests();
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves the web dist when it exists and proxies when it does not", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "t3mc-static-"));
    const dist = path.join(dir, "dist");
    const outside = path.join(dir, "secret.txt");
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<html>MAX-SHELL</html>");
    await writeFile(path.join(dist, "assets", "app.js"), "MAX-ASSET");
    await writeFile(outside, "TOP-SECRET");
    const withDist = await startGateway({
      dir,
      personalMode: true,
      ownerEmail: OWNER_EMAIL,
      webDist: dist,
    });
    try {
      expect(resolveInsideDist(dist, "/../../secret.txt")).toBeNull();
      const asset = await send(`${withDist.url}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.body).toBe("MAX-ASSET");
      const shell = await send(`${withDist.url}/dashboard`);
      expect(shell.status).toBe(200);
      expect(shell.body).toContain("MAX-SHELL");
      const escaped = await send(`${withDist.url}/%2e%2e/secret.txt`);
      expect(escaped.body).not.toContain("TOP-SECRET");
      const api = await send(`${withDist.url}/api/auth/clients`);
      expect(api.status).toBe(401);
      // T3 metadata paths are never answered with the SPA shell.
      const environment = await send(`${withDist.url}/.well-known/t3/environment`);
      expect(environment.status).toBe(502);
      expect(environment.body).not.toContain("MAX-SHELL");
      for (const pathname of ["/.well-known/other", "/oauth/token"]) {
        const gated = await send(`${withDist.url}${pathname}`);
        expect(gated.status, pathname).toBe(401);
        expect(gated.body).not.toContain("MAX-SHELL");
      }
    } finally {
      await withDist.close();
    }

    const withoutDist = await startGateway({
      dir,
      personalMode: true,
      ownerEmail: OWNER_EMAIL,
      webDist: null,
    });
    try {
      const page = await send(`${withoutDist.url}/`);
      expect(page.status).toBe(401);
      expect(page.body).toBe("unauthorized\n");
      expect(page.body).not.toContain("MAX-SHELL");
    } finally {
      await withoutDist.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
