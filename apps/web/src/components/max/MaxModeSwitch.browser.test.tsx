import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { ChatHeader } from "../chat/ChatHeader";
import { MaxModeSwitch } from "./MaxModeSwitch";
import { MAX_MODE_STORAGE_KEY, readMaxMode, writeMaxMode } from "./maxMode";

/** Sets the stored mode for one test and clears it when the test ends. */
function storedMaxMode(mode: "council" | "agent"): Disposable {
  writeMaxMode(mode);
  return { [Symbol.dispose]: () => removeLocalStorageItem(MAX_MODE_STORAGE_KEY) };
}

function DraftHeader() {
  return (
    <ChatHeader
      activeThreadEnvironmentId={EnvironmentId.make("environment-1")}
      activeThreadId={ThreadId.make("thread-1")}
      activeThreadTitle="New thread"
      isServerThread={false}
      activeProject={null}
      parentThreadLink={null}
      onOpenThread={() => {}}
      rightPanelOpen={false}
      onNewThreadInProject={() => {}}
    />
  );
}

it("shows the same two tabs in the agent thread header, with Agent pressed, at phone width", async () => {
  using _mode = storedMaxMode("agent");
  const container = document.createElement("div");
  container.style.width = "360px";
  await using screen = await render(<DraftHeader />, { container });

  const mode = screen.getByRole("group", { name: "Mode" });
  const council = mode.getByRole("button", { name: "Council", exact: true });
  const agent = mode.getByRole("button", { name: "Agent", exact: true });
  await expect.element(council).toBeVisible();
  await expect.element(agent).toBeVisible();
  await expect.element(agent).toHaveAttribute("aria-pressed", "true");
  await expect.element(council).toHaveAttribute("aria-pressed", "false");
  expect(screen.container.querySelectorAll('[aria-label="Mode"]')).toHaveLength(1);
  expect(screen.container.querySelector('[aria-label="Back to Council"]')).toBeNull();
  for (const tab of [council, agent]) {
    const box = tab.element().getBoundingClientRect();
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.right).toBeLessThanOrEqual(360);
  }
});

it("goes to the council home when Council is pressed from an agent thread", async () => {
  using _mode = storedMaxMode("agent");
  await using screen = await render(<DraftHeader />, { router: "/agent-thread" });

  await screen.getByRole("button", { name: "Council", exact: true }).click();

  await expect.poll(() => screen.router?.state.location.pathname).toBe("/");
  expect(screen.router?.state.location.search).toEqual({});
  expect(readMaxMode()).toBe("council");
});

it("returns to the council round the thread was continued from", async () => {
  using _mode = storedMaxMode("agent");
  sessionStorage.setItem("max.returnRound:/agent-thread", "round-9");
  using _round = {
    [Symbol.dispose]: () => sessionStorage.removeItem("max.returnRound:/agent-thread"),
  };
  await using screen = await render(<DraftHeader />, { router: "/agent-thread" });

  await screen.getByRole("button", { name: "Council", exact: true }).click();

  await expect.poll(() => screen.router?.state.location.search).toEqual({ round: "round-9" });
});

it("presses the current mode and reports only a change", async () => {
  const onModeChange = vi.fn();
  await using screen = await render(
    <div className="max-scope">
      <MaxModeSwitch mode="council" onModeChange={onModeChange} />
    </div>,
  );

  const council = screen.getByRole("button", { name: "Council", exact: true });
  await expect.element(council).toHaveAttribute("aria-pressed", "true");
  await council.click();
  expect(onModeChange).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Agent", exact: true }).click();
  expect(onModeChange).toHaveBeenCalledExactlyOnceWith("agent");
});
