import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerUsageLimits } from "./ModelPickerUsageLimits";

function antigravity(usageLimits?: ServerProvider["usageLimits"]) {
  const [entry] = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-27T16:20:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...(usageLimits ? { usageLimits } : {}),
    },
  ]);
  return entry!;
}

it("keeps long window names readable at the picker's width", async () => {
  const container = document.createElement("div");
  container.style.width = "316px";
  await using screen = await render(
    <ModelPickerUsageLimits
      entry={antigravity({
        checkedAt: "2026-10-27T16:20:00.000Z",
        windows: [
          {
            id: "3p-5h",
            label: "Claude & GPT (shared) · 5-hour",
            kind: "session",
            usedPercent: 0,
            resetsAt: "2026-10-27T21:20:00.000Z",
            windowDurationMins: 300,
          },
          {
            id: "3p-weekly",
            label: "Claude & GPT (shared) · Weekly",
            kind: "weekly",
            usedPercent: 25,
            resetsAt: "2026-11-03T16:20:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      })}
    />,
    { container },
  );

  for (const label of ["Claude & GPT (shared) · 5-hour", "Claude & GPT (shared) · Weekly"]) {
    const element = screen.getByText(label, { exact: true }).element() as HTMLElement;
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  }
  await expect.element(screen.getByText("100% left")).toBeVisible();
  await expect.element(screen.getByText("75% left")).toBeVisible();
});

it("stays out of the picker when the provider reports no limits", async () => {
  await using screen = await render(<ModelPickerUsageLimits entry={antigravity()} />);

  expect(screen.container.textContent).toBe("");
});
