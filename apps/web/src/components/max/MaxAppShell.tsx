import type { CSSProperties } from "react";

import { SidebarInset } from "../ui/sidebar";
import { MaxHeader } from "./MaxHeader";
import { MaxCouncilRounds } from "./MaxCouncilRounds";
import type { MaxMode } from "./maxMode";
import { useKeyboardInset } from "./useKeyboardInset";

/**
 * The one MAX chat window. The side panel is T3's sidebar showing council history (see
 * AppSidebarLayout); phones get it as a drawer, computers docked. The window fills the dynamic
 * viewport and pads for the software keyboard so the composer never hides behind it.
 */
export function MaxAppShell({
  onModeChange,
  roundId,
}: {
  readonly onModeChange: (mode: MaxMode) => void;
  readonly roundId?: string | undefined;
}) {
  const keyboardInset = useKeyboardInset();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div
        className="max-scope max-shell flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={{ "--max-keyboard-inset": `${keyboardInset}px` } as CSSProperties}
      >
        <MaxHeader mode="council" onModeChange={onModeChange} />
        <MaxCouncilRounds roundId={roundId} />
      </div>
    </SidebarInset>
  );
}
