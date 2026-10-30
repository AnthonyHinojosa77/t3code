import { LogOutIcon } from "lucide-react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useMaxLogout } from "./MaxAuthGate";
import { MaxThemeToggle } from "./MaxThemeToggle";
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
    <WorkspacePageHeader electron={isElectron} className="max-header gap-2">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span className="max-wordmark shrink-0 text-lg font-bold">MAX</span>
        <span className="hidden truncate text-xs text-(--max-muted) md:inline">
          Multi-Model AI Console
        </span>
      </div>
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
      <MaxThemeToggle />
      <button
        type="button"
        onClick={() => void logout()}
        className="max-icon-button"
        aria-label="Sign out"
      >
        <LogOutIcon aria-hidden="true" className="size-4" />
        <span className="max-md:sr-only text-xs">Sign out</span>
      </button>
    </WorkspacePageHeader>
  );
}
