import type { EnvironmentId } from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { useNavigate } from "@tanstack/react-router";
import { FileIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { councilApi, isRoundActive, useCouncilRound, type CouncilRound } from "./councilApi";
import {
  refreshCouncilHome,
  summarizeCouncilRound,
  syncCouncilRoundSummary,
  upsertCouncilRoundSummary,
  useCouncilHome,
} from "./councilHome";
import { answeredCount, buildCouncilPages, pageTitle, type CouncilPage } from "./councilPages";
import { EMPTY_COUNCIL_SELECTION } from "./councilSelection";
import { relativeRoundTime } from "./councilTime";
import { MaxComposer } from "./MaxComposer";
import { MaxPage } from "./MaxPage";
import { MaxPageStack } from "./MaxPageStack";
import { writeMaxMode } from "./maxMode";

function pageIds(pages: ReadonlyArray<CouncilPage>): string {
  return pages.map((page) => page.id).join("\u0000");
}

/** The chat window: the question, then the answers as pages, with the composer docked below. */
export function MaxCouncilRounds({ roundId }: { roundId: string | undefined }) {
  const navigate = useNavigate();
  const [selection, setSelection] = useState(EMPTY_COUNCIL_SELECTION);
  const home = useCouncilHome();
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const { round, error } = useCouncilRound(roundId, syncCouncilRoundSummary);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const providers = useEnvironmentProviders();
  // oxlint-disable-next-line t3code/react-effect-budget -- Templates and saved rounds live on the gateway; load them when the window opens. Later changes arrive through upserts.
  useEffect(() => {
    void refreshCouncilHome();
  }, []);
  const pages = round ? buildCouncilPages(round) : [];
  const ids = pageIds(pages);
  const [pageState, setPageState] = useState({ roundId, ids, index: 0 });
  if (pageState.roundId !== roundId) {
    setPageState({ roundId, ids, index: 0 });
  } else if (pageState.ids !== ids) {
    // Keep the reader on the page they were on; new pages only join behind.
    const previousIds = pageState.ids.split("\u0000");
    const currentId = previousIds[pageState.index];
    const nextIds = ids.split("\u0000");
    const found = currentId === undefined ? -1 : nextIds.indexOf(currentId);
    setPageState({
      roundId,
      ids,
      index: found >= 0 ? found : Math.min(pageState.index, Math.max(pages.length - 1, 0)),
    });
  }
  const pageIndex = Math.min(pageState.index, Math.max(pages.length - 1, 0));

  const openRound = (created: CouncilRound, environmentId: EnvironmentId) => {
    sessionStorage.setItem(`max.round.environment.${created.id}`, environmentId);
    upsertCouncilRoundSummary(summarizeCouncilRound(created));
    void navigate({ to: "/", search: { round: created.id } });
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
  const continueThread = async (threadId: string) => {
    if (!roundId || !round) return;
    const environmentId =
      projects.find((entry) => entry.id === round.projectId)?.environmentId ??
      sessionStorage.getItem(`max.round.environment.${roundId}`) ??
      primaryEnvironmentId;
    if (!environmentId) {
      setActionError("Connect the council’s computer to open this thread.");
      return;
    }
    setActionError(null);
    try {
      await councilApi.continueThread(roundId, threadId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not restore council thread");
      return;
    }
    sessionStorage.setItem(
      `max.returnRound:/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
      roundId,
    );
    writeMaxMode("agent");
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };

  return (
    <div className="max-window">
      <div className="max-window-body">
        {!roundId ? (
          <section className="max-home" aria-labelledby="max-council-heading">
            <h1 id="max-council-heading" className="max-home-title">
              Ask the council.
            </h1>
            <p className="max-home-copy">
              Several models answer the same question. The first to finish opens in front; turn the
              pages to read the others, then the synthesis.
            </p>
            {home.error ? (
              <div role="alert" className="max-alert">
                <p>{home.error}</p>
                <button
                  type="button"
                  className="max-button"
                  onClick={() => void refreshCouncilHome()}
                >
                  Retry connection
                </button>
              </div>
            ) : null}
          </section>
        ) : (
          <RoundTranscript
            round={round}
            error={error ?? actionError}
            pages={pages}
            pageIndex={pageIndex}
            onPageIndexChange={(index) => setPageState({ roundId, ids, index })}
            describe={describe}
            onContinue={continueThread}
            cancelling={cancelling}
            onCancel={() => {
              if (!round) return;
              setCancelling(true);
              setActionError(null);
              void councilApi
                .cancelRound(round.id)
                .catch((cause: unknown) =>
                  setActionError(cause instanceof Error ? cause.message : "Couldn’t cancel round"),
                )
                .finally(() => setCancelling(false));
            }}
          />
        )}
      </div>
      <MaxComposer
        selection={selection}
        onSelectionChange={setSelection}
        templates={home.templates}
        apiError={home.error}
        onRefresh={() => void refreshCouncilHome()}
        onCreated={openRound}
        placeholder={roundId ? "Ask a new question…" : "Ask the council…"}
      />
    </div>
  );
}

function RoundTranscript({
  round,
  error,
  pages,
  pageIndex,
  onPageIndexChange,
  describe,
  onContinue,
  cancelling,
  onCancel,
}: {
  readonly round: CouncilRound | null;
  readonly error: string | null;
  readonly pages: ReadonlyArray<CouncilPage>;
  readonly pageIndex: number;
  readonly onPageIndexChange: (index: number) => void;
  readonly describe: (instanceId: string, model: string) => string;
  readonly onContinue: (threadId: string) => void;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
}) {
  if (!round) {
    return error ? (
      <p role="alert" className="max-alert">
        {error}
      </p>
    ) : (
      <p className="max-muted-line">Loading council round…</p>
    );
  }
  const active = isRoundActive(round.status);
  const attachments = round.contenders[0]?.attachments ?? [];
  const answered = answeredCount(round);
  return (
    <div className="max-transcript">
      <div className="max-user-turn" data-testid="max-user-turn">
        <p className="max-user-text">{round.prompt}</p>
        {attachments.length ? (
          <ul aria-label="Files sent" className="max-user-files">
            {attachments.map((file) => (
              <li key={file.id}>
                <FileIcon aria-hidden="true" className="size-3.5" />
                {file.name}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="max-user-meta">
          <span data-round-status="">{round.status}</span> · {round.templateName} ·{" "}
          {relativeRoundTime(round.createdAt)}
        </p>
      </div>
      {error ? (
        <p role="alert" className="max-alert">
          {error}
        </p>
      ) : null}
      {pages.length === 0 ? (
        <section className="max-thinking" role="status" aria-live="polite">
          <p className="max-thinking-title">
            <span className="max-pulse" aria-hidden="true" />
            Thinking…
          </p>
          <p className="max-thinking-count" data-answered-count="">
            {answered} of {round.contenders.length} answered
          </p>
          <ul className="max-thinking-list">
            {round.contenders.map((contender) => (
              <li key={contender.key}>
                <span>{describe(contender.instanceId, contender.model)}</span>
                <span className="max-council-status" data-active={contender.status === "running"}>
                  {contender.status.replaceAll("-", " ")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <MaxPageStack
          pages={pages}
          index={pageIndex}
          onIndexChange={onPageIndexChange}
          label="Council answers"
          renderPage={(page) => (
            <MaxPage page={page} title={pageTitle(page, describe)} onContinue={onContinue} />
          )}
        />
      )}
      {active ? (
        <div className="max-round-actions">
          <button type="button" className="max-link" disabled={cancelling} onClick={onCancel}>
            {cancelling ? "Cancelling…" : "Cancel round"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
