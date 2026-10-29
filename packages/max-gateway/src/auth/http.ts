// @effect-diagnostics nodeBuiltinImport:off - Auth routes are plain Node handlers, not an HTTP framework.
// @effect-diagnostics globalDate:off - Plan reset timestamps are wall-clock UTC, same as a daily cap window.
import type { IncomingMessage, ServerResponse } from "node:http";

import { readJsonBody, sendJson } from "../httpUtil.ts";
import { PLANS, resolveEffectivePlan, type PlanId } from "../billing/plans.ts";
import { sessionClearCookie, sessionSetCookie, readSessionToken } from "./cookies.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import type { AuthStore, StoredUser } from "./store.ts";
import { toPublicUser } from "./store.ts";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthHttpContext {
  readonly authStore: AuthStore;
  readonly personalMode: boolean;
  readonly ownerEmail: string | null;
  /** Cookie Secure flag. Tests pass a plain object instead of editing process.env. */
  readonly cookieEnv: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function ownerAllowed(email: string, ctx: AuthHttpContext): boolean {
  if (!ctx.personalMode) return true;
  if (!ctx.ownerEmail) return false;
  return email === ctx.ownerEmail;
}

function currentUser(req: IncomingMessage, store: AuthStore): StoredUser | null {
  const token = readSessionToken(req);
  if (!token) return null;
  return store.readSession(token);
}

/**
 * Personal-mode plan-status.
 * `plan` is `"owner"`, which is not one of MAX's plan ids (`beta|alpha|omega|sigma`).
 * Caps are null. `monthlyCredits` and `creditsRemaining` are null here; MAX's
 * AccountPanel types those two as numbers. The other field names match that panel.
 * `user.plan` on `/api/auth/me` stays the stored plan id. Unlimited is this payload.
 */
function personalPlanStatus(user: StoredUser): Record<string, unknown> {
  const resets = new Date();
  resets.setUTCDate(resets.getUTCDate() + 1);
  resets.setUTCHours(0, 0, 0, 0);
  return {
    plan: "owner",
    planName: "Owner",
    planDescription: "Personal mode. No turn caps.",
    dailyTurnCap: null,
    halfwayWarningTurns: null,
    turnsUsedToday: 0,
    turnsHalfwayWarning: false,
    monthlyTurnCap: null,
    monthlyHalfwayWarningTurns: null,
    turnsUsedThisMonth: 0,
    turnsMonthlyWarning: false,
    monthlyCredits: null,
    creditsUsedThisPeriod: 0,
    creditsRemaining: null,
    capped: false,
    usagePercent: 0,
    threshold: "normal",
    resetsAt: resets.toISOString(),
    periodEndsAt: null,
    requiresByok: false,
    creditBalanceCents: user.creditBalanceCents,
    features: { creditTopups: false },
  };
}

/**
 * Non-personal plan-status. Turn tables are not ported, so usage is zero and
 * caps are null. The plan id is the stored plan, not `"owner"`.
 */
function storedPlanStatus(user: StoredUser): Record<string, unknown> {
  const planId = resolveEffectivePlan(user);
  const plan = PLANS[planId];
  const resets = new Date();
  resets.setUTCDate(resets.getUTCDate() + 1);
  resets.setUTCHours(0, 0, 0, 0);
  return {
    plan: plan.id,
    planName: plan.name,
    planDescription: plan.description,
    dailyTurnCap: null,
    halfwayWarningTurns: null,
    turnsUsedToday: 0,
    turnsHalfwayWarning: false,
    monthlyTurnCap: null,
    monthlyHalfwayWarningTurns: null,
    turnsUsedThisMonth: 0,
    turnsMonthlyWarning: false,
    monthlyCredits: null,
    creditsUsedThisPeriod: 0,
    creditsRemaining: null,
    capped: false,
    usagePercent: 0,
    threshold: "normal",
    resetsAt: resets.toISOString(),
    periodEndsAt: null,
    requiresByok: false,
    creditBalanceCents: user.creditBalanceCents,
    features: { creditTopups: false },
  };
}

function turnStatus(plan: PlanId | "owner", unlimited: boolean): Record<string, unknown> {
  // `unlimited` is extra. MAX returns `{ plan, models }` from the model catalog.
  // That catalog is not ported, so `models` is empty.
  return { plan, unlimited, models: [] };
}

async function register(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHttpContext,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (error) {
    const message =
      error instanceof Error && error.message === "body too large"
        ? "Body too large"
        : "Invalid JSON body";
    sendJson(res, 400, { error: message });
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const email = readString(parsed, "email")?.trim().toLowerCase();
  const password = readString(parsed, "password");
  const displayName = readString(parsed, "displayName")?.trim();
  if (!email || !password) {
    sendJson(res, 400, { error: "Email and password are required." });
    return;
  }
  if (password.length < 8) {
    sendJson(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }
  if (!EMAIL_PATTERN.test(email)) {
    sendJson(res, 400, { error: "Invalid email address." });
    return;
  }
  if (!ownerAllowed(email, ctx)) {
    sendJson(res, 403, { error: "Registration is limited to the owner." });
    return;
  }
  if (ctx.authStore.getUserByEmail(email)) {
    sendJson(res, 409, { error: "An account with this email already exists." });
    return;
  }
  const localPart = email.split("@")[0];
  const name = displayName && displayName.length > 0 ? displayName : (localPart ?? email);
  const passwordHash = await hashPassword(password);
  const user = ctx.authStore.insertUser({ email, passwordHash, displayName: name });
  const session = ctx.authStore.createSession(user.id);
  sendJson(
    res,
    201,
    { user: toPublicUser(user), token: session.token },
    { "set-cookie": sessionSetCookie(session.token, ctx.cookieEnv) },
  );
}

async function login(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHttpContext,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (error) {
    const message =
      error instanceof Error && error.message === "body too large"
        ? "Body too large"
        : "Invalid JSON body";
    sendJson(res, 400, { error: message });
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }
  const email = readString(parsed, "email")?.trim().toLowerCase();
  const password = readString(parsed, "password");
  if (!email || !password) {
    sendJson(res, 400, { error: "Email and password are required." });
    return;
  }
  // Personal mode rejects a non-owner before the password check, so a planted
  // row with the right password is still 403, and an unknown non-owner is 403
  // rather than 401.
  if (!ownerAllowed(email, ctx)) {
    sendJson(res, 403, { error: "Login is limited to the owner." });
    return;
  }
  const user = ctx.authStore.getUserByEmail(email);
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !valid) {
    sendJson(res, 401, { error: "Invalid email or password." });
    return;
  }
  const session = ctx.authStore.createSession(user.id);
  sendJson(
    res,
    200,
    { user: toPublicUser(user), token: session.token },
    { "set-cookie": sessionSetCookie(session.token, ctx.cookieEnv) },
  );
}

function logout(req: IncomingMessage, res: ServerResponse, ctx: AuthHttpContext): void {
  const token = readSessionToken(req);
  if (token) ctx.authStore.deleteSession(token);
  req.resume();
  sendJson(res, 200, { ok: true }, { "set-cookie": sessionClearCookie(ctx.cookieEnv) });
}

/**
 * The only `/api/auth/*` endpoints MAX answers itself, by method and exact path.
 * T3's environment auth API shares the prefix (`/api/auth/session`, `/browser-session`,
 * `/websocket-ticket`, pairing and clients), so every other `/api/auth/*` request is
 * proxied to the Mini like any T3 path.
 */
export const MAX_AUTH_ROUTES: ReadonlyArray<{ readonly method: string; readonly path: string }> = [
  { method: "POST", path: "/api/auth/register" },
  { method: "POST", path: "/api/auth/login" },
  { method: "POST", path: "/api/auth/logout" },
  { method: "GET", path: "/api/auth/me" },
  { method: "GET", path: "/api/auth/plan-status" },
  { method: "GET", path: "/api/auth/turn-status" },
];

export function isMaxAuthRoute(method: string, pathname: string): boolean {
  return MAX_AUTH_ROUTES.some((route) => route.method === method && route.path === pathname);
}

/** Returns false when this path is not an auth route the gateway implements. */
export async function handleAuthHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AuthHttpContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (url.pathname === "/api/auth/register" && method === "POST") {
    await register(req, res, ctx);
    return true;
  }
  if (url.pathname === "/api/auth/login" && method === "POST") {
    await login(req, res, ctx);
    return true;
  }
  if (url.pathname === "/api/auth/logout" && method === "POST") {
    logout(req, res, ctx);
    return true;
  }
  if (url.pathname === "/api/auth/me" && method === "GET") {
    req.resume();
    const user = currentUser(req, ctx.authStore);
    if (!user) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    sendJson(res, 200, { user: toPublicUser(user), personalMode: ctx.personalMode });
    return true;
  }
  if (url.pathname === "/api/auth/plan-status" && method === "GET") {
    req.resume();
    const user = currentUser(req, ctx.authStore);
    if (!user) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    sendJson(res, 200, ctx.personalMode ? personalPlanStatus(user) : storedPlanStatus(user));
    return true;
  }
  if (url.pathname === "/api/auth/turn-status" && method === "GET") {
    req.resume();
    const user = currentUser(req, ctx.authStore);
    if (!user) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    if (ctx.personalMode) {
      sendJson(res, 200, turnStatus("owner", true));
      return true;
    }
    sendJson(res, 200, turnStatus(resolveEffectivePlan(user), false));
    return true;
  }
  return false;
}
