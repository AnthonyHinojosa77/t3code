import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { modelPickerModelKey } from "../chat/modelPickerKeys";

/** A model that answers in a council round, with independent traits. */
export interface CouncilContender {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly options?: ModelSelection["options"];
  readonly roleId?: string | null;
}

export interface CouncilSelection {
  /** In the order they were picked. */
  readonly contenders: ReadonlyArray<CouncilContender>;
  /** Any model, including one that is also a contender. Carries its own traits. */
  readonly synthesizer: ModelSelection | null;
}

export const EMPTY_COUNCIL_SELECTION: CouncilSelection = { contenders: [], synthesizer: null };

/** The model picker's own row key, so council state and picker rows agree on identity. */
export function councilContenderKey(contender: CouncilContender): string {
  return modelPickerModelKey(contender.instanceId, contender.model);
}

export function isCouncilContender(
  selection: CouncilSelection,
  instanceId: ProviderInstanceId,
  model: string,
): boolean {
  const key = modelPickerModelKey(instanceId, model);
  return selection.contenders.some((contender) => councilContenderKey(contender) === key);
}

/** Adds the model at the end, or removes it; the others keep their order. */
export function toggleCouncilContender(
  selection: CouncilSelection,
  instanceId: ProviderInstanceId,
  model: string,
): CouncilSelection {
  if (isCouncilContender(selection, instanceId, model)) {
    return removeCouncilContender(selection, instanceId, model);
  }
  return { ...selection, contenders: [...selection.contenders, { instanceId, model }] };
}

export function removeCouncilContender(
  selection: CouncilSelection,
  instanceId: ProviderInstanceId,
  model: string,
): CouncilSelection {
  const key = modelPickerModelKey(instanceId, model);
  const contenders = selection.contenders.filter(
    (contender) => councilContenderKey(contender) !== key,
  );
  return contenders.length === selection.contenders.length
    ? selection
    : { ...selection, contenders };
}

export function councilContenderCountByInstance(
  selection: CouncilSelection,
): ReadonlyMap<ProviderInstanceId, number> {
  const counts = new Map<ProviderInstanceId, number>();
  for (const contender of selection.contenders) {
    counts.set(contender.instanceId, (counts.get(contender.instanceId) ?? 0) + 1);
  }
  return counts;
}

/** Choosing a different model starts from that model's default traits. */
export function setCouncilSynthesizer(
  selection: CouncilSelection,
  instanceId: ProviderInstanceId,
  model: string,
): CouncilSelection {
  const current = selection.synthesizer;
  if (current?.instanceId === instanceId && current.model === model) return selection;
  return { ...selection, synthesizer: createModelSelection(instanceId, model) };
}

export function setCouncilSynthesizerOptions(
  selection: CouncilSelection,
  options: ModelSelection["options"] | undefined,
): CouncilSelection {
  const current = selection.synthesizer;
  if (current === null) return selection;
  return {
    ...selection,
    synthesizer: createModelSelection(current.instanceId, current.model, options ?? null),
  };
}

export function clearCouncilSynthesizer(selection: CouncilSelection): CouncilSelection {
  return selection.synthesizer === null ? selection : { ...selection, synthesizer: null };
}

export function updateCouncilContender(
  selection: CouncilSelection,
  contender: CouncilContender,
  patch: Pick<CouncilContender, "options" | "roleId">,
): CouncilSelection {
  return {
    ...selection,
    contenders: selection.contenders.map((entry) =>
      councilContenderKey(entry) === councilContenderKey(contender)
        ? { ...entry, ...patch }
        : entry,
    ),
  };
}
