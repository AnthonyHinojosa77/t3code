import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  DEFAULT_MAX_MODE,
  MAX_MODE_STORAGE_KEY,
  parseMaxMode,
  readMaxMode,
  resolveMaxIndexView,
  writeMaxMode,
} from "./maxMode";

const signedInHost = { hostedStatic: false, environmentsReady: true, environmentCount: 1 };

afterEach(() => {
  removeLocalStorageItem(MAX_MODE_STORAGE_KEY);
});

describe("parseMaxMode", () => {
  it("keeps the two known modes", () => {
    expect(parseMaxMode("council")).toBe("council");
    expect(parseMaxMode("agent")).toBe("agent");
  });

  it("falls back to council for anything else", () => {
    expect(DEFAULT_MAX_MODE).toBe("council");
    for (const value of [null, undefined, "", "Agent", "chat", 1, {}]) {
      expect(parseMaxMode(value)).toBe("council");
    }
  });
});

describe("persisted mode", () => {
  it("defaults to council when nothing is stored", () => {
    expect(readMaxMode()).toBe("council");
  });

  it("round-trips a written mode", () => {
    writeMaxMode("agent");
    expect(readMaxMode()).toBe("agent");
    writeMaxMode("council");
    expect(readMaxMode()).toBe("council");
  });

  it("reads a corrupt stored value as council", () => {
    setLocalStorageItem(MAX_MODE_STORAGE_KEY, "not-a-mode", Schema.String);
    expect(readMaxMode()).toBe("council");
  });
});

describe("resolveMaxIndexView", () => {
  it("shows the council home or the stock landing by mode", () => {
    expect(resolveMaxIndexView({ mode: "council", ...signedInHost })).toBe("council");
    expect(resolveMaxIndexView({ mode: "agent", ...signedInHost })).toBe("agent");
  });

  it("follows a toggle: the stored mode decides what `/` shows next", () => {
    writeMaxMode("agent");
    expect(resolveMaxIndexView({ mode: readMaxMode(), ...signedInHost })).toBe("agent");
    writeMaxMode("council");
    expect(resolveMaxIndexView({ mode: readMaxMode(), ...signedInHost })).toBe("council");
  });

  it("keeps the hosted no-computer branches in both modes", () => {
    for (const mode of ["council", "agent"] as const) {
      expect(
        resolveMaxIndexView({
          mode,
          hostedStatic: true,
          environmentsReady: false,
          environmentCount: 0,
        }),
      ).toBe("pending");
      expect(
        resolveMaxIndexView({
          mode,
          hostedStatic: true,
          environmentsReady: true,
          environmentCount: 0,
        }),
      ).toBe("hosted-empty");
      expect(
        resolveMaxIndexView({
          mode,
          hostedStatic: true,
          environmentsReady: true,
          environmentCount: 2,
        }),
      ).toBe(mode);
    }
  });

  it("ignores environment readiness outside the hosted app", () => {
    expect(
      resolveMaxIndexView({
        mode: "council",
        hostedStatic: false,
        environmentsReady: false,
        environmentCount: 0,
      }),
    ).toBe("council");
  });
});
