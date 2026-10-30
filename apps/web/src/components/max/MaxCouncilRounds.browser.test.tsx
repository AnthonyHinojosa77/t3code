import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { MaxCouncilRounds } from "./MaxCouncilRounds";
import { MaxComposer } from "./MaxComposer";
import { MaxCouncilReturn } from "./MaxCouncilReturn";
import { useCouncilHome } from "./councilHome";
import { EMPTY_COUNCIL_SELECTION, type CouncilSelection } from "./councilSelection";
import { councilFixture } from "./councilRound.test-fixture";
import type { CouncilContenderState, CouncilRound } from "./councilApi";

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
      className="max-button"
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
// The upload path needs a live engine connection; its request cycle is covered by client-runtime.
vi.mock("./councilAttachments", () => ({
  uploadCouncilAttachments: async ({ staged, copies }: { staged: unknown[]; copies: number }) =>
    Array.from({ length: copies }, () =>
      staged.map((_, i) => ({
        type: "file",
        id: `pending_${i}`,
        name: `file${i}`,
        mimeType: "text/plain",
        sizeBytes: 1,
      })),
    ),
}));

/** The chat window remembers chosen models in localStorage; a test starts and ends with none. */
function freshSelection(): Disposable {
  localStorage.removeItem("max.council.selection");
  return { [Symbol.dispose]: () => localStorage.removeItem("max.council.selection") };
}

function ComposerHarness() {
  const [selection, setSelection] = useState<CouncilSelection>(EMPTY_COUNCIL_SELECTION);
  const [created, setCreated] = useState("");
  return (
    <div className="max-scope h-screen overflow-y-auto p-5">
      <MaxComposer
        selection={selection}
        onSelectionChange={setSelection}
        templates={[councilFixture().template]}
        apiError={null}
        onRefresh={() => {}}
        onCreated={(round, environmentId) => setCreated(`${round.id}:${environmentId}`)}
        placeholder="Ask the council…"
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
    <div className="max-scope flex h-screen flex-col p-2">
      <MaxCouncilRounds roundId={roundId} />
    </div>
  );
}
function finished(contender: CouncilContenderState, finishedAt: string): CouncilContenderState {
  return { ...contender, status: "complete", finishedAt };
}
/** Opens the model window, picks a contender and a judge, and closes it. */
async function chooseModels(screen: { getByRole: typeof page.getByRole }) {
  await screen.getByRole("button", { name: "Choose models" }).click();
  const dialog = page.getByRole("dialog", { name: "Models" });
  await dialog.getByRole("button", { name: "Choose contender models" }).click();
  await dialog.getByRole("button", { name: "Choose synthesizer model" }).click();
  await expect.element(dialog.getByText(/^Synthesizer:/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}
/** Pages behind the front one are aria-hidden, so the only article the role query sees is the current page. */
function currentPage() {
  return page.getByRole("article");
}

it("enables Send only with a question, contender and judge, then posts once", async () => {
  await phone();
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ round: councilFixture().round }), { status: 201 }),
    );
  await using screen = await render(<ComposerHarness />);
  await expect.element(screen.getByRole("button", { name: "Send to council" })).toBeDisabled();
  await screen
    .getByRole("textbox", { name: "Question for the council" })
    .fill("How should we launch the council?");
  await expect.element(screen.getByText("Choose at least one contender.")).toBeVisible();
  await chooseModels(screen);
  await expect
    .element(screen.getByRole("button", { name: "Choose models" }))
    .toHaveTextContent("1 model · judge set");
  await expect.element(screen.getByRole("button", { name: "Send to council" })).toBeEnabled();
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/composer-ready.png" });
  await screen.getByRole("button", { name: "Send to council" }).click();
  await expect.element(screen.getByText("round-1:environment-1")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("shows a thinking state, then the first finisher in front, then the synthesis last", async () => {
  using _selection = freshSelection();
  await phone();
  const { round } = councilFixture();
  const second: CouncilContenderState = {
    ...round.contenders[0]!,
    key: "c1",
    roleId: null,
    roleName: null,
    text: "Second answer: ship behind a flag.",
    status: "running",
  };
  round.contenders = [{ ...round.contenders[0]!, text: "" }, second];
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped("round-1"), { router: "/?round=round-1" });
  await expect.element(screen.getByRole("status").getByText("Thinking…")).toBeVisible();
  await expect.element(screen.getByText("0 of 2 answered")).toBeVisible();
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/thinking.png" });
  // The second model finishes first, so its page is in front.
  const firstFinish = {
    ...round,
    contenders: [round.contenders[0]!, finished(second, "2026-10-29T18:00:05Z")],
  };
  fetch.mockResolvedValue(new Response(JSON.stringify({ round: firstFinish })));
  await expect.element(currentPage().getByText("Second answer: ship behind a flag.")).toBeVisible();
  await expect.element(screen.getByText("1 of 2")).toBeVisible();
  const synthesizing: CouncilRound = {
    ...round,
    status: "synthesizing",
    contenders: [
      finished({ ...round.contenders[0]!, text: "First model, later." }, "2026-10-29T18:00:09Z"),
      finished(second, "2026-10-29T18:00:05Z"),
    ],
    synthesis: { ...round.synthesis, status: "running", text: "Comparing perspectives…" },
  };
  fetch.mockResolvedValue(new Response(JSON.stringify({ round: synthesizing })));
  await expect.element(screen.getByText("1 of 3")).toBeVisible();
  // Still reading the first finisher; the later answer joined behind.
  await expect.element(currentPage().getByText("Second answer: ship behind a flag.")).toBeVisible();
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/first-finisher-front.png" });
  const region = screen.getByRole("region", { name: "Council answers" });
  await region.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(currentPage().getByText("First model, later.")).toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(currentPage().getByText("Comparing perspectives…")).toBeVisible();
  await expect.element(screen.getByText("3 of 3")).toBeVisible();
  const complete: CouncilRound = {
    ...synthesizing,
    status: "complete",
    synthesis: {
      ...round.synthesis,
      threadId: "thread-1",
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
  await expect.element(currentPage().getByText("Launch gradually")).toBeVisible();
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/synthesis-page.png" });
  fetch.mockImplementation(async () => new Response(JSON.stringify({ threadId: "thread-1" })));
  await currentPage().getByRole("button", { name: "Continue in Agent Mode" }).click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/environment-1/thread-1"),
  );
  await screen.rerender(<MaxCouncilReturn />);
  await screen.getByRole("button", { name: "Back to Council" }).click();
  expect(screen.router?.state.location.search).toEqual({ round: "round-1" });
  sessionStorage.removeItem("max.returnRound:/environment-1/thread-1");
});

it("turns pages with the previous and next buttons and the page edge", async () => {
  using _selection = freshSelection();
  await phone();
  const { round } = councilFixture();
  round.status = "complete";
  round.contenders = [finished(round.contenders[0]!, "2026-10-29T18:00:01Z")];
  round.synthesis = { ...round.synthesis, status: "complete", text: "Plain synthesis text." };
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await expect.element(screen.getByText("1 of 2")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  await screen.getByRole("button", { name: "Next page" }).first().click();
  await expect.element(currentPage().getByText("Plain synthesis text.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Next page" }).last()).toBeDisabled();
  await screen.getByRole("button", { name: "Previous page" }).click();
  await expect.element(currentPage().getByText(/Start with one well-tested path/)).toBeVisible();
});

it("shows needs-attention and failed/skipped states on their pages", async () => {
  using _selection = freshSelection();
  await phone();
  const { round } = councilFixture();
  round.contenders[0]!.status = "needs-attention";
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await expect
    .element(currentPage().getByText(/This model is waiting for an approval/))
    .toBeVisible();
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/approval-page.png" });
  round.status = "failed";
  round.contenders[0]!.status = "failed";
  round.contenders[0]!.finishedAt = "2026-10-29T18:00:02Z";
  round.contenders[0]!.error = "Provider unavailable";
  round.synthesis.status = "skipped";
  fetch.mockResolvedValue(new Response(JSON.stringify({ round })));
  await screen.rerender(wrapped("round-2"));
  await expect.element(currentPage().getByText("Provider unavailable")).toBeVisible();
  await screen.getByRole("button", { name: "Next page" }).first().click();
  await expect
    .element(currentPage().getByText("No contender answered, so synthesis was skipped."))
    .toBeVisible();
});

it("preserves malformed synthesis as readable raw text", async () => {
  using _selection = freshSelection();
  await phone();
  const { round } = councilFixture();
  round.status = "complete";
  round.contenders = [finished(round.contenders[0]!, "2026-10-29T18:00:01Z")];
  round.synthesis.status = "complete";
  round.synthesis.text = "A useful answer, even without JSON.";
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await screen.getByRole("button", { name: "Next page" }).first().click();
  await expect
    .element(currentPage().getByText(/Couldn’t read the structured format/))
    .toBeVisible();
  await page.screenshot({
    fullPage: false,
    path: "__screenshots__/G1/synthesis-parse-fallback.png",
  });
});

it("explains missing gateway instead of enabling Send", async () => {
  using _selection = freshSelection();
  await phone();
  useCouncilHome.setState({ templates: [], rounds: [], error: null, loaded: false });
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 404 }));
  await using screen = await render(wrapped());
  await expect
    .element(screen.getByText("Council needs the MAX gateway", { exact: true }).first())
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send to council" })).toBeDisabled();
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/council-api-missing.png" });
});

it("creates, edits and deletes a custom template from the model window, keeping built-ins read-only", async () => {
  using _selection = freshSelection();
  await phone();
  useCouncilHome.setState({ templates: [], rounds: [], error: null, loaded: false });
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
  await screen.getByRole("button", { name: "Add files or settings" }).click();
  await page.getByRole("menuitem", { name: "Template and project" }).click();
  const models = page.getByRole("dialog", { name: "Models" });
  await expect.element(models.getByLabelText("Project folder")).toBeVisible();
  await models.getByRole("button", { name: "Manage templates", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Manage templates" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Launch review");
  await dialog
    .getByRole("textbox", { name: "Judge instruction" })
    .fill("Find the safest launch path");
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/template-manager.png" });
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
  using _selection = freshSelection();
  const { round } = councilFixture();
  using hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped(round.id));
  await expect.element(screen.getByText("0 of 1 answered")).toBeVisible();
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

it("keeps the question and files when POST fails and allows retry", async () => {
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ error: "Provider disconnected" }), { status: 500 }),
    );
  await using screen = await render(<ComposerHarness />);
  const prompt = screen.getByRole("textbox", { name: "Question for the council" });
  await prompt.fill("Keep this question");
  await chooseModels(screen);
  await screen.getByRole("button", { name: "Send to council" }).click();
  await expect.element(screen.getByText("Provider disconnected")).toBeVisible();
  await expect.element(prompt).toHaveValue("Keep this question");
  fetch.mockResolvedValue(new Response(JSON.stringify({ round: councilFixture().round })));
  await screen.getByRole("button", { name: "Send to council" }).click();
  await expect.element(screen.getByText("round-1:environment-1")).toBeVisible();
});

it("stages files from the plus button, blocks unreadable images and sends one copy per contender", async () => {
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ round: councilFixture().round }), { status: 201 }),
    );
  await using screen = await render(<ComposerHarness />);
  await screen.getByRole("textbox", { name: "Question for the council" }).fill("Read this");
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(input, [
    new File(["hello"], "notes.txt", { type: "text/plain" }),
    new File([new Uint8Array(4)], "scan.img", { type: "image/x-unknown" }),
  ]);
  await expect
    .element(screen.getByRole("list", { name: "Attached files" }))
    .toHaveTextContent("notes.txt");
  await expect.element(screen.getByText(/scan\.img is an image type/)).toBeVisible();
  await chooseModels(screen);
  await screen.getByRole("button", { name: "Send to council" }).click();
  await expect.element(screen.getByText("round-1:environment-1")).toBeVisible();
  const body = JSON.parse(
    String(fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body),
  );
  expect(body.contenders[0].attachments).toEqual([
    { type: "file", id: "pending_0", name: "file0", mimeType: "text/plain", sizeBytes: 1 },
  ]);
  await expect
    .element(screen.getByRole("list", { name: "Attached files" }))
    .not.toBeInTheDocument();
});

it("cancels an active round through the coordinator", async () => {
  using _selection = freshSelection();
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
  using _selection = freshSelection();
  useCouncilHome.setState({ templates: [], rounds: [], error: null, loaded: false });
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
  await chooseModels(screen);
  await screen.getByRole("button", { name: "Send to council" }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ round: round.id }));
  const body = fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body;
  expect(JSON.parse(String(body))).toMatchObject({
    projectId: null,
    templateId: "meta-debate",
    contenders: [{ instanceId: "codex", roleId: "critic", attachments: [] }],
  });
});

it("shows approvals still required and removes the note for auto mode", async () => {
  using _selection = freshSelection();
  await phone();
  const { round } = councilFixture();
  round.status = "complete";
  round.contenders = [finished(round.contenders[0]!, "2026-10-29T18:00:01Z")];
  round.contenders[0]!.runtimeMode = "approval-required";
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify({ round })));
  await using screen = await render(wrapped("round-1"), { router: "/?round=round-1" });
  await expect
    .element(currentPage().getByText("This model may ask for tool approvals."))
    .toBeVisible();
  round.contenders[0]!.runtimeMode = "auto";
  await screen.rerender(wrapped("round-2"));
  await expect
    .element(screen.getByText("This model may ask for tool approvals."))
    .not.toBeInTheDocument();
});

it("keeps the round open and displays a restore failure", async () => {
  await phone();
  const { round } = councilFixture();
  // A finished answer has a page; only pages carry Continue in Agent Mode.
  round.contenders = [finished(round.contenders[0]!, "2026-10-29T18:00:05Z")];
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ error: "Could not restore council thread" }), {
          status: 502,
        })
      : new Response(JSON.stringify({ round })),
  );
  await using screen = await render(wrapped("round-1"), { router: "/?round=round-1" });
  await currentPage().getByRole("button", { name: "Continue in Agent Mode" }).click();
  await expect.element(screen.getByText("Could not restore council thread")).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/");
  await expect.element(currentPage()).toBeVisible();
});
