import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { MaxCouncilSidebar } from "./MaxCouncilSidebar";
import { useCouncilHome } from "./councilHome";
import { councilFixture } from "./councilRound.test-fixture";

vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => null,
}));
vi.mock("../../commandPaletteBus", () => ({ openCommandPalette: () => {} }));
vi.mock("../Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: (projects: unknown[]) => projects,
}));
// T3's sidebar frame is covered by its own tests; the panel only needs the drawer state.
vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: () => null,
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
}));

it("lists saved rounds, marks the open one, and starts a new chat", async () => {
  await page.viewport(390, 844);
  useCouncilHome.setState({ templates: [], rounds: [], error: null, loaded: false });
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
  await using screen = await render(
    <div className="max-scope h-screen w-72">
      <MaxCouncilSidebar />
    </div>,
    { router: "/?round=round-1" },
  );
  const item = screen.getByRole("button", { name: /How should we launch/ });
  await expect.element(item).toBeVisible();
  await expect.element(item).toHaveAttribute("aria-current", "page");
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/side-panel.png" });
  await screen.getByRole("button", { name: "New chat" }).click();
  expect(screen.router?.state.location.search).toEqual({});
  await expect.element(item).not.toHaveAttribute("aria-current");
  await item.click();
  expect(screen.router?.state.location.search).toEqual({ round: "round-1" });
  await expect
    .element(screen.getByRole("button", { name: "Add a project for Agent mode" }))
    .toBeVisible();
});
