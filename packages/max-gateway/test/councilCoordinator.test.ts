import { describe, it, expect, vi } from "vite-plus/test";
import { fixture, input, FakeEngine } from "./councilTestHelpers.ts";
import { CouncilCoordinator, parseSynthesis } from "../src/council/councilCoordinator.ts";
import { COUNCIL_PREFACE } from "../src/council/roleTemplates.ts";
const structured = { consensus: ["a"], disagreements: [], verdict: "v", uncertainties: [] };
describe("council coordinator", () => {
  it("starts contenders in parallel, persists partial text/attention, and automatically synthesizes", async () => {
    using f = fixture();
    const r = f.coordinator.create(input);
    await Promise.resolve();
    expect(f.engine.launches).toHaveLength(2);
    expect(f.engine.launches[0]?.prompt).toBe(COUNCIL_PREFACE + "\n\n" + input.prompt);
    expect(f.store.get(r.id).contenders[0]?.runtimeMode).toBe("auto");
    expect(f.engine.launches[0]?.model.options).toEqual(input.contenders[0]?.options);
    const ids = r.contenders.map((c) => c.threadId!);
    f.engine.update(ids[0]!, "needs-attention", "partial");
    expect(f.store.get(r.id).contenders[0]).toMatchObject({
      status: "needs-attention",
      text: "partial",
    });
    f.engine.update(ids[0]!, "complete", "first");
    f.engine.update(ids[1]!, "complete", "second");
    await Promise.resolve();
    const s = f.store.get(r.id);
    expect(s.status).toBe("synthesizing");
    expect(f.engine.launches[2]?.prompt).toContain("first");
    expect(f.store.get(r.id).synthesis.runtimeMode).toBe("auto");
    f.engine.update(s.synthesis.threadId!, "complete", JSON.stringify(structured));
    expect(f.store.get(r.id).synthesis.structured).toEqual(structured);
    expect(f.store.get(r.id).status).toBe("complete");
  });
  it("skips synthesis when every contender fails", async () => {
    using f = fixture();
    const r = f.coordinator.create(input);
    await Promise.resolve();
    for (const c of r.contenders) f.engine.update(c.threadId!, "failed");
    expect(f.store.get(r.id)).toMatchObject({ status: "failed", synthesis: { status: "skipped" } });
  });
  it("times out attention and interrupts its threads", async () => {
    vi.useFakeTimers();
    try {
      using f = fixture();
      const r = f.coordinator.create(input);
      await Promise.resolve();
      f.engine.update(r.contenders[0]!.threadId!, "needs-attention");
      await vi.advanceTimersByTimeAsync(1001);
      expect(f.store.get(r.id).contenders.every((c) => c.status === "timed-out")).toBe(true);
      expect(f.engine.interrupts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancel stops running contenders without starting synthesis", async () => {
    using f = fixture();
    const r = f.coordinator.create(input);
    await Promise.resolve();
    expect(f.coordinator.cancel(r.id).status).toBe("cancelled");
    expect(f.engine.interrupts).toHaveLength(2);
    expect(f.engine.launches).toHaveLength(2);
  });
  it("resumes persisted threads and starts due synthesis without a GET", async () => {
    using f = fixture();
    const r = f.coordinator.create(input);
    await Promise.resolve();
    f.coordinator.close();
    const engine = new FakeEngine();
    const c = new CouncilCoordinator(f.store, f.templates, engine);
    c.resume();
    expect(engine.launches).toHaveLength(2);
    await Promise.resolve();
    for (const row of r.contenders) engine.update(row.threadId!, "complete");
    await Promise.resolve();
    expect(engine.launches).toHaveLength(3);
    c.close();
  });
  it.each([
    JSON.stringify(structured),
    "```json\n" + JSON.stringify(structured) + "\n```",
    "garbage " + JSON.stringify(structured) + " tail",
  ])("parses synthesis %s", (text) => {
    expect(parseSynthesis(text)).toEqual(structured);
  });
  it("keeps invalid synthesis as raw text", async () => {
    using f = fixture();
    const r = f.coordinator.create(input);
    await Promise.resolve();
    for (const c of r.contenders) f.engine.update(c.threadId!, "complete");
    await Promise.resolve();
    f.engine.update(f.store.get(r.id).synthesis.threadId!, "complete", "not JSON");
    expect(f.store.get(r.id)).toMatchObject({
      status: "complete",
      synthesis: { structured: null, text: "not JSON" },
    });
  });
});

it("places the council preface exactly once before role text", async () => {
  using f = fixture();
  const r = f.coordinator.create(input);
  await Promise.resolve();
  f.coordinator.close();
  r.status = "cancelled";
  f.store.save(r);
  const template = f.store.template(r.id);
  r.id += "-role";
  r.status = "running";
  template.roles = [{ id: "critic", name: "Critic", instruction: "Find risks" }];
  r.contenders[0]!.roleId = "critic";
  f.store.save(r, template);
  const engine = new FakeEngine();
  const coordinator = new CouncilCoordinator(f.store, f.templates, engine);
  try {
    coordinator.resume();
    expect(engine.launches[0]?.prompt).toBe(COUNCIL_PREFACE + "\n\nFind risks\n\n" + input.prompt);
    expect(engine.launches[0]?.prompt.split(COUNCIL_PREFACE)).toHaveLength(2);
  } finally {
    coordinator.close();
  }
});
