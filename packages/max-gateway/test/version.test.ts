// @effect-diagnostics globalFetch:off - Native fetch is the client in this real HTTP integration test.
// @effect-diagnostics nodeBuiltinImport:off - This test drives a real local HTTP server.
import * as NodeNet from "node:net";
import { expect, it } from "vite-plus/test";
import { startTunnelServer } from "../src/tunnelServer.ts";

it("reports only the supplied deployment commit, even without a companion or session", async () => {
  for (const commit of [null, "abc123"]) {
    const server = await startTunnelServer({
      tunnelSecret: "test-only",
      isOwnerRequest: () => false,
      commit,
    });
    try {
      const response = await fetch(`${server.url}/__max/version`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ commit });
      expect(await (await fetch(`${server.url}/__max/health`)).json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  }
});

it("survives an anonymous WebSocket client resetting its rejected upgrade", async () => {
  const server = await startTunnelServer({
    tunnelSecret: "test-only",
    isOwnerRequest: () => false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = NodeNet.connect(server.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          "GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      socket.on("data", () => socket.resetAndDestroy());
      socket.on("close", () => resolve());
    });
    expect(await (await fetch(`${server.url}/__max/health`)).json()).toEqual({ ok: true });
  } finally {
    await server.close();
  }
});
