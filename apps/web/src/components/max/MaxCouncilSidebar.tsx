import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { PlusIcon, SettingsIcon, TerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { refreshCouncilHome, useCouncilHome } from "./councilHome";
import { relativeRoundTime } from "./councilTime";
import { useMaxMode } from "./maxMode";

/**
 * Old MAX's side panel, inside T3's sidebar frame: past conversations and a new chat, backed by
 * saved council rounds. T3 renders it docked on computers and as a drawer on phones.
 */
export function MaxCouncilSidebar() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeRoundId = useLocation({
    select: (location) => {
      const round = (location.search as { round?: string }).round;
      return typeof round === "string" ? round : null;
    },
  });
  const { rounds, loaded, error } = useCouncilHome();
  // oxlint-disable-next-line t3code/react-effect-budget -- Saved rounds live on the gateway; load them once when the panel first mounts.
  useEffect(() => {
    if (!loaded) void refreshCouncilHome();
  }, [loaded]);

  const open = (search: { round?: string }) => {
    void navigate({ to: "/", search });
    if (isMobile) setOpenMobile(false);
  };

  return (
    <div className="max-scope max-panel">
      <div className="max-panel-header">
        <div className="max-panel-trigger max-phone-only">
          <SidebarTrigger variant="ghost" aria-label="Toggle main sidebar" />
        </div>
        <span className="max-wordmark text-base font-bold">MAX</span>
      </div>
      <button type="button" className="max-panel-new" onClick={() => open({})}>
        <PlusIcon aria-hidden="true" className="size-4" />
        New chat
      </button>
      <nav aria-label="Conversations" className="max-panel-list">
        {rounds.length === 0 ? (
          <p className="max-panel-empty">
            {error ? error : loaded ? "No conversations yet." : "Loading…"}
          </p>
        ) : (
          <ul>
            {rounds.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={entry.id === activeRoundId ? "page" : undefined}
                  className={cn(
                    "max-panel-item",
                    entry.id === activeRoundId && "max-panel-item-active",
                  )}
                  onClick={() => open({ round: entry.id })}
                >
                  <span className="max-panel-item-title">{entry.prompt}</span>
                  <span className="max-panel-item-meta">
                    <span
                      className="max-council-status"
                      data-active={entry.status === "running" || entry.status === "synthesizing"}
                    >
                      {entry.status}
                    </span>
                    {relativeRoundTime(entry.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="max-panel-footer">
        <AgentModeEntry onOpened={() => isMobile && setOpenMobile(false)} />
        <button
          type="button"
          className="max-panel-footer-button"
          onClick={() => {
            void navigate({ to: "/settings/providers", search: {} });
            if (isMobile) setOpenMobile(false);
          }}
        >
          <SettingsIcon aria-hidden="true" className="size-4" />
          Settings
        </button>
      </div>
    </div>
  );
}

function AgentModeEntry({ onOpened }: { readonly onOpened: () => void }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const [, setMaxMode] = useMaxMode();
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
        setMaxMode("agent");
        onOpened();
      })
      .catch(() => setStartFailed(true))
      .finally(() => setStarting(false));
  };

  return (
    <>
      {mostRecentProject !== null ? (
        <button
          type="button"
          className="max-panel-footer-button"
          disabled={starting}
          onClick={startAgentThread}
        >
          <TerminalIcon aria-hidden="true" className="size-4" />
          <span className="truncate">
            {starting ? "Opening…" : `New agent thread in ${mostRecentProject.title}`}
          </span>
        </button>
      ) : bootstrapped ? (
        <button
          type="button"
          className="max-panel-footer-button"
          onClick={() => openCommandPalette({ open: "add-project" })}
        >
          <TerminalIcon aria-hidden="true" className="size-4" />
          Add a project for Agent mode
        </button>
      ) : (
        <p className="max-panel-empty">Loading projects…</p>
      )}
      {startFailed ? (
        <p role="alert" className="max-panel-empty text-(--max-amber)">
          Couldn’t start a new thread. The project is still available; try again.
        </p>
      ) : null}
    </>
  );
}
