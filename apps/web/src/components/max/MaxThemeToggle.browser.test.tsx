import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { MaxThemeToggle } from "./MaxThemeToggle";

it("switches to old MAX's light mode and remembers it", async () => {
  localStorage.removeItem("t3code:theme-appearance-mode");
  await using screen = await render(
    <div className="max-scope p-4">
      <MaxThemeToggle />
    </div>,
  );
  await screen.getByRole("button", { name: "Switch to light mode" }).click();
  expect(localStorage.getItem("t3code:theme-appearance-mode")).toBe("light");
  await expect.element(screen.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(getComputedStyle(screen.container.firstElementChild!).backgroundColor).toBe(
    "rgb(192, 192, 192)",
  );
  await page.screenshot({ fullPage: false, path: "__screenshots__/G1/light-toggle.png" });
  await screen.getByRole("button", { name: "Switch to dark mode" }).click();
  expect(localStorage.getItem("t3code:theme-appearance-mode")).toBe("dark");
  localStorage.removeItem("t3code:theme-appearance-mode");
});
