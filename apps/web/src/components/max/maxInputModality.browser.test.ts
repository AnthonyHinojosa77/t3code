import { expect, it } from "vite-plus/test";

import { installMaxInputModality } from "./maxInputModality";

it("marks keyboard use, pointer use, and ignores lone modifiers", () => {
  const uninstall = installMaxInputModality(document);
  {
    using _tracker = { [Symbol.dispose]: uninstall };
    expect(document.documentElement.dataset.maxInput).toBeUndefined();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    expect(document.documentElement.dataset.maxInput).toBeUndefined();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.documentElement.dataset.maxInput).toBe("keyboard");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.documentElement.dataset.maxInput).toBe("pointer");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.documentElement.dataset.maxInput).toBe("keyboard");
  }
  expect(document.documentElement.dataset.maxInput).toBeUndefined();
});
