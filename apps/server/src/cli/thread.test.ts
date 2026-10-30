import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type ThreadTools,
  waitForRun,
  resolveStartModelOptions,
  ThreadUsageError,
} from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

const modelTools = (options: Array<{ id: string; values: Array<string | boolean> }>) =>
  scriptedTools({
    orchestrator_capabilities: [
      {
        providers: [
          { providerInstanceId: "test-provider", models: [{ id: "test-model", options }] },
        ],
      },
    ],
  });
const codexOptions = [
  { id: "reasoningEffort", values: ["low", "high"] },
  { id: "serviceTier", values: ["flex", "priority", "ultrafast"] },
];

it.effect("start maps shortcuts using the selected model's advertised options", () =>
  Effect.gen(function* () {
    const { tools, calls } = modelTools(codexOptions);
    assert.deepStrictEqual(
      yield* resolveStartModelOptions(tools, {
        provider: "test-provider",
        model: "test-model",
        effort: "high",
        fast: true,
      }),
      [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    );
    assert.deepStrictEqual(calls[0]?.args, { search: "test-model" });
  }),
);
it.effect("start maps Claude effort and boolean fast mode", () =>
  Effect.gen(function* () {
    const { tools } = modelTools([
      { id: "effort", values: ["max"] },
      { id: "fastMode", values: [false, true] },
    ]);
    assert.deepStrictEqual(
      yield* resolveStartModelOptions(tools, {
        provider: "test-provider",
        model: "test-model",
        effort: "max",
        fast: true,
      }),
      [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ],
    );
  }),
);
it.effect("explicit JSON overrides shortcuts, in both canonical and object forms", () =>
  Effect.gen(function* () {
    for (const modelOptions of [
      '[{"id":"reasoningEffort","value":"low"}]',
      '{"reasoningEffort":"low"}',
    ]) {
      const { tools } = modelTools(codexOptions);
      assert.deepStrictEqual(
        yield* resolveStartModelOptions(tools, {
          provider: "test-provider",
          model: "test-model",
          effort: "high",
          fast: false,
          modelOptions,
        }),
        [{ id: "reasoningEffort", value: "low" }],
      );
    }
  }),
);
it.effect("start lists allowed effort values and rejects unsupported fast mode", () =>
  Effect.gen(function* () {
    for (const flags of [{ effort: "max", fast: false }, { fast: true }]) {
      const { tools } = modelTools([codexOptions[0]!]);
      const error = yield* resolveStartModelOptions(tools, {
        provider: "test-provider",
        model: "test-model",
        ...flags,
      }).pipe(Effect.flip);
      assert.instanceOf(error, ThreadUsageError);
      assert.match(error.message, /Allowed/);
    }
  }),
);
it.effect("start rejects malformed JSON, invalid shapes and unadvertised options", () =>
  Effect.gen(function* () {
    for (const modelOptions of [
      "{",
      "null",
      "42",
      '{"effort":42}',
      "[{}]",
      '{"unknown":true}',
      '{"reasoningEffort":"max"}',
    ]) {
      const { tools } = modelTools(codexOptions);
      const error = yield* resolveStartModelOptions(tools, {
        provider: "test-provider",
        model: "test-model",
        fast: false,
        modelOptions,
      }).pipe(Effect.flip);
      assert.instanceOf(error, ThreadUsageError);
    }
  }),
);
it.effect("start requires the model pair for options and does not probe without options", () =>
  Effect.gen(function* () {
    const { tools, calls } = modelTools([]);
    assert.instanceOf(
      yield* resolveStartModelOptions(tools, { fast: true }).pipe(Effect.flip),
      ThreadUsageError,
    );
    assert.isUndefined(yield* resolveStartModelOptions(tools, { fast: false }));
    assert.deepStrictEqual(calls, []);
  }),
);
it.effect("start rejects a model not returned by the server", () =>
  Effect.gen(function* () {
    const { tools } = modelTools(codexOptions);
    const error = yield* resolveStartModelOptions(tools, {
      provider: "other-provider",
      model: "test-model",
      fast: true,
    }).pipe(Effect.flip);
    assert.match(error.message, /not advertised/);
  }),
);

it.effect("start supports the legacy advertised fast service tier", () =>
  Effect.gen(function* () {
    const { tools } = modelTools([{ id: "serviceTier", values: ["default", "fast"] }]);
    assert.deepStrictEqual(
      yield* resolveStartModelOptions(tools, {
        provider: "test-provider",
        model: "test-model",
        fast: true,
      }),
      [{ id: "serviceTier", value: "fast" }],
    );
  }),
);
