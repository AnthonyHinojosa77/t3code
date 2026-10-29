import Stripe from "stripe";

import type { PlanId } from "./plans.ts";

/**
 * Port of MAX's Stripe helpers. Personal mode never calls these: the gateway
 * returns 403 for `/api/billing/*` before this module loads a client.
 * `getFrontendUrl` defaults to `http://localhost:5173`. MAX appended
 * `/Maximus-Alpha/` because that app was served from a subpath. This app is
 * served at `/`.
 * The webhook route is not ported. A paid checkout does not update the user
 * row until that route exists.
 */

let stripeClient: Stripe | null = null;

export function resetStripeClientForTests(): void {
  stripeClient = null;
}

export function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY environment variable is not set.");
    }
    stripeClient = new Stripe(key, {
      // MAX pins this version. Cast so a narrower union in stripe's types still compiles.
      apiVersion: "2026-02-25.clover" as Stripe.LatestApiVersion,
    });
  }
  return stripeClient;
}

export function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET environment variable is not set.");
  }
  return secret;
}

export type BillingInterval = "monthly" | "yearly";

const BILLABLE_PLANS: readonly PlanId[] = ["alpha", "omega", "sigma"];

function priceEnvVar(plan: PlanId, interval: BillingInterval): string {
  return `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
}

export function getPriceId(plan: PlanId, interval: BillingInterval): string | null {
  const direct = process.env[priceEnvVar(plan, interval)];
  if (direct) return direct;
  if (plan === "alpha" && interval === "monthly" && process.env.STRIPE_PRICE_ALPHA) {
    return process.env.STRIPE_PRICE_ALPHA;
  }
  return null;
}

export interface PriceIdLookup {
  readonly plan: PlanId;
  readonly interval: BillingInterval;
}

export function resolvePlanFromPriceId(priceId: string): PriceIdLookup | null {
  const intervals: readonly BillingInterval[] = ["monthly", "yearly"];
  for (const plan of BILLABLE_PLANS) {
    for (const interval of intervals) {
      const configured = process.env[priceEnvVar(plan, interval)];
      if (configured && configured === priceId) return { plan, interval };
    }
  }
  if (process.env.STRIPE_PRICE_ALPHA && process.env.STRIPE_PRICE_ALPHA === priceId) {
    return { plan: "alpha", interval: "monthly" };
  }
  return null;
}

export function getAllPaidPriceIds(): string[] {
  const ids = new Set<string>();
  const intervals: readonly BillingInterval[] = ["monthly", "yearly"];
  for (const plan of BILLABLE_PLANS) {
    for (const interval of intervals) {
      const id = process.env[priceEnvVar(plan, interval)];
      if (id) ids.add(id);
    }
  }
  if (process.env.STRIPE_PRICE_ALPHA) ids.add(process.env.STRIPE_PRICE_ALPHA);
  return [...ids];
}

/** Not called at boot. Personal mode does not configure Stripe. */
export function validateStripeConfig(): void {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const missing: string[] = [];
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  const intervals: readonly BillingInterval[] = ["monthly", "yearly"];
  for (const plan of BILLABLE_PLANS) {
    for (const interval of intervals) {
      if (plan === "omega" && interval === "yearly") continue;
      if (!getPriceId(plan, interval)) missing.push(priceEnvVar(plan, interval));
    }
  }
  if (missing.length > 0) {
    process.stderr.write(
      `Stripe config WARNING: STRIPE_SECRET_KEY is set but these env vars are missing: ${missing.join(", ")}\n`,
    );
  }
}

export function getFrontendUrl(): string {
  return process.env.FRONTEND_URL || "http://localhost:5173";
}

export async function ensureStripeCustomer(
  userId: string,
  email: string,
  displayName: string,
  existingCustomerId: string | null,
): Promise<string> {
  if (existingCustomerId) return existingCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    name: displayName,
    metadata: { maximusUserId: userId },
  });
  return customer.id;
}

export interface CheckoutOptions {
  readonly plan: PlanId;
  readonly interval: BillingInterval;
}

export async function createCheckoutSession(
  customerId: string,
  userId: string,
  options: CheckoutOptions,
): Promise<string> {
  if (options.plan === "beta") {
    throw new Error("Cannot checkout for the Beta plan.");
  }
  if (options.plan === "omega" && options.interval === "yearly") {
    throw new Error("Omega is billed monthly only — no annual SKU is offered.");
  }
  const priceId = getPriceId(options.plan, options.interval);
  if (!priceId) {
    throw new Error(
      `Stripe price is not configured for ${options.plan}/${options.interval}. Set the ${priceEnvVar(options.plan, options.interval)} env var.`,
    );
  }
  const stripe = getStripe();
  const frontendUrl = getFrontendUrl();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    client_reference_id: userId,
    metadata: { userId, plan: options.plan, interval: options.interval },
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontendUrl}?billing=success`,
    cancel_url: `${frontendUrl}?billing=canceled`,
  });
  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }
  return session.url;
}

export async function createCreditCheckoutSession(
  customerId: string,
  userId: string,
  priceId: string,
  packKey: string,
): Promise<string> {
  const stripe = getStripe();
  const frontendUrl = getFrontendUrl();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    client_reference_id: userId,
    mode: "payment",
    metadata: { userId, kind: "credit_pack", pack: packKey },
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontendUrl}?billing=credits-success`,
    cancel_url: `${frontendUrl}?billing=credits-canceled`,
  });
  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }
  return session.url;
}

export async function createPortalSession(customerId: string): Promise<string> {
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: getFrontendUrl(),
  });
  return session.url;
}
