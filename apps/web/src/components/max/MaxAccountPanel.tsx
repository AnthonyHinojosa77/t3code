import { useEffect, useState } from "react";

interface PlanStatus {
  plan: string;
  planName: string;
  planDescription: string;
  dailyTurnCap: number | null;
  turnsUsedToday: number;
  capped: boolean;
  usagePercent: number;
  threshold: "normal" | "half" | "high" | "capped";
  creditBalanceCents?: number;
}

/**
 * Hidden in personal mode. Task 2 mounts this. No route is added here.
 * Field names match the plan-status payload MAX's account panel reads.
 */
export function MaxAccountPanel() {
  const [personalMode, setPersonalMode] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<PlanStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await fetch("/api/auth/me", { credentials: "include" });
      if (!me.ok || cancelled) return;
      const current = (await me.json()) as { personalMode?: boolean; user?: { email?: string } };
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
    <section className="bg-[#0a0a0a] p-4 font-mono text-[#f5f5f5]">
      <h1 className="text-xs tracking-widest text-[#00ff41]">ACCOUNT</h1>
      <p className="mt-3 text-sm">{plan?.planName ?? "Plan"}</p>
      <p className="mt-1 text-[10px] tracking-wide text-[#737373]">{plan?.planDescription}</p>
      <p className="mt-3 text-[10px] tracking-widest text-[#737373]">
        USAGE {plan?.usagePercent ?? 0}% {plan?.capped ? "CAPPED" : plan?.threshold?.toUpperCase()}
      </p>
      <div className="mt-2 h-1 w-full bg-[#222]">
        <div className="h-1 bg-[#00ff41]" style={{ width: `${plan?.usagePercent ?? 0}%` }} />
      </div>
      <p className="mt-2 text-[10px] text-[#737373]">
        Turns today {plan?.turnsUsedToday ?? 0}
        {plan?.dailyTurnCap === null ? " / no cap" : ` / ${plan?.dailyTurnCap ?? 0}`}
      </p>
    </section>
  );
}
