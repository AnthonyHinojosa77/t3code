// @effect-diagnostics nodeBuiltinImport:off - Billing routes are plain Node handlers, not an HTTP framework.
import type { IncomingMessage, ServerResponse } from "node:http";

import { readSessionToken } from "../auth/cookies.ts";
import type { AuthStore, StoredUser } from "../auth/store.ts";
import { readJsonBody, sendJson } from "../httpUtil.ts";
import {
  CREDIT_PACKS,
  PLANS,
  getCreditPack,
  getCreditPackPriceId,
  isCreditPackEligible,
  normalizePlanId,
  resolveEffectivePlan,
} from "./plans.ts";
import {
  createCheckoutSession,
  createCreditCheckoutSession,
  createPortalSession,
  ensureStripeCustomer,
  type BillingInterval,
} from "./stripe.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentUser(req: IncomingMessage, store: AuthStore): StoredUser | null {
  const token = readSessionToken(req);
  if (!token) return null;
  return store.readSession(token);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function checkout(
  req: IncomingMessage,
  res: ServerResponse,
  user: StoredUser,
  store: AuthStore,
): Promise<void> {
  let raw: unknown = {};
  try {
    raw = await readJsonBody(req);
  } catch {
    raw = {};
  }
  const body = isRecord(raw) ? raw : {};
  const planRaw = typeof body.plan === "string" ? body.plan : "alpha";
  const plan = normalizePlanId(planRaw);
  const interval: BillingInterval = body.interval === "yearly" ? "yearly" : "monthly";
  if (plan === "beta") {
    sendJson(res, 400, { error: "Cannot checkout for the Beta plan." });
    return;
  }
  const effective = resolveEffectivePlan(user);
  if (effective === plan) {
    sendJson(res, 400, { error: `You already have ${PLANS[plan].name} access.` });
    return;
  }
  try {
    const customerId = await ensureStripeCustomer(
      user.id,
      user.email,
      user.displayName,
      user.stripeCustomerId,
    );
    if (!user.stripeCustomerId) store.setStripeCustomerId(user.id, customerId);
    const url = await createCheckoutSession(customerId, user.id, { plan, interval });
    sendJson(res, 200, { url, plan, interval });
  } catch (error) {
    const message = errorMessage(error, "Failed to create checkout session");
    process.stderr.write(`Checkout error: ${message}\n`);
    sendJson(res, 500, { error: message });
  }
}

async function portal(req: IncomingMessage, res: ServerResponse, user: StoredUser): Promise<void> {
  req.resume();
  if (!user.stripeCustomerId) {
    sendJson(res, 400, { error: "No billing account found. Subscribe first." });
    return;
  }
  try {
    const url = await createPortalSession(user.stripeCustomerId);
    sendJson(res, 200, { url });
  } catch (error) {
    const message = errorMessage(error, "Failed to open portal session");
    process.stderr.write(`Portal error: ${message}\n`);
    sendJson(res, 500, { error: message });
  }
}

function status(req: IncomingMessage, res: ServerResponse, user: StoredUser): void {
  req.resume();
  const effective = resolveEffectivePlan(user);
  sendJson(res, 200, {
    plan: effective,
    planName: PLANS[effective].name,
    interval: user.stripeInterval,
    stripeStatus: user.stripeStatus,
    stripePriceId: user.stripePriceId,
    currentPeriodEnd: user.currentPeriodEnd,
    cancelAtPeriodEnd: user.cancelAtPeriodEnd,
    hasStripeCustomer: user.stripeCustomerId !== null,
    hasSubscription: user.stripeSubscriptionId !== null,
    creditBalanceCents: user.creditBalanceCents,
    creditPacks: CREDIT_PACKS.map((pack) => ({
      key: pack.key,
      dollars: pack.dollars,
      creditCents: pack.creditCents,
    })),
  });
}

async function credits(
  req: IncomingMessage,
  res: ServerResponse,
  user: StoredUser,
  store: AuthStore,
): Promise<void> {
  let raw: unknown = {};
  try {
    raw = await readJsonBody(req);
  } catch {
    raw = {};
  }
  const body = isRecord(raw) ? raw : {};
  const pack = typeof body.pack === "string" ? getCreditPack(body.pack) : undefined;
  if (!pack) {
    sendJson(res, 400, { error: "Unknown credit pack. Expected pack20 | pack50 | pack100." });
    return;
  }
  const effective = resolveEffectivePlan(user);
  if (!isCreditPackEligible(effective)) {
    sendJson(res, 403, {
      error: "Credit top-ups are available on the Alpha and Omega plans only.",
      code: "CREDITS_PLAN_RESTRICTED",
      plan: effective,
    });
    return;
  }
  const priceId = getCreditPackPriceId(pack.key);
  if (!priceId) {
    sendJson(res, 500, {
      error: `Stripe price not configured for ${pack.key}. Set ${pack.envVar}.`,
    });
    return;
  }
  try {
    const customerId = await ensureStripeCustomer(
      user.id,
      user.email,
      user.displayName,
      user.stripeCustomerId,
    );
    if (!user.stripeCustomerId) store.setStripeCustomerId(user.id, customerId);
    const url = await createCreditCheckoutSession(customerId, user.id, priceId, pack.key);
    sendJson(res, 200, { url, pack: pack.key, dollars: pack.dollars });
  } catch (error) {
    const message = errorMessage(error, "Failed to start credit checkout");
    process.stderr.write(`Credit checkout error: ${message}\n`);
    sendJson(res, 500, { error: message });
  }
}

/**
 * Non-personal billing routes. The caller has already rejected personal mode.
 * Missing session is 401. These handlers call Stripe only for checkout, portal,
 * and credits. Status does not.
 */
export async function handleBillingHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: AuthStore,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const routed =
    (url.pathname === "/api/billing/checkout" && method === "POST") ||
    (url.pathname === "/api/billing/portal" && method === "POST") ||
    (url.pathname === "/api/billing/status" && method === "GET") ||
    (url.pathname === "/api/billing/credits" && method === "POST");
  if (!routed) return false;
  const user = currentUser(req, store);
  if (!user) {
    req.resume();
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }
  if (url.pathname === "/api/billing/checkout") {
    await checkout(req, res, user, store);
    return true;
  }
  if (url.pathname === "/api/billing/portal") {
    await portal(req, res, user);
    return true;
  }
  if (url.pathname === "/api/billing/status") {
    status(req, res, user);
    return true;
  }
  await credits(req, res, user, store);
  return true;
}
