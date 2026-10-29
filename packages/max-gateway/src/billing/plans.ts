/**
 * Plan ids MAX's billing routes already use. Invite tables are not ported.
 * Personal mode does not read this table for `/api/auth/plan-status`; that
 * route returns the unlimited owner shape instead.
 */
export type PlanId = "beta" | "alpha" | "omega" | "sigma";

export interface PlanDefinition {
  readonly id: PlanId;
  readonly name: string;
  readonly description: string;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  beta: { id: "beta", name: "Beta", description: "Included access." },
  alpha: { id: "alpha", name: "Alpha", description: "Paid plan." },
  omega: { id: "omega", name: "Omega", description: "Paid plan, billed monthly." },
  sigma: { id: "sigma", name: "Sigma", description: "Highest plan." },
};

const BILLABLE: readonly PlanId[] = ["alpha", "omega", "sigma"];

export function isPlanId(value: string): value is PlanId {
  return value === "beta" || value === "alpha" || value === "omega" || value === "sigma";
}

/** Checkout defaults an unknown plan to alpha, matching MAX's billing route. */
export function normalizePlanId(raw: string | undefined): PlanId {
  if (raw && isPlanId(raw)) return raw;
  return "alpha";
}

export function isBillablePlan(plan: PlanId): boolean {
  return BILLABLE.includes(plan);
}

export interface CreditPack {
  readonly key: "pack20" | "pack50" | "pack100";
  readonly dollars: number;
  readonly envVar: string;
  readonly creditCents: number;
}

/** Same packs and env names as MAX's shared credit-pack list. */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { key: "pack20", dollars: 20, envVar: "STRIPE_PRICE_CREDITS_20", creditCents: 2000 },
  { key: "pack50", dollars: 50, envVar: "STRIPE_PRICE_CREDITS_50", creditCents: 5000 },
  { key: "pack100", dollars: 100, envVar: "STRIPE_PRICE_CREDITS_100", creditCents: 10_000 },
];

export function getCreditPack(key: string): CreditPack | undefined {
  return CREDIT_PACKS.find((pack) => pack.key === key);
}

export function isCreditPackEligible(plan: PlanId): boolean {
  return plan === "alpha" || plan === "omega";
}

export function getCreditPackPriceId(key: CreditPack["key"]): string | null {
  const pack = getCreditPack(key);
  if (!pack) return null;
  const price = process.env[pack.envVar];
  return price && price.length > 0 ? price : null;
}

/** Stored plan, unless an entitlement override is set. Stripe status is informational. */
export function resolveEffectivePlan(user: {
  readonly plan: string;
  readonly entitlementOverride: string | null;
}): PlanId {
  if (user.entitlementOverride && isPlanId(user.entitlementOverride))
    return user.entitlementOverride;
  if (isPlanId(user.plan)) return user.plan;
  return "beta";
}
