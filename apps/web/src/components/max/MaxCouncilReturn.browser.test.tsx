import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { ChatHeader } from "../chat/ChatHeader";
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

it("shows a Council return in the agent thread header, even on a phone-width row", async () => {
  using _mode = storedMaxMode("agent");
  const container = document.createElement("div");
  container.style.width = "360px";
  await using screen = await render(<DraftHeader />, { container });

  const back = screen.getByRole("button", { name: "Back to Council" });
  await expect.element(back).toBeVisible();
});

it("goes home in council mode when the Council return is used", async () => {
  using _mode = storedMaxMode("agent");
  await using screen = await render(<DraftHeader />, { router: "/agent-thread" });

  await screen.getByRole("button", { name: "Back to Council" }).click();

  await expect.poll(() => screen.router?.state.location.pathname).toBe("/");
  expect(readMaxMode()).toBe("council");
});
