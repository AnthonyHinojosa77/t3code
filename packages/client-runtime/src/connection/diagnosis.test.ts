import {
  RelayEnvironmentEndpointUnavailableError,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { offTailnetHint, presentConnectionDiagnosis } from "./diagnosis.ts";
import { mapManagedRelayError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionAttemptError,
  type ConnectionRouteOutcome,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "./model.ts";
import { ManagedRelayRequestFailedError } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const fromRelay = (relayError: RelayProtectedError) =>
  mapManagedRelayError(
    new ManagedRelayRequestFailedError({
      action: "connect relay environment",
      cause: relayError,
      relayError,
    }),
  );

const unavailable = (endpointFailure: "tunnel_down" | "origin_unreachable") =>
  fromRelay(
    new RelayEnvironmentEndpointUnavailableError({
      code: "environment_endpoint_unavailable",
      reason: "endpoint_request_failed",
      endpointFailure,
      endpointStatus: endpointFailure === "tunnel_down" ? 530 : 502,
      traceId: "trace-1",
    }),
  );

const tailnetTimeout = new ConnectionTransientError({
  reason: "timeout",
  detail: "Mac mini did not respond during connection setup.",
});
const TAILNET_FAILED: ConnectionRouteOutcome = {
  routeId: "bearer:tailnet",
  kind: "tailnet",
  address: "http://100.64.0.1:3773/",
  result: "failed",
  error: tailnetTimeout,
};
const RELAY_ANSWERED: ConnectionRouteOutcome = {
  routeId: "relay",
  kind: "relay",
  address: null,
  result: "answered",
};

const diagnose = (state: SupervisorConnectionState, via: "relay" | "direct" = "relay") =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state, via });

const results = (state: SupervisorConnectionState, via?: "relay" | "direct") =>
  diagnose(state, via)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("tells a working tunnel apart from T3 Code not answering", () => {
    expect(diagnose(backoff(unavailable("origin_unreachable")))?.headline).toBe(
      "Tunnel works, but T3 Code on Mac mini did not answer",
    );
    expect(results(backoff(unavailable("origin_unreachable")), "direct")).toEqual([
      "device:ok",
      "relay:ok",
      "tunnel:ok",
      "server:failed",
    ]);
  });

  it("blames this device when it cannot reach a tunnel the relay already reached", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
      "relay",
    );
    // A learned LAN route makes the environment's usual route direct; the failure still names the relay.
    const diagnosis = diagnose(backoff(failure), "direct");
    expect(diagnosis?.headline).toBe("This device can't reach Mac mini's tunnel");
    expect(diagnosis?.hops).toHaveLength(4);
    expect(diagnosis?.steps.join(" ")).not.toContain("On Mac mini");
  });

  it("stops at T3 Connect when this device cannot reach the relay", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        transportFailed: true,
        cause: new TypeError("Failed to fetch"),
      }),
    );
    expect(diagnose(backoff(failure))?.headline).toBe("This device can't reach T3 Connect");
    expect(results(backoff(failure))).toEqual([
      "device:ok",
      "relay:failed",
      "tunnel:unchecked",
      "server:unchecked",
    ]);
  });

  it("does not blame this device's network when T3 Connect answered with an error", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("Bad Gateway"),
        status: 502,
      }),
    );
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("T3 Connect returned an error");
    expect(diagnosis?.steps.join(" ")).not.toContain("this device");
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unavailable("tunnel_down")), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("uses the relay health check before any connect attempt fails", () => {
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "relay",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.headline).toBe("Mac mini's tunnel is offline");
    const origin = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "relay",
      relayStatus: { status: "offline", endpointFailure: "origin_unreachable" },
    });
    expect(origin?.hops.map((hop) => hop.hop)).toEqual(["device", "relay", "tunnel", "server"]);
    // Another route may still work, so the relay's health alone is no failure.
    const withDirectRoute = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "origin_unreachable" },
    });
    expect(withDirectRoute).toBeNull();
  });

  it("names a Tailscale route that did not answer and keeps the relay status", () => {
    const state = { ...backoff(tailnetTimeout), routes: [TAILNET_FAILED] };
    const plain = diagnose(state, "direct");
    expect(plain?.headline).toBe("Mac mini did not answer over Tailscale");
    expect(plain?.steps[0]).toBe(
      "Check that Tailscale is on and signed in on this device and on Mac mini.",
    );
    expect(plain?.facts).toContainEqual(["Failed route", "Tailscale http://100.64.0.1:3773/"]);
    expect(plain?.moreInfoUrl).toMatch(/remote-access\.md#tailscale-troubleshooting$/);

    const relayOnline = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state,
      via: "direct",
      relayStatus: { status: "online" },
    });
    expect(relayOnline?.headline).toBe(
      "Mac mini is online on T3 Connect, but its Tailscale address did not answer",
    );
    expect(relayOnline?.facts).toContainEqual(["T3 Connect", "online"]);

    const tailscaleOff = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state,
      via: "direct",
      localTailscale: "stopped",
    });
    expect(tailscaleOff?.headline).toBe("Tailscale is off on this device");
    expect(tailscaleOff?.hops.map((hop) => `${hop.hop}:${hop.result}`)).toEqual([
      "device:failed",
      "server:unchecked",
    ]);

    // A Tailscale route that answered leaves the generic diagnosis.
    const answered = { ...TAILNET_FAILED, result: "answered" } as const;
    expect(diagnose({ ...state, routes: [answered] }, "direct")?.headline).toBe(
      "T3 Code on Mac mini did not answer",
    );
  });
});

describe("offTailnetHint", () => {
  it("hints only when every Tailscale route failed and something else works", () => {
    const connected: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
      routes: [TAILNET_FAILED, RELAY_ANSWERED],
    };
    expect(offTailnetHint(connected)).toBe("Check that Tailscale is on for this device.");
    const offline = { ...connected, network: "offline" as const, routes: [TAILNET_FAILED] };
    expect(offTailnetHint(offline)).toBeNull();
    expect(offTailnetHint({ ...offline, network: "online" })).not.toBeNull();
    expect(offTailnetHint({ ...connected, routes: [RELAY_ANSWERED] })).toBeNull();
  });

  it("keeps the relay health status out of a failure that has its own cause", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
    );
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: backoff(failure),
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.facts.map(([label]) => label)).not.toContain("HTTP status");
  });
});
