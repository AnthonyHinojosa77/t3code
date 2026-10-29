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
    <section className="bg-[#0a0a0a] px-4 py-10 font-mono text-[#f5f5f5]">
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="text-2xl font-bold tracking-widest">MAX PRICING</h1>
        <p className="mt-2 text-xs tracking-widest text-[#737373]">
          {plan?.planName ? `Current plan: ${plan.planName}` : "Plans"}
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-4">
          {PLAN_NAMES.map((name) => (
            <article key={name} className="rounded border border-[#333] bg-[#111] p-4">
              <h2 className="text-xs tracking-widest text-[#00ff41]">{name.toUpperCase()}</h2>
              <p className="mt-2 text-[10px] tracking-wide text-[#737373]">
                {plan?.planName === name ? "CURRENT" : "SAVED BILLING"}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
