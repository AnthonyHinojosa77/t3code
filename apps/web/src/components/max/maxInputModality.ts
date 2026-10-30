const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "CapsLock"]);

export type MaxInputModality = "keyboard" | "pointer";

/**
 * Remembers whether the last input came from a keyboard or a finger/mouse, as
 * `data-max-input` on the document. MAX draws its focus ring only after real keyboard use, so
 * focus that returns to a button after a drawer closes, or that a script moves, shows nothing.
 */
export function installMaxInputModality(doc: Document = document): () => void {
  const controller = new AbortController();
  const set = (modality: MaxInputModality) => {
    if (doc.documentElement.dataset.maxInput !== modality) {
      doc.documentElement.dataset.maxInput = modality;
    }
  };
  const options = { capture: true, passive: true, signal: controller.signal } as const;
  doc.addEventListener(
    "keydown",
    (event) => {
      if (!MODIFIER_KEYS.has(event.key)) set("keyboard");
    },
    options,
  );
  // Touch arrives as pointer events too (iOS 13+); mousedown covers browsers without them.
  doc.addEventListener("pointerdown", () => set("pointer"), options);
  doc.addEventListener("mousedown", () => set("pointer"), options);
  doc.addEventListener("touchstart", () => set("pointer"), options);
  return () => {
    controller.abort();
    delete doc.documentElement.dataset.maxInput;
  };
}
