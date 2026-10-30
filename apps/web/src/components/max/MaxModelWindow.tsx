import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Dialog } from "@base-ui/react/dialog";
import type { CouncilTemplate } from "./councilApi";
import {
  clearCouncilSynthesizer,
  councilContenderCountByInstance,
  councilContenderKey,
  removeCouncilContender,
  setCouncilSynthesizer,
  setCouncilSynthesizerOptions,
  toggleCouncilContender,
  updateCouncilContender,
  type CouncilContender,
  type CouncilSelection,
} from "./councilSelection";
import { RoleTemplatePicker } from "./RoleTemplatePicker";

export type CouncilSelectionUpdate = (
  update: (selection: CouncilSelection) => CouncilSelection,
) => void;

export interface ProjectChoice {
  readonly key: string;
  readonly title: string;
}

/**
 * The "model window": every model decision in one place. Contenders with their traits and
 * roles, the synthesizer, the template and the project folder. Opens as a sheet on phones.
 */
export function MaxModelWindow({
  open,
  onOpenChange,
  environmentId,
  projectId,
  template,
  templates,
  selection,
  onSelectionChange,
  onTemplateChange,
  onRefreshTemplates,
  projectKey,
  projects,
  onProjectChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly template: CouncilTemplate | undefined;
  readonly templates: CouncilTemplate[];
  readonly selection: CouncilSelection;
  readonly onSelectionChange: CouncilSelectionUpdate;
  readonly onTemplateChange: (id: string) => void;
  readonly onRefreshTemplates: () => void;
  readonly projectKey: string;
  readonly projects: ReadonlyArray<ProjectChoice>;
  readonly onProjectChange: (key: string) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="max-scope max-council-overlay max-model-backdrop" />
        <Dialog.Popup
          className="max-scope max-model-window"
          aria-labelledby="max-model-window-title"
          data-max-model-window=""
        >
          <div className="max-model-window-header">
            <Dialog.Title id="max-model-window-title" className="max-model-window-title">
              Models
            </Dialog.Title>
            <p className="text-xs text-(--max-muted)">
              Pick who answers, who judges, and how hard each one thinks.
            </p>
            <Dialog.Close className="max-icon-button max-model-window-close" aria-label="Close">
              <XIcon aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </div>
          <div className="max-model-window-body">
            {environmentId === null ? (
              <p className="text-sm text-(--max-muted)">Connect a computer to choose models.</p>
            ) : (
              <CouncilModelControls
                template={template}
                environmentId={environmentId}
                projectId={projectId}
                selection={selection}
                onSelectionChange={onSelectionChange}
              />
            )}
            <section className="max-model-section" aria-labelledby="max-round-settings">
              <h3 id="max-round-settings" className="max-model-section-title">
                Round
              </h3>
              <RoleTemplatePicker
                templates={templates}
                value={template?.id ?? ""}
                onRefresh={onRefreshTemplates}
                onChange={onTemplateChange}
              />
              <label className="max-field-label">
                Project folder
                <select
                  aria-label="Project folder"
                  value={projectKey}
                  onChange={(event) => onProjectChange(event.target.value)}
                >
                  <option value="">No project</option>
                  {projects.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function describeCouncilModel(
  entries: ReturnType<typeof sortProviderInstanceEntries>,
  modelOptions: ReturnType<typeof getCustomModelOptionsByInstance>,
  model: { instanceId: ProviderInstanceId; model: string },
): string {
  const option = modelOptions
    .get(model.instanceId)
    ?.find((candidate) => candidate.slug === model.model);
  const lab = entries.find((entry) => entry.instanceId === model.instanceId)?.displayName;
  const name = option ? getDisplayModelName(option) : model.model;
  return lab ? `${name} · ${lab}` : name;
}

function CouncilModelControls({
  environmentId,
  template,
  projectId,
  selection,
  onSelectionChange,
}: {
  readonly template: CouncilTemplate | undefined;
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
      <p className="text-sm text-(--max-muted)">
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
  const describe = (contender: CouncilContender) =>
    describeCouncilModel(entries, modelOptions, contender);
  const firstContender = selection.contenders[0];
  const synthesizer = selection.synthesizer;
  const synthesizerEntry = synthesizer
    ? entries.find((entry) => entry.instanceId === synthesizer.instanceId)
    : undefined;

  return (
    <div className="max-council-models flex flex-col gap-5">
      <section className="max-model-section" aria-labelledby="max-contenders-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="max-contenders-heading" className="max-model-section-title">
            Contenders
          </h3>
          <ProviderModelPicker
            environmentId={environmentId}
            activeInstanceId={firstContender?.instanceId ?? defaultSelection.instanceId}
            model={firstContender?.model ?? ""}
            selectedModels={selection.contenders}
            selectionMode="council"
            selectedCountByInstance={councilContenderCountByInstance(selection)}
            onToggleModel={toggleContender}
            {...(selection.contenders.length === 0 ? { triggerLabel: "Add models" } : {})}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptions}
            triggerAriaLabel="Choose contender models"
            onOpenProviderSetup={openProviderSetup}
            onInstanceModelChange={toggleContender}
          />
        </div>
        {selection.contenders.length === 0 ? (
          <p className="text-xs text-(--max-muted)">No contenders picked yet.</p>
        ) : (
          <ul aria-label="Contenders" className="max-contender-list">
            {selection.contenders.map((contender, index) => {
              const entry = entries.find((entry) => entry.instanceId === contender.instanceId);
              const label = describe(contender);
              return (
                <li key={councilContenderKey(contender)} className="max-contender">
                  <span>{label}</span>
                  {entry && (
                    <TraitsPicker
                      provider={entry.driverKind}
                      instanceId={contender.instanceId}
                      models={entry.models}
                      model={contender.model}
                      modelOptions={contender.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={settings.planModeEnabled}
                      onModelOptionsChange={(options) =>
                        onSelectionChange((current) =>
                          updateCouncilContender(current, contender, { options }),
                        )
                      }
                    />
                  )}
                  {!!template?.roles.length && (
                    <select
                      aria-label={`Role for ${label}`}
                      value={
                        contender.roleId === undefined
                          ? (template.roles[index % template.roles.length]?.id ?? "")
                          : (contender.roleId ?? "")
                      }
                      onChange={(event) =>
                        onSelectionChange((current) =>
                          updateCouncilContender(current, contender, {
                            roleId: event.target.value || null,
                          }),
                        )
                      }
                    >
                      <option value="">No role</option>
                      {template.roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${label}`}
                    className="max-icon-button"
                    onClick={() =>
                      onSelectionChange((current) =>
                        removeCouncilContender(current, contender.instanceId, contender.model),
                      )
                    }
                  >
                    <XIcon aria-hidden="true" className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="max-model-section" aria-labelledby="max-synthesizer-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="max-synthesizer-heading" className="max-model-section-title">
            Synthesizer
          </h3>
          <div className="flex flex-wrap items-center gap-2">
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
        </div>
        {synthesizer ? (
          <p className="max-synthesizer-chip">
            <span>Synthesizer: {describe(synthesizer)}</span>
            <button
              type="button"
              aria-label="Clear synthesizer"
              className="max-icon-button"
              onClick={() => onSelectionChange(clearCouncilSynthesizer)}
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </button>
          </p>
        ) : (
          <p className="text-xs text-(--max-muted)">
            One model combines every answer into a verdict.
          </p>
        )}
      </section>
    </div>
  );
}

/** Short label for the composer's model button. */
export function summarizeCouncilSelection(
  selection: CouncilSelection,
  environmentId: EnvironmentId | null,
): string {
  if (environmentId === null) return "Connect a computer";
  const count = selection.contenders.length;
  if (count === 0) return "Choose models";
  return `${count} ${count === 1 ? "model" : "models"}${selection.synthesizer ? " · judge set" : " · no judge"}`;
}
