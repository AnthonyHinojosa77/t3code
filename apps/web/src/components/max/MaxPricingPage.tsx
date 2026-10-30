import { useEffect, useState } from "react";

interface PlanStatus {
  plan: string;
  planName: string;
  planDescription?: string;
  capped?: boolean;
  usagePercent?: number;
}

const PLAN_NAMES = ["Beta", "Alpha", "Omega", "Sigma"] as const;

/**
 * Hidden in personal mode. Task 2 mounts this. No route is added here.
 * Checkout is not started from this screen, so a missing Stripe key cannot
 * produce a made-up payment URL.
 */
export function MaxPricingPage() {
  const [personalMode, setPersonalMode] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<PlanStatus | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize the account view with the remote session and plan.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await fetch("/api/auth/me", { credentials: "include" });
      if (!me.ok || cancelled) return;
      const current = (await me.json()) as { personalMode?: boolean };
      if (current.personalMode === true) {
        if (!cancelled) setPersonalMode(true);
        return;
      }
      if (!cancelled) setPersonalMode(false);
      const status = await fetch("/api/auth/plan-status", { credentials: "include" });
      if (!status.ok || cancelled) return;
      setPlan((await status.json()) as PlanStatus);
    })().catch(() => {
      if (!cancelled) setPersonalMode(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (personalMode !== false) return null;

  return (
    <section className="max-scope bg-(--max-black) px-4 py-10 font-mono text-(--max-bright)">
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="text-2xl font-bold tracking-widest">MAX PRICING</h1>
        <p className="mt-2 text-xs tracking-widest text-(--max-muted)">
          {plan?.planName ? `Current plan: ${plan.planName}` : "Plans"}
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-4">
          {PLAN_NAMES.map((name) => (
            <article
              key={name}
              className="rounded border border-(--max-form-border) bg-(--max-panel) p-4"
            >
              <h2 className="text-xs tracking-widest text-(--max-green)">{name.toUpperCase()}</h2>
              <p className="mt-2 text-3xs/normal tracking-wide text-(--max-muted)">
                {plan?.planName === name ? "CURRENT" : "SAVED BILLING"}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
