// @effect-diagnostics nodeBuiltinImport:off - Isolated SQLite and template fixtures.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

import { CouncilCoordinator } from "../src/council/councilCoordinator.ts";
import { CouncilStore } from "../src/council/councilStore.ts";
import { RoleTemplates } from "../src/council/roleTemplates.ts";
import type { CouncilEngine, EngineLaunch, EngineUpdate } from "../src/council/engineClient.ts";
export class FakeEngine implements CouncilEngine {
  launches: EngineLaunch[] = [];
  callbacks = new Map<string, (u: EngineUpdate) => void>();
  interrupts: string[] = [];
  async launch(i: EngineLaunch) {
    this.launches.push(i);
    i.onRuntimeMode?.("auto");
  }
  observe(id: string, fn: (u: EngineUpdate) => void) {
    this.callbacks.set(id, fn);
    return () => {
      this.callbacks.delete(id);
    };
  }
  update(id: string, status: EngineUpdate["status"], text = "answer") {
    this.callbacks.get(id)?.({ status, text });
  }
  async interrupt(id: string) {
    this.interrupts.push(id);
  }
  close() {
    this.callbacks.clear();
  }
}
export function fixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "council-test-"));
  const store = new CouncilStore(NodePath.join(dir, "rounds.sqlite"));
  const templates = new RoleTemplates(NodePath.join(dir, "templates"));
  const engine = new FakeEngine();
  const coordinator = new CouncilCoordinator(store, templates, engine, 1000);
  return {
    dir,
    store,
    templates,
    engine,
    coordinator,
    [Symbol.dispose]() {
      coordinator.close();
      store.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}
export const input = {
  prompt: "  original prompt  ",
  templateId: "meta-debate",
  projectId: null,
  contenders: [
    { instanceId: "one", model: "small", options: [{ id: "reasoningEffort", value: "low" }] },
    { instanceId: "two", model: "fast" },
  ],
  synthesizer: { instanceId: "one", model: "small" },
};
