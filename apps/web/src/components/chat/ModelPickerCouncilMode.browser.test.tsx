import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "./ModelPickerContent";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

function provider(
  instanceId: ProviderInstanceId,
  driver: string,
  usageLimits?: ServerProvider["usageLimits"],
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-29T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(usageLimits ? { usageLimits } : {}),
  };
}

const instanceEntries = deriveProviderInstanceEntries([
  provider(claude, "claudeAgent", {
    checkedAt: "2026-10-29T12:00:00.000Z",
    windows: [
      {
        id: "weekly",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 25,
        resetsAt: "2026-11-03T12:00:00.000Z",
        windowDurationMins: 10080,
      },
    ],
  }),
  provider(codex, "codex"),
]);

const modelOptionsByInstance = new Map([
  [
    claude,
    [
      { slug: "opus", name: "Opus" },
      { slug: "sonnet", name: "Sonnet" },
    ],
  ],
  [codex, [{ slug: "gpt-5", name: "GPT-5" }]],
]);

function Picker(props: Partial<ComponentProps<typeof ModelPickerContent>>) {
  return (
    <ModelPickerContent
      environmentId={null}
      activeInstanceId={claude}
      model=""
      lockedProvider={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      terminalOpen={false}
      searchInputRef={{ current: null }}
      onInstanceModelChange={() => {}}
      {...props}
    />
  );
}

it("council mode toggles a contender on a plain click", async () => {
  const onToggleModel = vi.fn();
  const onInstanceModelChange = vi.fn();
  await using screen = await render(
    <Picker
      selectionMode="council"
      selectedModels={[]}
      onToggleModel={onToggleModel}
      onInstanceModelChange={onInstanceModelChange}
    />,
  );

  await screen.getByText("Opus", { exact: true }).click();

  expect(onToggleModel).toHaveBeenCalledWith(claude, "opus");
  expect(onInstanceModelChange).not.toHaveBeenCalled();
});

it("without council props a plain click still picks one model", async () => {
  const onToggleModel = vi.fn();
  const onInstanceModelChange = vi.fn();
  await using screen = await render(
    <Picker onToggleModel={onToggleModel} onInstanceModelChange={onInstanceModelChange} />,
  );

  await screen.getByText("Opus", { exact: true }).click();

  expect(onInstanceModelChange).toHaveBeenCalledWith(claude, "opus");
  expect(onToggleModel).not.toHaveBeenCalled();
});

it("labels each lab on the rail with its contender count only when asked", async () => {
  const counted = await render(
    <Picker
      selectionMode="council"
      selectedModels={[
        { instanceId: claude, model: "opus" },
        { instanceId: claude, model: "sonnet" },
        { instanceId: codex, model: "gpt-5" },
      ]}
      selectedCountByInstance={
        new Map([
          [claude, 2],
          [codex, 1],
        ])
      }
      onToggleModel={() => {}}
    />,
  );
  await expect.element(counted.getByRole("button", { name: /, 2 selected$/ })).toBeVisible();
  await expect.element(counted.getByRole("button", { name: /, 1 selected$/ })).toBeVisible();
  await counted[Symbol.asyncDispose]();

  await using stock = await render(<Picker />);
  expect(stock.container.textContent).not.toMatch(/selected/);
  expect(stock.container.querySelector('[aria-label$="selected"]')).toBeNull();
});

it("keeps the selected lab's usage bars in council mode", async () => {
  await using screen = await render(
    <Picker selectionMode="council" selectedModels={[]} onToggleModel={() => {}} />,
  );

  await expect.element(screen.getByText("75% left")).toBeVisible();

  const codexTab = screen.container.querySelector<HTMLButtonElement>(
    `[data-model-picker-provider="${codex}"] button`,
  );
  expect(codexTab).not.toBeNull();
  codexTab!.click();

  await expect.element(screen.getByText("GPT-5", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("% left");
});
