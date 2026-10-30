// A finished council round written straight into the harness's temporary council database, so
// page turns, ordering and both themes can be exercised without spending a model turn.
// The coordinator leaves terminal rounds alone on resume, so the companion serves it as saved.
const LONG_ANSWER = (lead) =>
  [
    `**${lead}**`,
    "",
    "Roll out behind a feature flag to one region first. Watch error rates and latency for a full business day before widening.",
    "",
    "1. Ship the flag off by default.",
    "2. Enable it for internal accounts and one friendly customer.",
    "3. Compare the two cohorts on the same dashboard; the rollback is flipping the flag.",
    "",
    "A staged rollout costs a few days but turns a launch into a series of small, reversible steps. Teams that skipped the staged step in the past recovered slower because the blast radius was the whole user base at once.",
    "",
    "Keep the old path alive until the new one has carried production traffic for a week. Delete it afterwards so nobody has to maintain two code paths.",
    "",
    "- Alerting: page on a 2x error-rate change against the control cohort.",
    "- Data: write to both stores during the overlap and compare nightly.",
    "- People: one owner per stage, named before the stage starts.",
    "",
    "If the metrics hold for seven days, widen to every region at once; the remaining risk is operational, not product.",
    "",
    "### What could still go wrong",
    "",
    "Billing pages carry legal copy and tax rules that differ by region, so the first region should be one whose rules the team already understands. A rollout that is technically clean can still surface a wrong tax line, and that is a customer-visible defect rather than an outage.",
    "",
    "Keep a written checklist for each stage: who flipped the flag, what the dashboards showed, and who signed off. The checklist is what lets the next stage start without a meeting.",
    "",
    "- Day 1: internal accounts only, every payment reconciled by hand.",
    "- Day 2 to 3: one friendly customer, reconciled nightly.",
    "- Day 4 to 7: one region, automated reconciliation with a daily summary.",
    "",
    "After the first week the plan is boring on purpose. Boring is the goal: a rollout nobody notices is a rollout that worked.",
  ].join("\n");

export function buildSeededRound(id, now = Date.now()) {
  const at = (seconds) => new Date(now + seconds * 1000).toISOString();
  const base = {
    options: null,
    runtimeMode: "auto",
    threadId: null,
    error: null,
    attachments: [],
  };
  return {
    id,
    prompt: "Seeded: which rollout plan is safest for the new billing page?",
    templateId: "meta-debate",
    templateName: "Meta-debate",
    projectId: null,
    status: "complete",
    createdAt: at(0),
    updatedAt: at(20),
    contenders: [
      {
        ...base,
        key: "c0",
        instanceId: "seed-codex",
        model: "gpt-6-luna",
        roleId: null,
        roleName: null,
        status: "complete",
        text: LONG_ANSWER("Second to finish: stage it by region."),
        startedAt: at(0),
        finishedAt: at(9),
      },
      {
        ...base,
        key: "c1",
        instanceId: "seed-claude",
        model: "claude-haiku-5-5",
        roleId: null,
        roleName: null,
        status: "complete",
        text: LONG_ANSWER("First to finish: flag it, then widen."),
        startedAt: at(0),
        finishedAt: at(3),
      },
      {
        ...base,
        key: "c2",
        instanceId: "seed-xai",
        model: "grok-4.7-build-fast",
        roleId: null,
        roleName: null,
        status: "failed",
        text: "",
        error: "Provider unavailable",
        startedAt: at(0),
        finishedAt: at(1),
      },
    ],
    synthesis: {
      ...base,
      instanceId: "seed-claude",
      model: "claude-haiku-5-5",
      status: "complete",
      format: "meta-debate",
      text: JSON.stringify({
        consensus: ["Use a feature flag and widen in stages."],
        disagreements: ["Whether one region or one customer is the right first step."],
        verdict: "Stage the rollout behind a flag; widen after a week of clean metrics.",
        uncertainties: ["How much traffic the first stage needs to be meaningful."],
      }),
      structured: {
        consensus: ["Use a feature flag and widen in stages."],
        disagreements: ["Whether one region or one customer is the right first step."],
        verdict: "Stage the rollout behind a flag; widen after a week of clean metrics.",
        uncertainties: ["How much traffic the first stage needs to be meaningful."],
      },
      startedAt: at(10),
      finishedAt: at(20),
    },
  };
}

/** Reading order the UI must show: first finisher, second finisher, the failure, the synthesis. */
export const SEEDED_PAGE_TITLES = [
  "claude-haiku-5-5",
  "gpt-6-luna",
  "grok-4.7-build-fast",
  "Synthesis · claude-haiku-5-5",
];
