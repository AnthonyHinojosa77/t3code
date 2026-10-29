import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { SidebarInset } from "../ui/sidebar";
import { EMPTY_COUNCIL_SELECTION } from "./councilSelection";
import { MaxHeader } from "./MaxHeader";
import { MaxPromptComposer } from "./MaxPromptComposer";
import type { MaxMode } from "./maxMode";

const primaryButtonClass =
  "rounded-sm border border-(--max-green) px-3 py-1.5 text-xs text-(--max-green) hover:bg-(--max-green) hover:text-(--max-black) disabled:pointer-events-none disabled:opacity-50 motion-safe:transition-colors";

/**
 * Council home at `/`. T3's sidebar stays beside it and still lists threads and projects.
 * Council rounds have no backend yet, so this shows an empty state rather than a fake list.
 */
export function MaxAppShell({ onModeChange }: { readonly onModeChange: (mode: MaxMode) => void }) {
  const [councilSelection, setCouncilSelection] = useState(EMPTY_COUNCIL_SELECTION);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="max-scope flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <MaxHeader mode="council" onModeChange={onModeChange} />
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 py-10 md:py-16">
            <MaxPromptComposer
              selection={councilSelection}
              onSelectionChange={setCouncilSelection}
            />
            <section aria-labelledby="max-rounds-heading">
              <h2 id="max-rounds-heading" className="text-sm font-semibold">
                Council rounds
              </h2>
              <p className="mt-3 rounded-sm border border-dashed border-(--max-line-strong) px-4 py-6 text-center text-sm text-(--max-muted)">
                No council rounds yet. They will appear here.
              </p>
            </section>
            <AgentModeEntry onModeChange={onModeChange} />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function AgentModeEntry({ onModeChange }: { readonly onModeChange: (mode: MaxMode) => void }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  // Same pick as T3's stock landing: the project with the latest activity.
  const mostRecentProject =
    sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null;

  const startAgentThread = () => {
    if (mostRecentProject === null || starting) return;
    setStarting(true);
    setStartFailed(false);
    const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
    void handleNewThread(projectRef)
      .then((opened) => {
        if (opened === null) {
          setStartFailed(true);
          return;
        }
        // The draft is open; `/` now behaves like stock T3 until Council is chosen again.
        onModeChange("agent");
      })
      .catch(() => setStartFailed(true))
      .finally(() => setStarting(false));
  };

  return (
    <section aria-labelledby="max-agent-heading">
      <h2 id="max-agent-heading" className="text-sm font-semibold">
        Agent mode
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-(--max-muted)">
        Work in one project with one model, with file edits, the terminal, and tool approvals.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {mostRecentProject !== null ? (
          <button
            type="button"
            className={primaryButtonClass}
            disabled={starting}
            onClick={startAgentThread}
          >
            {starting ? "Opening…" : `New agent thread in ${mostRecentProject.title}`}
          </button>
        ) : bootstrapped ? (
          <button
            type="button"
            className={primaryButtonClass}
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            Add a project
          </button>
        ) : (
          <p className="text-xs text-(--max-muted)">Loading projects…</p>
        )}
      </div>
      {startFailed ? (
        <p role="alert" className="mt-3 text-xs text-(--max-amber)">
          Couldn’t start a new thread. The project is still available; try again.
        </p>
      ) : null}
    </section>
  );
}
