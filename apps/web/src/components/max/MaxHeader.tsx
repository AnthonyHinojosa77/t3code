import { LogOutIcon } from "lucide-react";

import { isElectron } from "../../env";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useMaxLogout } from "./MaxAuthGate";
import { MaxModeSwitch } from "./MaxModeSwitch";
import { MaxThemeToggle } from "./MaxThemeToggle";
import type { MaxMode } from "./maxMode";

/**
 * MAX top bar. T3's header handles the titlebar drag area, safe area and sidebar toggle inset.
 * When the side panel is docked and open its header carries the wordmark, so this one hides its
 * own (see `council.css`): one MAX on screen.
 */
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
        <span className="max-desk-only truncate text-xs text-(--max-muted)">
          Multi-Model AI Console
        </span>
      </div>
      <MaxModeSwitch mode={mode} onModeChange={onModeChange} />
      <MaxThemeToggle />
      <button
        type="button"
        onClick={() => void logout()}
        className="max-icon-button"
        aria-label="Sign out"
      >
        <LogOutIcon aria-hidden="true" className="size-4" />
        <span className="max-desk-only text-xs">Sign out</span>
      </button>
    </WorkspacePageHeader>
  );
}
