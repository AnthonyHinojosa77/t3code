import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  useLocalStorage,
  writeLocalStorageValue,
} from "../../hooks/useLocalStorage";

/**
 * Council mode shows the MAX home at `/`. Agent mode keeps T3's stock `/`,
 * which opens a draft in the most recent project. Thread routes are the same in both.
 */
export type MaxMode = "council" | "agent";

export const MAX_MODE_STORAGE_KEY = "max.mode";
export const DEFAULT_MAX_MODE: MaxMode = "council";

const MaxModeSchema = Schema.Literals(["council", "agent"]);

/** Anything that is not a known mode falls back to council. */
export function parseMaxMode(value: unknown): MaxMode {
  return value === "council" || value === "agent" ? value : DEFAULT_MAX_MODE;
}

export function readMaxMode(): MaxMode {
  try {
    return parseMaxMode(getLocalStorageItem(MAX_MODE_STORAGE_KEY, MaxModeSchema));
  } catch {
    return DEFAULT_MAX_MODE;
  }
}

export function writeMaxMode(mode: MaxMode): void {
  writeLocalStorageValue(MAX_MODE_STORAGE_KEY, mode, DEFAULT_MAX_MODE, MaxModeSchema);
}

/** Leaves Agent mode: council is stored first, so `/` renders the council home. */
export function returnToCouncil(goHome: () => unknown): void {
  writeMaxMode("council");
  void goHome();
}

/** Shared across components: a write from the sidebar re-renders the `/` route. */
export function useMaxMode(): [MaxMode, (mode: MaxMode) => void] {
  const [mode, setMode] = useLocalStorage(MAX_MODE_STORAGE_KEY, DEFAULT_MAX_MODE, MaxModeSchema);
  return [parseMaxMode(mode), setMode];
}

export type MaxIndexView = "pending" | "hosted-empty" | "council" | "agent";

/** What `/` shows. The hosted no-computer branches run first, in both modes. */
export function resolveMaxIndexView(input: {
  readonly mode: MaxMode;
  readonly hostedStatic: boolean;
  readonly environmentsReady: boolean;
  readonly environmentCount: number;
}): MaxIndexView {
  if (input.hostedStatic) {
    if (!input.environmentsReady) return "pending";
    if (input.environmentCount === 0) return "hosted-empty";
  }
  return input.mode;
}
