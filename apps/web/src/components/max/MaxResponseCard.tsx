import { useState } from "react";
import type { ReactNode } from "react";
import ChatMarkdown from "../ChatMarkdown";
import type { CouncilContenderState } from "./councilApi";

export function CouncilAnswer({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div
        className={
          expanded ? "max-council-answer" : "max-council-answer max-council-answer-collapsed"
        }
      >
        <ChatMarkdown text={text} cwd={undefined} isStreaming={streaming} />
      </div>
      {text.length > 900 && (
        <button className="max-council-button" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse answer" : "Expand answer"}
        </button>
      )}
    </>
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
  const [copyState, setCopyState] = useState("Copy answer");
  return (
    <div className="mt-auto flex flex-wrap gap-2 border-t border-(--max-line) pt-3">
      <button
        type="button"
        className="max-council-button"
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
        className="max-council-button"
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
export function AnswerFrame({
  title,
  status,
  children,
}: {
  title: string;
  status: string;
  children: ReactNode;
}) {
  return (
    <article className="max-council-card">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-(--max-line) pb-3">
        <h3 className="min-w-0 break-words font-semibold">{title}</h3>
        <span
          className="max-council-status"
          data-active={status === "running" || status === "pending"}
        >
          {status.replaceAll("-", " ")}
        </span>
      </header>
      {children}
    </article>
  );
}
export function MaxResponseCard({
  contender,
  displayName,
  onContinue,
}: {
  contender: CouncilContenderState;
  displayName: string;
  onContinue: (id: string) => void;
}) {
  return (
    <AnswerFrame title={displayName} status={contender.status}>
      {contender.roleName && <p className="text-xs text-(--max-amber)">{contender.roleName}</p>}
      {contender.status === "needs-attention" && (
        <p role="status" className="text-(--max-amber)">
          This model is waiting for an approval. Continue in Agent Mode to resolve it.
        </p>
      )}
      {contender.error && (
        <p role="alert" className="text-(--max-amber)">
          {contender.error}
        </p>
      )}
      {contender.text ? (
        <CouncilAnswer text={contender.text} streaming={contender.status === "running"} />
      ) : (
        <p className="min-h-24 text-(--max-muted)">
          {contender.status === "pending"
            ? "Waiting to start…"
            : contender.status === "running"
              ? "Thinking…"
              : "No answer yet."}
        </p>
      )}
      <AnswerActions text={contender.text} threadId={contender.threadId} onContinue={onContinue} />
    </AnswerFrame>
  );
}
