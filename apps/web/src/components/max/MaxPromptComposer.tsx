import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { TraitsPicker } from "../chat/TraitsPicker";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import {
  clearCouncilSynthesizer,
  councilContenderCountByInstance,
  councilContenderKey,
  removeCouncilContender,
  setCouncilSynthesizer,
  setCouncilSynthesizerOptions,
  toggleCouncilContender,
  type CouncilContender,
  type CouncilSelection,
} from "./councilSelection";

type CouncilSelectionUpdate = (update: (selection: CouncilSelection) => CouncilSelection) => void;

const SEND_REASON_ID = "max-council-send-reason";

/**
 * Council prompt, contenders and Synthesizer. Rounds do not run yet, so Send stays off
 * and says why; nothing here pretends to submit.
 */
export function MaxPromptComposer({
  selection,
  onSelectionChange,
}: {
  readonly selection: CouncilSelection;
  readonly onSelectionChange: CouncilSelectionUpdate;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [prompt, setPrompt] = useState("");
  // Same pick as T3's stock landing. Switching projects stays in Agent mode for now.
  const project = sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null;
  const environmentId = project?.environmentId ?? primaryEnvironmentId;

  return (
    <section aria-labelledby="max-council-heading">
      <h1 id="max-council-heading" className="text-sm font-semibold">
        Council
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-(--max-muted)">
        Ask several models the same question, then have one model combine their answers.
      </p>
      <div className="mt-4 rounded-sm border border-(--max-line-strong) focus-within:border-(--max-green)">
        <label htmlFor="max-council-prompt" className="sr-only">
          Question for the council
        </label>
        <textarea
          id="max-council-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          placeholder="Ask the council…"
          className="block min-h-24 w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-(--max-muted)"
        />
        <div className="border-t border-(--max-line) px-3 py-2.5">
          {environmentId === null ? (
            <p className="text-xs text-(--max-muted)">Connect a computer to choose models.</p>
          ) : (
            <CouncilModelControls
              environmentId={environmentId}
              projectId={project?.id ?? null}
              selection={selection}
              onSelectionChange={onSelectionChange}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--max-line) px-3 py-2.5">
          <p className="min-w-0 text-xs text-(--max-muted)">
            {project === null
              ? "No project yet."
              : `Project: ${project.title}. Switch projects in Agent mode.`}
          </p>
          <div className="flex items-center gap-3">
            <p id={SEND_REASON_ID} className="text-xs text-(--max-muted)">
              Council rounds can’t run yet, so sending is off.
            </p>
            <button
              type="button"
              disabled
              aria-describedby={SEND_REASON_ID}
              className="rounded-sm border border-(--max-line-strong) px-3 py-1.5 text-xs text-(--max-muted) disabled:cursor-not-allowed"
            >
              Send to council
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CouncilModelControls({
  environmentId,
  projectId,
  selection,
  onSelectionChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly selection: CouncilSelection;
  readonly onSelectionChange: CouncilSelectionUpdate;
}) {
  const navigate = useNavigate();
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(environmentId);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const modelOptions = getCustomModelOptionsByInstance(settings, providers);
  const defaultSelection = resolveDefaultProviderModelSelection(
    providers,
    settings.defaultModelSelection,
  );

  if (entries.length === 0 || defaultSelection === null) {
    return (
      <p className="text-xs text-(--max-muted)">
        No models are available yet. Set up a provider in Settings.
      </p>
    );
  }

  const openProviderSetup = (instanceId: ProviderInstanceId) => {
    void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
  };
  const toggleContender = (instanceId: ProviderInstanceId, model: string) => {
    onSelectionChange((current) => toggleCouncilContender(current, instanceId, model));
  };
  const describe = (contender: CouncilContender) => {
    const option = modelOptions
      .get(contender.instanceId)
      ?.find((candidate) => candidate.slug === contender.model);
    const lab = entries.find((entry) => entry.instanceId === contender.instanceId)?.displayName;
    const name = option ? getDisplayModelName(option) : contender.model;
    return lab ? `${name} · ${lab}` : name;
  };
  const firstContender = selection.contenders[0];
  const synthesizer = selection.synthesizer;
  const synthesizerEntry = synthesizer
    ? entries.find((entry) => entry.instanceId === synthesizer.instanceId)
    : undefined;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={firstContender?.instanceId ?? defaultSelection.instanceId}
          model={firstContender?.model ?? ""}
          selectedModels={selection.contenders}
          selectionMode="council"
          selectedCountByInstance={councilContenderCountByInstance(selection)}
          onToggleModel={toggleContender}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptions}
          triggerAriaLabel="Choose contender models"
          onOpenProviderSetup={openProviderSetup}
          onInstanceModelChange={toggleContender}
        />
        <span className="text-xs text-(--max-muted)">Synthesizer</span>
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={synthesizer?.instanceId ?? defaultSelection.instanceId}
          model={synthesizer?.model ?? ""}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptions}
          {...(synthesizer === null ? { triggerLabel: "Choose a model" } : {})}
          triggerAriaLabel="Choose synthesizer model"
          onOpenProviderSetup={openProviderSetup}
          onInstanceModelChange={(instanceId, model) =>
            onSelectionChange((current) => setCouncilSynthesizer(current, instanceId, model))
          }
        />
        {synthesizer && synthesizerEntry ? (
          // Only the Synthesizer has traits for now; contenders keep their defaults until rounds run.
          <TraitsPicker
            provider={synthesizerEntry.driverKind}
            instanceId={synthesizer.instanceId}
            models={synthesizerEntry.models}
            model={synthesizer.model}
            modelOptions={synthesizer.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={settings.planModeEnabled}
            onModelOptionsChange={(options) =>
              onSelectionChange((current) => setCouncilSynthesizerOptions(current, options))
            }
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {selection.contenders.length === 0 ? (
          <p className="text-xs text-(--max-muted)">No contenders picked yet.</p>
        ) : (
          <ul aria-label="Contenders" className="flex flex-wrap gap-1.5">
            {selection.contenders.map((contender) => {
              const label = describe(contender);
              return (
                <li
                  key={councilContenderKey(contender)}
                  className="inline-flex items-center gap-1 rounded-sm border border-(--max-line-strong) py-0.5 pr-0.5 pl-2 text-xs"
                >
                  {label}
                  <button
                    type="button"
                    aria-label={`Remove ${label}`}
                    className="rounded-xs p-0.5 text-(--max-muted) hover:text-(--max-light)"
                    onClick={() =>
                      onSelectionChange((current) =>
                        removeCouncilContender(current, contender.instanceId, contender.model),
                      )
                    }
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {synthesizer ? (
          <span className="inline-flex items-center gap-1 rounded-sm border border-(--max-amber) py-0.5 pr-0.5 pl-2 text-xs text-(--max-amber)">
            Synthesizer: {describe(synthesizer)}
            <button
              type="button"
              aria-label="Clear synthesizer"
              className="rounded-xs p-0.5 hover:text-(--max-light)"
              onClick={() => onSelectionChange(clearCouncilSynthesizer)}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
