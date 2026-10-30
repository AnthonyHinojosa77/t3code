import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelPickerModelKey } from "../chat/modelPickerKeys";
import {
  EMPTY_COUNCIL_SELECTION,
  clearCouncilSynthesizer,
  councilContenderCountByInstance,
  councilContenderKey,
  isCouncilContender,
  removeCouncilContender,
  setCouncilSynthesizer,
  setCouncilSynthesizerOptions,
  toggleCouncilContender,
  updateCouncilContender,
} from "./councilSelection";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const effortHigh = [{ id: "effort", value: "high" }] as const;

function pick(...picks: ReadonlyArray<readonly [ProviderInstanceId, string]>) {
  return picks.reduce(
    (selection, [instanceId, model]) => toggleCouncilContender(selection, instanceId, model),
    EMPTY_COUNCIL_SELECTION,
  );
}

describe("council contenders", () => {
  it("adds picks in order across labs", () => {
    const selection = pick([claude, "opus"], [codex, "gpt-5"], [claude, "sonnet"]);
    expect(selection.contenders).toEqual([
      { instanceId: claude, model: "opus" },
      { instanceId: codex, model: "gpt-5" },
      { instanceId: claude, model: "sonnet" },
    ]);
  });

  it("toggling a picked model removes it and keeps the others in order", () => {
    const selection = toggleCouncilContender(
      pick([claude, "opus"], [codex, "gpt-5"], [claude, "sonnet"]),
      codex,
      "gpt-5",
    );
    expect(selection.contenders).toEqual([
      { instanceId: claude, model: "opus" },
      { instanceId: claude, model: "sonnet" },
    ]);
  });

  it("treats the same slug on another instance as a different contender", () => {
    const selection = pick([claude, "shared"], [codex, "shared"]);
    expect(selection.contenders).toHaveLength(2);
    expect(isCouncilContender(selection, claude, "shared")).toBe(true);
    expect(isCouncilContender(selection, codex, "other")).toBe(false);
  });

  it("uses the model picker's own row key", () => {
    expect(councilContenderKey({ instanceId: codex, model: "gpt-5" })).toBe(
      modelPickerModelKey(codex, "gpt-5"),
    );
  });

  it("removes one contender and leaves a missing one unchanged", () => {
    const selection = pick([claude, "opus"], [codex, "gpt-5"]);
    expect(removeCouncilContender(selection, claude, "opus").contenders).toEqual([
      { instanceId: codex, model: "gpt-5" },
    ]);
    expect(removeCouncilContender(selection, claude, "haiku")).toBe(selection);
  });

  it("counts contenders per instance", () => {
    const counts = councilContenderCountByInstance(
      pick([claude, "opus"], [codex, "gpt-5"], [claude, "sonnet"]),
    );
    expect(counts.get(claude)).toBe(2);
    expect(counts.get(codex)).toBe(1);
    expect(councilContenderCountByInstance(EMPTY_COUNCIL_SELECTION).size).toBe(0);
  });
});

describe("council synthesizer", () => {
  it("can be a model that is already a contender", () => {
    const selection = setCouncilSynthesizer(pick([claude, "opus"]), claude, "opus");
    expect(selection.synthesizer).toEqual({ instanceId: claude, model: "opus" });
    expect(isCouncilContender(selection, claude, "opus")).toBe(true);
  });

  it("does not change contenders", () => {
    const contenders = pick([claude, "opus"], [codex, "gpt-5"]);
    expect(setCouncilSynthesizer(contenders, codex, "gpt-5").contenders).toBe(
      contenders.contenders,
    );
  });

  it("keeps traits when the same model is chosen again, and resets them for a new model", () => {
    const withTraits = setCouncilSynthesizerOptions(
      setCouncilSynthesizer(EMPTY_COUNCIL_SELECTION, claude, "opus"),
      effortHigh,
    );
    expect(withTraits.synthesizer?.options).toEqual(effortHigh);
    expect(setCouncilSynthesizer(withTraits, claude, "opus")).toBe(withTraits);
    expect(setCouncilSynthesizer(withTraits, codex, "gpt-5").synthesizer).toEqual({
      instanceId: codex,
      model: "gpt-5",
    });
  });

  it("drops traits when they are cleared", () => {
    const withTraits = setCouncilSynthesizerOptions(
      setCouncilSynthesizer(EMPTY_COUNCIL_SELECTION, claude, "opus"),
      effortHigh,
    );
    expect(setCouncilSynthesizerOptions(withTraits, undefined).synthesizer).toEqual({
      instanceId: claude,
      model: "opus",
    });
  });

  it("ignores traits when there is no synthesizer", () => {
    expect(setCouncilSynthesizerOptions(EMPTY_COUNCIL_SELECTION, effortHigh)).toBe(
      EMPTY_COUNCIL_SELECTION,
    );
  });

  it("clears without touching contenders", () => {
    const selection = setCouncilSynthesizer(pick([claude, "opus"]), codex, "gpt-5");
    const cleared = clearCouncilSynthesizer(selection);
    expect(cleared.synthesizer).toBeNull();
    expect(cleared.contenders).toBe(selection.contenders);
    expect(clearCouncilSynthesizer(cleared)).toBe(cleared);
  });
});

it("keeps each contender's traits and role independent", () => {
  const selected = pick([claude, "opus"], [codex, "gpt-5"]);
  const updated = updateCouncilContender(selected, selected.contenders[0]!, {
    options: effortHigh,
    roleId: "critic",
  });
  expect(updated.contenders[0]?.options).toEqual(effortHigh);
  expect(updated.contenders[0]?.roleId).toBe("critic");
  expect(updated.contenders[1]).toBe(selected.contenders[1]);
  expect(updated.synthesizer).toBeNull();
});
