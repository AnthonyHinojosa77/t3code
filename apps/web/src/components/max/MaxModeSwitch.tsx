import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { returnToCouncil, type MaxMode } from "./maxMode";

const MODE_OPTIONS: ReadonlyArray<{ readonly mode: MaxMode; readonly label: string }> = [
  { mode: "council", label: "Council" },
  { mode: "agent", label: "Agent" },
];

/** The one Council/Agent control. Every MAX screen shows this same switch. */
export function MaxModeSwitch({
  mode,
  onModeChange,
}: {
  readonly mode: MaxMode;
  readonly onModeChange: (mode: MaxMode) => void;
}) {
  return (
    <div role="group" aria-label="Mode" className="max-segmented">
      {MODE_OPTIONS.map((option) => {
        const pressed = option.mode === mode;
        return (
          <button
            key={option.mode}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              if (!pressed) onModeChange(option.mode);
            }}
            className={cn("max-segment", pressed && "max-segment-active")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The switch as T3's Agent screens show it. Council returns to the round this thread was
 * continued from, or to the council home. It brings its own MAX scope because T3's headers
 * sit outside one.
 */
export function MaxAgentModeSwitch({ className }: { readonly className?: string }) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <div className={cn("max-scope max-agent-mode-switch", className)}>
      <MaxModeSwitch
        mode="agent"
        onModeChange={() => {
          const roundId = sessionStorage.getItem(`max.returnRound:${pathname}`);
          returnToCouncil(() => navigate({ to: "/", search: roundId ? { round: roundId } : {} }));
        }}
      />
    </div>
  );
}
