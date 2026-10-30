import { useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import type { CouncilContenderState, CouncilSynthesisState } from "./councilApi";
import type { CouncilPage } from "./councilPages";

export function CouncilAnswer({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="max-council-answer">
      <ChatMarkdown text={text} cwd={undefined} isStreaming={streaming} />
    </div>
  );
}

export function AnswerActions({
  text,
  threadId,
  onContinue,
}: {
  text: string;
  threadId: string | null;
  onContinue: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState("Copy");
  return (
    <div className="max-page-actions">
      <button
        type="button"
        className="max-button"
        disabled={!text}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setCopyState("Copied"),
            () => setCopyState("Copy failed. Try again"),
          );
        }}
      >
        {copyState}
      </button>
      <button
        type="button"
        className="max-button"
        disabled={!threadId}
        onClick={() => {
          if (threadId) onContinue(threadId);
        }}
      >
        Continue in Agent Mode
      </button>
      {!threadId && (
        <span className="text-xs text-(--max-muted)">Waiting for an agent thread.</span>
      )}
    </div>
  );
}

function statusLabel(status: string): string {
  return status.replaceAll("-", " ");
}

function PageHeader({
  title,
  role,
  status,
  active,
}: {
  title: string;
  role?: string | null;
  status: string;
  active: boolean;
}) {
  return (
    <header className="max-page-header">
      <div className="min-w-0">
        <h3 className="max-page-title">{title}</h3>
        {role ? <p className="max-page-role">{role}</p> : null}
      </div>
      <span className="max-council-status" data-active={active}>
        {statusLabel(status)}
      </span>
    </header>
  );
}

function ContenderPage({
  contender,
  title,
  onContinue,
}: {
  contender: CouncilContenderState;
  title: string;
  onContinue: (id: string) => void;
}) {
  const active = contender.status === "running" || contender.status === "pending";
  return (
    <>
      <PageHeader
        title={title}
        role={contender.roleName}
        status={contender.status}
        active={active}
      />
      <div className="max-page-body">
        {contender.runtimeMode === "approval-required" && (
          <p className="text-xs text-(--max-muted)">This model may ask for tool approvals.</p>
        )}
        {contender.status === "needs-attention" && (
          <p role="status" className="max-page-notice">
            This model is waiting for an approval. Continue in Agent Mode to resolve it.
          </p>
        )}
        {contender.error && (
          <p role="alert" className="max-page-notice">
            {contender.error}
          </p>
        )}
        {contender.text ? (
          <CouncilAnswer text={contender.text} streaming={contender.status === "running"} />
        ) : (
          <p className="text-(--max-muted)">
            {contender.status === "pending"
              ? "Waiting to start…"
              : contender.status === "running"
                ? "Thinking…"
                : contender.status === "needs-attention"
                  ? "No answer until the approval is handled."
                  : "No answer."}
          </p>
        )}
      </div>
      <AnswerActions text={contender.text} threadId={contender.threadId} onContinue={onContinue} />
    </>
  );
}

function SynthesisPage({
  synthesis,
  title,
  onContinue,
}: {
  synthesis: CouncilSynthesisState;
  title: string;
  onContinue: (id: string) => void;
}) {
  const structured = synthesis.structured;
  const active = synthesis.status === "running" || synthesis.status === "pending";
  return (
    <>
      <PageHeader title={title} status={synthesis.status} active={active} />
      <div className="max-page-body">
        {synthesis.status === "skipped" ? (
          <p>No contender answered, so synthesis was skipped.</p>
        ) : structured ? (
          <>
            <section className="max-verdict">
              <h3>Verdict</h3>
              <CouncilAnswer text={structured.verdict} />
            </section>
            {(["consensus", "disagreements", "uncertainties"] as const).map((section) => (
              <section key={section} className="max-synthesis-section">
                <h3>{section}</h3>
                {structured[section].length ? (
                  <ul>
                    {structured[section].map((text) => (
                      <li key={text}>
                        <CouncilAnswer text={text} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-(--max-muted)">None reported.</p>
                )}
              </section>
            ))}
          </>
        ) : synthesis.text ? (
          <>
            {synthesis.format === "meta-debate" && synthesis.status === "complete" && (
              <p className="text-xs text-(--max-amber)">
                Couldn’t read the structured format. The full answer is below.
              </p>
            )}
            <CouncilAnswer text={synthesis.text} streaming={synthesis.status === "running"} />
          </>
        ) : (
          <p className="text-(--max-muted)">
            {synthesis.status === "pending"
              ? "The judge will combine the answers when the contenders finish."
              : synthesis.status === "running"
                ? "Combining the council’s answers…"
                : "No synthesis available."}
          </p>
        )}
        {synthesis.error && (
          <p role="alert" className="max-page-notice">
            {synthesis.error}
          </p>
        )}
      </div>
      <AnswerActions text={synthesis.text} threadId={synthesis.threadId} onContinue={onContinue} />
    </>
  );
}

/** One page of the council e-book: a contender's answer or the synthesis. */
export function MaxPage({
  page,
  title,
  onContinue,
}: {
  page: CouncilPage;
  title: string;
  onContinue: (id: string) => void;
}) {
  return page.kind === "synthesis" ? (
    <SynthesisPage synthesis={page.synthesis} title={title} onContinue={onContinue} />
  ) : (
    <ContenderPage contender={page.contender} title={title} onContinue={onContinue} />
  );
}
