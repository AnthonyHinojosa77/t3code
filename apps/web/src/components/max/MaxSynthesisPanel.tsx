import type { CouncilSynthesisState } from "./councilApi";
import { AnswerActions, AnswerFrame, CouncilAnswer } from "./MaxResponseCard";
export function MaxSynthesisPanel({
  synthesis,
  displayName,
  onContinue,
}: {
  synthesis: CouncilSynthesisState;
  displayName: string;
  onContinue: (id: string) => void;
}) {
  const structured = synthesis.structured;
  return (
    <section aria-label="Council synthesis">
      <AnswerFrame title={`Synthesis · ${displayName}`} status={synthesis.status}>
        {synthesis.status === "skipped" ? (
          <p>No contender answered, so synthesis was skipped.</p>
        ) : structured ? (
          <>
            <div className="border-l-2 border-(--max-green) pl-4">
              <h3 className="text-(--max-green)">Verdict</h3>
              <CouncilAnswer text={structured.verdict} />
            </div>
            {(["consensus", "disagreements", "uncertainties"] as const).map((section) => (
              <section key={section}>
                <h3 className="mb-2 capitalize text-(--max-amber)">{section}</h3>
                {structured[section].length ? (
                  <ul className="list-disc space-y-2 pl-5">
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
          <p className="min-h-24 text-(--max-muted)">
            {synthesis.status === "pending"
              ? "The judge will combine the answers when the contenders finish."
              : synthesis.status === "running"
                ? "Combining the council’s answers…"
                : "No synthesis available."}
          </p>
        )}
        {synthesis.error && (
          <p role="alert" className="text-(--max-amber)">
            {synthesis.error}
          </p>
        )}
        <AnswerActions
          text={synthesis.text}
          threadId={synthesis.threadId}
          onContinue={onContinue}
        />
      </AnswerFrame>
    </section>
  );
}
