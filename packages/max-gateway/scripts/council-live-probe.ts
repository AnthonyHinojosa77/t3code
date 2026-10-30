// @effect-diagnostics nodeBuiltinImport:off - Standalone live probe script without an Effect runtime.
// @effect-diagnostics globalConsole:off - Operator-facing probe output.
// @effect-diagnostics globalTimers:off - Bounded probe polling.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

import { BearerTokenSource } from "../src/bearerToken.ts";
import { EngineClient } from "../src/council/engineClient.ts";
import { CouncilStore } from "../src/council/councilStore.ts";
import { RoleTemplates } from "../src/council/roleTemplates.ts";
import { CouncilCoordinator } from "../src/council/councilCoordinator.ts";

const engine = new EngineClient(new BearerTokenSource());
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "council-probe-"));
const store = new CouncilStore(NodePath.join(directory, "rounds.sqlite"));
const coordinator = new CouncilCoordinator(
  store,
  new RoleTemplates(NodePath.join(directory, "templates")),
  engine,
  120000,
);
let roundId: string | undefined;
try {
  const config = await engine.rpc<{
    providers: { instanceId: string; status: string; models: { slug: string }[] }[];
  }>("server.getConfig", {});
  console.log(
    "Providers:",
    JSON.stringify(
      config.providers
        .filter((p) => ["codex", "claudeAgent"].includes(p.instanceId))
        .map((p) => ({
          instanceId: p.instanceId,
          status: p.status,
          models: p.models.map((m) => m.slug),
        })),
    ),
  );
  const defaults = [
    {
      instanceId: "codex",
      model: "gpt-6-luna",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "serviceTier", value: "default" },
      ],
    },
    { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
  ];
  const models = process.env.COUNCIL_PROBE_MODELS
    ? JSON.parse(process.env.COUNCIL_PROBE_MODELS)
    : defaults;
  if (
    !Array.isArray(models) ||
    models.length !== 2 ||
    !models.every((model) =>
      config.providers.some(
        (provider) =>
          provider.instanceId === model.instanceId &&
          provider.status === "ready" &&
          provider.models.some((candidate) => candidate.slug === model.model),
      ),
    )
  ) {
    throw new Error("Select exactly two ready subscription models with COUNCIL_PROBE_MODELS");
  }
  const round = coordinator.create({
    prompt: "Reply with exactly one word: ready",
    templateId: "meta-debate",
    projectId: null,
    contenders: models,
    synthesizer: models[0],
  });
  roundId = round.id;
  await new Promise<void>((resolve) => {
    let last = "";
    const timer = setInterval(() => {
      const current = store.get(round.id);
      const status = JSON.stringify({
        round: current.status,
        contenders: current.contenders.map((c) => c.status),
        synthesis: current.synthesis.status,
      });
      if (status !== last) {
        console.log(status);
        last = status;
      }
      if (["complete", "failed", "cancelled"].includes(current.status)) {
        clearInterval(timer);
        console.log("Final:", JSON.stringify(current));
        resolve();
      }
    }, 500);
  });
} finally {
  if (roundId) {
    const round = coordinator.cancel(roundId);
    for (const s of [...round.contenders, round.synthesis])
      if (s.threadId) {
        try {
          await engine.archive(s.threadId);
          console.log("Archived:", s.threadId);
        } catch {
          console.log("UNVERIFIED archive:", s.threadId);
        }
      }
  }
  coordinator.close();
  store.close();
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
