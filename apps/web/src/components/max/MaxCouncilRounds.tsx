import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { usePrimaryEnvironmentId, useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { getDisplayModelName } from "../chat/providerIconUtils";
import {
  councilApi,
  isRoundActive,
  useCouncilRound,
  type CouncilRoundSummary,
  type CouncilTemplate,
} from "./councilApi";
import { EMPTY_COUNCIL_SELECTION } from "./councilSelection";
import { MaxPromptComposer } from "./MaxPromptComposer";
import { MaxResponseGrid } from "./MaxResponseGrid";
import { MaxSynthesisPanel } from "./MaxSynthesisPanel";
import { writeMaxMode } from "./maxMode";

export function relativeRoundTime(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
export function MaxCouncilRounds({ roundId }: { roundId: string | undefined }) {
  const navigate = useNavigate();
  const [selection, setSelection] = useState(EMPTY_COUNCIL_SELECTION);
  const [home, setHome] = useState<{
    templates: CouncilTemplate[];
    rounds: CouncilRoundSummary[];
    error: string | null;
  }>({ templates: [], rounds: [], error: null });
  const [revision, setRevision] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const { round, error } = useCouncilRound(roundId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const providers = useEnvironmentProviders();
  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize the visible home with persisted HTTP templates and rounds.
  useEffect(() => {
    if (roundId) return;

    const controller = new AbortController();
    void Promise.all([
      councilApi.templates(controller.signal),
      councilApi.rounds(controller.signal),
    ])
      .then(([templates, rounds]) => {
        if (!controller.signal.aborted) setHome({ ...templates, ...rounds, error: null });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setHome((current) => ({
            ...current,
            error: cause instanceof Error ? cause.message : "Couldn’t load council",
          }));
      });
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit refresh after template mutations and connection retry.
  }, [roundId, revision]);
  const openRound = (id: string, environmentId?: EnvironmentId) => {
    if (environmentId) sessionStorage.setItem(`max.round.environment.${id}`, environmentId);
    void navigate({ to: "/", search: { round: id } });
  };
  const describe = (instanceId: string, model: string) => {
    for (const entries of providers.values()) {
      const provider = entries.find((entry) => entry.instanceId === instanceId);
      const option = provider?.models.find((entry) => entry.slug === model);
      if (option && provider)
        return getDisplayModelName(option) + " · " + resolveProviderInstanceDisplayName(provider);
    }
    return model;
  };
  const continueThread = (threadId: string) => {
    if (!roundId || !round) return;
    const environmentId =
      projects.find((entry) => entry.id === round.projectId)?.environmentId ??
      sessionStorage.getItem(`max.round.environment.${roundId}`) ??
      primaryEnvironmentId;
    if (!environmentId) {
      setActionError("Connect the council’s computer to open this thread.");
      return;
    }
    sessionStorage.setItem(
      `max.returnRound:/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
      roundId,
    );
    writeMaxMode("agent");
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
  if (!roundId)
    return (
      <>
        <MaxPromptComposer
          selection={selection}
          onSelectionChange={setSelection}
          templates={home.templates}
          apiError={home.error}
          onRefresh={() => setRevision((value) => value + 1)}
          onCreated={openRound}
        />
        {home.error && (
          <div role="alert">
            <p>{home.error}</p>
            <button
              type="button"
              className="max-council-button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry connection
            </button>
          </div>
        )}
        <section aria-labelledby="max-rounds-heading">
          <h2 id="max-rounds-heading" className="mb-3 text-sm font-semibold">
            Recent rounds
          </h2>
          {home.rounds.length ? (
            <ul className="divide-y divide-(--max-line) rounded-sm border border-(--max-line)">
              {home.rounds.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="w-full p-4 text-left hover:bg-(--max-line)"
                    onClick={() => openRound(entry.id)}
                  >
                    <p className="line-clamp-2 break-words text-sm">{entry.prompt}</p>
                    <p className="mt-2 text-xs text-(--max-muted)">
                      {entry.status} · {entry.templateName} · {relativeRoundTime(entry.createdAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-(--max-muted)">Your council rounds will appear here.</p>
          )}
        </section>
      </>
    );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="max-council-button"
          onClick={() => {
            void navigate({ to: "/", search: {} });
          }}
        >
          New question
        </button>
        {round && (
          <span className="text-xs text-(--max-muted)">
            {round.status} · {round.templateName}
          </span>
        )}
      </div>
      {(error || actionError) && (
        <p role="alert" className="text-(--max-amber)">
          {error ?? actionError}
        </p>
      )}
      {!round ? (
        !error && <p>Loading council round…</p>
      ) : (
        <>
          <h1 className="text-lg leading-relaxed break-words">{round.prompt}</h1>
          <MaxResponseGrid
            contenders={round.contenders}
            describe={describe}
            onContinue={continueThread}
          />
          <MaxSynthesisPanel
            synthesis={round.synthesis}
            displayName={describe(round.synthesis.instanceId, round.synthesis.model)}
            onContinue={continueThread}
          />
          {isRoundActive(round.status) && (
            <button
              type="button"
              className="max-council-button self-start"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                setActionError(null);
                void councilApi
                  .cancelRound(round.id)
                  .catch((cause) =>
                    setActionError(
                      cause instanceof Error ? cause.message : "Couldn’t cancel round",
                    ),
                  )
                  .finally(() => setCancelling(false));
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel round"}
            </button>
          )}
        </>
      )}
    </>
  );
}
