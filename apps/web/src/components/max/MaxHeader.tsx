import { LogOutIcon } from "lucide-react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useMaxLogout } from "./MaxAuthGate";
import type { MaxMode } from "./maxMode";

const MODE_OPTIONS: ReadonlyArray<{ readonly mode: MaxMode; readonly label: string }> = [
  { mode: "council", label: "Council" },
  { mode: "agent", label: "Agent" },
];

/** MAX top bar. T3's header handles the titlebar drag area, safe area and sidebar toggle inset. */
export function MaxHeader({
  mode,
  onModeChange,
}: {
  readonly mode: MaxMode;
  readonly onModeChange: (mode: MaxMode) => void;
}) {
  const logout = useMaxLogout();

  return (
    <WorkspacePageHeader electron={isElectron} className="border-b border-(--max-line)">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="max-wordmark text-lg font-bold">MAX</span>
        <span className="hidden truncate text-xs text-(--max-muted) sm:inline">
          Multi-Model AI Console
        </span>
      </div>
      <div
        role="group"
        aria-label="Mode"
        className="flex shrink-0 rounded-sm border border-(--max-line-strong) p-0.5"
      >
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
              className={cn(
                "rounded-xs px-2.5 py-1 text-xs motion-safe:transition-colors",
                pressed
                  ? "bg-(--max-darker) text-(--max-green)"
                  : "text-(--max-muted) hover:text-(--max-light)",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => void logout()}
        className="flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-(--max-muted) hover:text-(--max-light) motion-safe:transition-colors"
      >
        <LogOutIcon aria-hidden="true" className="size-3.5" />
        <span className="max-sm:sr-only">Sign out</span>
      </button>
    </WorkspacePageHeader>
  );
}
