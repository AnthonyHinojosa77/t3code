import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useState } from "react";
import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { MaxCouncilRounds } from "./MaxCouncilRounds";
import { MaxPromptComposer } from "./MaxPromptComposer";
import { MaxCouncilReturn } from "./MaxCouncilReturn";
import { EMPTY_COUNCIL_SELECTION, type CouncilSelection } from "./councilSelection";
import { councilFixture } from "./councilRound.test-fixture";

vi.mock("../../lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [], useThreadShells: () => [] }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "environment-1",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("../../modelSelection", () => ({
  getCustomModelOptionsByInstance: () => new Map([["codex", [{ slug: "gpt-5", name: "GPT-5" }]]]),
}));
vi.mock("../../providerInstances", () => ({
  applyProviderInstanceSettings: () => [
    { instanceId: "codex", driverKind: "codex", displayName: "OpenAI", models: [] },
  ],
  deriveProviderInstanceEntries: () => [],
  sortProviderInstanceEntries: (entries: unknown[]) => entries,
  resolveDefaultProviderModelSelection: () => ({ instanceId: "codex", model: "gpt-5" }),
}));
// Shared model/trait pickers have independent coverage. These controls isolate council interactions.
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: ({
    triggerAriaLabel,
    onInstanceModelChange,
  }: {
    triggerAriaLabel: string;
    onInstanceModelChange: (instanceId: string, model: string) => void;
  }) => (
    <button
      type="button"
      className="max-council-button"
      aria-label={triggerAriaLabel}
      onClick={() => onInstanceModelChange("codex", "gpt-5")}
    >
      {triggerAriaLabel}
    </button>
  ),
}));
vi.mock("../chat/TraitsPicker", () => ({
  TraitsPicker: () => <span className="text-xs">Default effort</span>,
}));
vi.mock("../Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: (projects: unknown[]) => projects,
}));
vi.mock("../ChatMarkdown", async () => {
  const { default: Markdown } = await import("react-markdown");
  return { default: ({ text }: { text: string }) => <Markdown>{text}</Markdown> };
});

function ComposerHarness() {
  const [selection, setSelection] = useState<CouncilSelection>(EMPTY_COUNCIL_SELECTION);
  const [created, setCreated] = useState("");
  return (
    <div className="max-scope h-screen overflow-y-auto p-5">
      <MaxPromptComposer
        selection={selection}
        onSelectionChange={setSelection}
        templates={[councilFixture().template]}
        apiError={null}
        onRefresh={() => {}}
        onCreated={(id, environmentId) => setCreated(`${id}:${environmentId}`)}
      />
      <p>{created}</p>
    </div>
  );
}
async function phone() {
  await page.viewport(390, 844);
}
function wrapped(roundId?: string) {
  return (
    <div className="max-scope h-screen overflow-y-auto space-y-5 p-5">
      <MaxCouncilRounds roundId={roundId} />
    </div>
  );
}

it("enables Send only with a question, contender and judge, then posts once", async () => {
  await phone();
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ round: councilFixture().round }), { status: 201 }),
    );
  await using screen = await render(<ComposerHarness />);
  await expect.element(screen.getByText("Enter a question.")).toBeVisible();
  await screen
    .getByRole("textbox", { name: "Question for the council" })
    .fill("How should we launch the council?");
  await expect.element(screen.getByText("Choose at least one contender.")).toBeVisible();
  await screen.getByRole("button", { name: "Choose contender models" }).click();
  await expect.element(screen.getByText("Choose a synthesizer.")).toBeVisible();
  await screen.getByRole("button", { name: "Choose synthesizer model" }).click();
  await expect.element(screen.getByRole("button", { name: "Send to council" })).toBeEnabled();
  await page.screenshot({ fullPage: false, path: "__screenshots__/B/composer-ready.png" });
  await screen.getByRole("button", { name: "Send to council" }).click();
  await expect.element(screen.getByText("round-1:environment-1")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("resumes, polls through synthesis, stops at completion and returns from Agent Mode", async () => {
  await phone();
  const { round } = councilFixture();
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped("round-1"), { router: "/?round=round-1" });
  await expect.element(screen.getByText("Critic", { exact: true })).toBeVisible();
  await page.screenshot({ fullPage: false, path: "__screenshots__/B/round-running.png" });
  const synthesizing = {
    ...round,
    status: "synthesizing",
    synthesis: { ...round.synthesis, status: "running", text: "Comparing perspectives…" },
  };
  fetch.mockResolvedValue(new Response(JSON.stringify({ round: synthesizing })));
  await expect.element(screen.getByText("Comparing perspectives…")).toBeVisible();
  const complete = {
    ...round,
    status: "complete",
    contenders: round.contenders.map((entry) => ({ ...entry, status: "complete" })),
    synthesis: {
      ...round.synthesis,
      status: "complete",
      text: "Launch gradually",
      structured: {
        verdict: "Launch gradually",
        consensus: ["Start with a focused pilot"],
        disagreements: ["How quickly to expand"],
        uncertainties: ["Demand is untested"],
      },
    },
  };
  fetch.mockResolvedValue(new Response(JSON.stringify({ round: complete })));
  await expect.element(screen.getByText("Launch gradually")).toBeVisible();
  await page.screenshot({
    fullPage: false,
    path: "__screenshots__/B/round-complete-meta-debate.png",
  });
  await screen.getByRole("button", { name: "Continue in Agent Mode" }).first().click();
  expect(screen.router?.state.location.pathname).toBe("/environment-1/thread-1");
  await screen.rerender(<MaxCouncilReturn />);
  await screen.getByRole("button", { name: "Back to Council" }).click();
  expect(screen.router?.state.location.search).toEqual({ round: "round-1" });
  sessionStorage.removeItem("max.returnRound:/environment-1/thread-1");
});
it("shows needs-attention and failed/skipped states", async () => {
  await phone();
  const { round } = councilFixture();
  round.contenders[0]!.status = "needs-attention";
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await expect.element(screen.getByText(/This model is waiting for an approval/)).toBeVisible();
  round.status = "failed";
  round.contenders[0]!.status = "failed";
  round.contenders[0]!.error = "Provider unavailable";
  round.synthesis.status = "skipped";
  fetch.mockResolvedValue(new Response(JSON.stringify({ round })));
  await screen.rerender(wrapped("round-2"));
  await expect.element(screen.getByText("Provider unavailable")).toBeVisible();
  await expect
    .element(screen.getByText("No contender answered, so synthesis was skipped."))
    .toBeVisible();
});
it("preserves malformed synthesis as readable raw text", async () => {
  await phone();
  const { round } = councilFixture();
  round.status = "complete";
  round.synthesis.status = "complete";
  round.synthesis.text = "A useful answer, even without JSON.";
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await expect.element(screen.getByText(/Couldn’t read the structured format/)).toBeVisible();
  await page.screenshot({
    fullPage: false,
    path: "__screenshots__/B/synthesis-parse-fallback.png",
  });
});
it("lists saved rounds and opens their URL", async () => {
  await phone();
  const { round, template } = councilFixture();
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("templates") ? { templates: [template] } : { rounds: [round] },
          ),
        ),
    );
  await using screen = await render(wrapped());
  await expect.element(screen.getByRole("button", { name: /How should we launch/ })).toBeVisible();
  await page.screenshot({ fullPage: false, path: "__screenshots__/B/rounds-list.png" });
  await screen.getByRole("button", { name: /How should we launch/ }).click();
  expect(screen.router?.state.location.search).toEqual({ round: "round-1" });
});
it("explains missing gateway instead of enabling Send", async () => {
  await phone();
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 404 }));
  await using screen = await render(wrapped());
  await expect
    .element(screen.getByText("Council needs the MAX gateway", { exact: true }).first())
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send to council" })).toBeDisabled();
  await page.screenshot({ fullPage: false, path: "__screenshots__/B/council-api-missing.png" });
});

it("creates, edits and deletes a custom template, keeping built-ins read-only", async () => {
  await phone();
  const { template } = councilFixture();
  let templates = [template];
  using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "POST" || init?.method === "PUT") {
      const saved = { ...JSON.parse(String(init.body)), id: "custom", builtIn: false };
      templates = [template, saved];
      return new Response(JSON.stringify({ template: saved }));
    }
    if (init?.method === "DELETE") {
      templates = [template];
      return new Response(null, { status: 204 });
    }
    return new Response(
      JSON.stringify(String(url).includes("templates") ? { templates } : { rounds: [] }),
    );
  });
  await using screen = await render(wrapped());
  await screen.getByRole("button", { name: "Manage templates" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Launch review");
  await dialog
    .getByRole("textbox", { name: "Judge instruction" })
    .fill("Find the safest launch path");
  await page.screenshot({ fullPage: false, path: "__screenshots__/B/template-manager.png" });
  await dialog.getByRole("button", { name: "Save template" }).click();
  await expect.element(dialog.getByRole("button", { name: "Delete template" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Description" }).fill("Updated description");
  await dialog.getByRole("button", { name: "Save template" }).click();
  await vi.waitFor(() =>
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true),
  );
  await dialog.getByRole("button", { name: "Delete template" }).click();
  await expect.element(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("");
  await dialog.getByLabelText("Edit template").selectOptions("meta-debate");
  await expect.element(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
});

it("pauses polling when hidden, resumes on visibility and aborts on unmount", async () => {
  const { round } = councilFixture();
  using hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await expect.element(screen.getByText("Critic", { exact: true })).toBeVisible();
  using _timers = fakeTimers();
  hidden.mockReturnValue(true);
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  const count = fetch.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(4500));
  expect(fetch).toHaveBeenCalledTimes(count);
  hidden.mockReturnValue(false);
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetch).toHaveBeenCalledTimes(count + 1);
  const signal = fetch.mock.calls.at(-1)?.[1]?.signal;
  await screen.unmount();
  expect(signal?.aborted).toBe(true);
});

it("keeps the question when POST fails and allows retry", async () => {
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ error: "Provider disconnected" }), { status: 500 }),
    );
  await using screen = await render(<ComposerHarness />);
  const prompt = screen.getByRole("textbox", { name: "Question for the council" });
  await prompt.fill("Keep this question");
  await screen.getByRole("button", { name: "Choose contender models" }).click();
  await screen.getByRole("button", { name: "Choose synthesizer model" }).click();
  await screen.getByRole("button", { name: "Send to council" }).click();
  await expect.element(screen.getByText("Provider disconnected")).toBeVisible();
  await expect.element(prompt).toHaveValue("Keep this question");
  fetch.mockResolvedValue(new Response(JSON.stringify({ round: councilFixture().round })));
  await screen.getByRole("button", { name: "Send to council" }).click();
  await expect.element(screen.getByText("round-1:environment-1")).toBeVisible();
});

it("cancels an active round through the coordinator", async () => {
  const { round } = councilFixture();
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await screen.getByRole("button", { name: "Cancel round" }).click();
  expect(fetch).toHaveBeenCalledWith(
    "/api/council/rounds/round-1/cancel",
    expect.objectContaining({ method: "POST", credentials: "include" }),
  );
});

it("puts a newly created round in the URL and sends default roles", async () => {
  const { template, round } = councilFixture();
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (url, init) =>
        new Response(
          JSON.stringify(
            init?.method === "POST"
              ? { round }
              : String(url).includes("templates")
                ? { templates: [template] }
                : { rounds: [] },
          ),
        ),
    );
  await using screen = await render(wrapped());
  await screen.getByRole("textbox", { name: "Question for the council" }).fill("Launch question");
  await screen.getByRole("button", { name: "Choose contender models" }).click();
  await screen.getByRole("button", { name: "Choose synthesizer model" }).click();
  await screen.getByRole("button", { name: "Send to council" }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ round: round.id }));
  const body = fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body;
  expect(JSON.parse(String(body))).toMatchObject({
    projectId: null,
    templateId: "meta-debate",
    contenders: [{ instanceId: "codex", roleId: "critic" }],
  });
});

it("shows approvals still required and removes the note for auto mode", async () => {
  await phone();
  const { round } = councilFixture();
  round.status = "complete";
  round.contenders[0]!.status = "complete";
  round.contenders[0]!.runtimeMode = "approval-required";
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped("round-1"), { router: "/?round=round-1" });
  await expect.element(screen.getByText("This model may ask for tool approvals.")).toBeVisible();
  await page.screenshot({ fullPage: false, path: "__screenshots__/F1/approval-mode-note.png" });
  round.contenders[0]!.runtimeMode = "auto";
  await screen.rerender(wrapped("round-2"));
  await expect
    .element(screen.getByText("This model may ask for tool approvals."))
    .not.toBeInTheDocument();
  await page.screenshot({ fullPage: false, path: "__screenshots__/F1/auto-mode-no-note.png" });
});
