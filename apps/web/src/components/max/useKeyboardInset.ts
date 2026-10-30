import { useSyncExternalStore } from "react";

function readInset(): number {
  if (typeof window === "undefined") return 0;
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  // iOS Safari shrinks the visual viewport under the keyboard but not the layout viewport.
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

function subscribe(listener: () => void): () => void {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener("resize", listener);
  viewport.addEventListener("scroll", listener);
  return () => {
    viewport.removeEventListener("resize", listener);
    viewport.removeEventListener("scroll", listener);
  };
}

/** Pixels hidden by the software keyboard, so the composer can stay above it. */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, readInset, () => 0);
}
