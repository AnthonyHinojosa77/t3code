// @effect-diagnostics nodeBuiltinImport:off - A local WebSocket fixture verifies wire compatibility.
import * as NodeNet from "node:net";

import { WebSocketServer } from "ws";
import { expect, it } from "vite-plus/test";
import { EngineClient, councilRuntimeMode } from "../src/council/engineClient.ts";
import { BearerTokenSource } from "../src/bearerToken.ts";
it("uses scoped WS RPC, passes options, observes pending input, and reconnects", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const calls: { tag: string; payload: Record<string, unknown> }[] = [];
  let auth: string | undefined;
  server.on("connection", (socket, request) => {
    auth = request.headers.authorization;
    socket.on("message", (bytes) => {
      const frame = JSON.parse(bytes.toString());
      calls.push(frame);
      const value =
        frame.tag === "server.getConfig"
          ? { providers: [] }
          : frame.tag === "projects.ensureScratch"
            ? { projectId: "scratch" }
            : frame.tag === "orchestration.getThreadProjection"
              ? {
                  messages: [{ role: "assistant", text: "partial" }],
                  runs: [{ status: "running" }],
                  runtimeRequests: [{ status: "pending" }],
                }
              : {};
      socket.send(
        JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }),
      );
    });
  });
  const engine = new EngineClient(
    new BearerTokenSource({ env: { MAX_COMPANION_BEARER_TOKEN: "fixture-token" } }),
    `ws://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
  );
  try {
    const model = {
      instanceId: "test",
      model: "small",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    await engine.launch({
      threadId: "thread-test",
      title: "Council",
      projectId: null,
      model,
      prompt: "exact prompt",
    });
    expect(auth).toBe("Bearer fixture-token");
    expect(calls.find((c) => c.tag === "orchestration.launchThread")?.payload).toMatchObject({
      projectId: "scratch",
      runtimeMode: "approval-required",
      modelSelection: model,
      initialMessage: { text: "exact prompt" },
    });
    const update = await new Promise<unknown>((resolve) => {
      const stop = engine.observe("thread-test", (value) => {
        stop();
        resolve(value);
      });
    });
    expect(update).toEqual({ status: "needs-attention", text: "partial" });
    const socket = [...server.clients][0]!;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
    await engine.interrupt("thread-test");
    expect(calls.at(-1)?.payload.type).toBe("thread.stop");
  } finally {
    engine.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  [["approval-required", "auto", "full-access"], "auto"],
  [["approval-required", "auto-accept-edits", "full-access"], "approval-required"],
  [[], "approval-required"],
])("selects only an advertised council-safe mode: %j", (modes, expected) => {
  expect(councilRuntimeMode(modes)).toBe(expected);
});

it.each([false, true])(
  "uses advertised auto and retries a rejection only once (reject fallback: %s)",
  async (rejectFallback) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const launches: Record<string, unknown>[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.tag === "orchestration.launchThread") launches.push(frame.payload);
        const rejected =
          frame.tag === "orchestration.launchThread" &&
          (frame.payload.runtimeMode === "auto" || rejectFallback);
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: frame.id,
            exit: rejected
              ? { _tag: "Failure", cause: {} }
              : {
                  _tag: "Success",
                  value:
                    frame.tag === "server.getConfig"
                      ? {
                          providers: [
                            { instanceId: "test", supportedRuntimeModes: ["auto", "full-access"] },
                          ],
                        }
                      : {},
                },
          }),
        );
      });
    });
    const engine = new EngineClient(
      new BearerTokenSource({ env: { MAX_COMPANION_BEARER_TOKEN: "fixture-token" } }),
      `ws://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    );
    const recorded: string[] = [];
    try {
      const result = engine.launch({
        threadId: "retry-test",
        title: "Council",
        projectId: "scratch",
        model: { instanceId: "test", model: "small" },
        prompt: "ready",
        onRuntimeMode: (mode) => recorded.push(mode),
      });
      if (rejectFallback) await expect(result).rejects.toThrow("Engine RPC rejected");
      else await result;
      expect(launches.map((l) => l.runtimeMode)).toEqual(["auto", "approval-required"]);
      expect(recorded).toEqual(["auto", "approval-required"]);
      expect(launches[0]?.commandId).not.toBe(launches[1]?.commandId);
    } finally {
      engine.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
