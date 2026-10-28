import {
  t3ConnectTroubleshootingUrl,
  type T3ConnectTroubleshootingSection,
} from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import {
  type ConnectionAttemptError,
  type ConnectionFailureCause,
  type ConnectionHop,
  type ConnectionRouteOutcome,
  routeDidNotAnswer,
  type SupervisorConnectionState,
} from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure, when one exists. */
  readonly moreInfoUrl: string | null;
}

/** This device's own Tailscale state, when the platform can read it. */
export type LocalTailscaleState = "running" | "stopped" | "needs-login" | "not-installed";

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  /**
   * The relay's last health check. For a relay-only environment it can name a
   * cause before any connect attempt; with other routes it is one more fact.
   */
  readonly relayStatus?: Pick<
    RelayEnvironmentStatusResponse,
    "status" | "endpointFailure" | "endpointStatus" | "offlineReason"
  > | null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
  /** Turns the Tailscale hint into a verdict on platforms that can read it. */
  readonly localTailscale?: LocalTailscaleState | null;
}

const TAILSCALE_TROUBLESHOOTING_URL =
  "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md#tailscale-troubleshooting";

const OFF_TAILNET_HINT = "Check that Tailscale is on for this device.";

/** Tailscale routes when every one of them failed to reach the host, else none. */
function failedTailnetRoutes(
  routes: ReadonlyArray<ConnectionRouteOutcome>,
): ReadonlyArray<ConnectionRouteOutcome> {
  const tailnet = routes.filter((route) => route.kind === "tailnet");
  return tailnet.every(routeDidNotAnswer) ? tailnet : [];
}

/**
 * A hint, not a verdict: every Tailscale route failed while another route
 * answered or this device is online, so Tailscale may be off on this device.
 */
export function offTailnetHint(state: SupervisorConnectionState): string | null {
  if (failedTailnetRoutes(state.routes).length === 0) return null;
  const otherAnswered = state.routes.some(
    (route) => route.kind !== "tailnet" && route.result === "answered",
  );
  return otherAnswered || state.network === "online" ? OFF_TAILNET_HINT : null;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause: ConnectionFailureCause | "offline" | "outdated" | "released" | null;
}

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set([
  "origin_unreachable",
  "invalid_response",
]);

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return { hop: unreachable && via === "relay" ? "tunnel" : "server", cause: null };
  }
  // With other routes, the relay's health says nothing about the route in use.
  const status = input.via === "relay" ? input.relayStatus : null;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline":
      return "This device is offline";
    case "outdated":
      return `${host} runs an older T3 Code`;
    case "clock_skew":
      return "This device's clock is off";
    case "not_linked":
      return `${host} is not linked to your T3 Connect account`;
    case "relay_error":
      return "T3 Connect returned an error";
    case "tunnel_pending":
      return `${host}'s tunnel is still being set up`;
    case "tunnel_not_enabled":
      return `T3 Connect is not turned on for ${host}`;
    case "released":
    case "tunnel_down":
      return `${host}'s tunnel is offline`;
    case "origin_unreachable":
      return `Tunnel works, but T3 Code on ${host} did not answer`;
    case "invalid_response":
      return `T3 Code on ${host} sent an unexpected answer`;
    case "dns":
      return `${host}'s tunnel address did not resolve`;
    case "tls":
      return `Secure connection to ${host}'s tunnel failed`;
    case "refused":
      return `${host}'s tunnel refused the connection`;
    case "timeout":
      return `${host} did not answer in time`;
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "This device could not prepare the connection";
    case "relay":
      return failure?.reason === "authentication"
        ? "T3 Connect did not accept this device's sign-in"
        : "This device can't reach T3 Connect";
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? `This device can't reach ${host}'s tunnel`
        : `T3 Connect could not reach ${host}'s tunnel`;
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `T3 Code on ${host} did not accept this device`
        : `T3 Code on ${host} did not answer`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  const checkHost = `On ${host}, check Settings > Sharing & access or run \`t3 connect status\`.`;
  switch (located.cause) {
    case "offline":
      return ["Connect this device to the internet. T3 Code reconnects on its own."];
    case "outdated":
      return [`Update T3 Code on ${host}.`];
    case "clock_skew":
      return [`Turn on automatic date and time on this device and on ${host}, then retry.`];
    case "not_linked":
      return [
        "Check that this device is signed in to the same T3 Connect account as the host.",
        `On ${host}, open Settings > Sharing & access and turn T3 Connect on.`,
      ];
    case "tunnel_pending":
      return ["Wait a minute. T3 Code retries on its own.", checkHost];
    case "relay_error":
      return [
        "Wait a few minutes. T3 Code retries on its own.",
        "If it keeps failing, copy the diagnostics and report it.",
      ];
    case "tunnel_not_enabled":
      return [`On ${host}, open Settings > Sharing & access and turn T3 Connect on.`];
    case "released":
    case "tunnel_down":
      return [
        `Make sure ${host} is awake and T3 Code is running on it.`,
        checkHost,
        `A VPN or Tailscale exit node on ${host} can block the tunnel (port 7844). Turn it off or allow the tunnel.`,
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [`Open or restart T3 Code on ${host}.`, checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [`Make sure ${host} is awake and online.`, checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        "Restart T3 Code on this device.",
        `If it keeps failing, remove ${host} from this device and add it again.`,
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? ["Sign out of T3 Connect and sign in again."]
        : [
            "Check this device's internet connection.",
            "A VPN, firewall, or ad blocker on this device can block T3 Connect.",
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            "A VPN, firewall, or DNS filter on this device can block the tunnel.",
            "Try another network, or add a direct route such as a Tailscale address.",
          ]
        : [`Make sure ${host} is awake and online.`, checkHost];
    case "server":
      return [
        `Make sure T3 Code is running on ${host}.`,
        "Retry. If it keeps failing, copy the diagnostics.",
      ];
  }
}

function helpSection(
  located: Located,
  failure: ConnectionAttemptError | null,
): T3ConnectTroubleshootingSection {
  switch (located.cause) {
    case "offline":
      return "this-device-cant-reach-t3-connect";
    case "outdated":
      return "the-host-runs-an-older-t3-code";
    case "clock_skew":
      return "the-clock-is-off";
    case "not_linked":
    case "tunnel_not_enabled":
      return "sign-in-account-or-link-problems";
    case "relay_error":
      return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending":
      return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response":
      return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return "the-t3-connect-address-does-not-resolve-or-answer";
    case null:
      break;
  }
  const onThisDevice =
    failure?.reason === "network" ||
    failure?.reason === "transport" ||
    failure?.reason === "timeout";
  switch (located.hop) {
    case "device":
      return "this-device-cant-reach-t3-connect";
    case "relay":
      return failure?.reason === "authentication"
        ? "sign-in-account-or-link-problems"
        : "this-device-cant-reach-t3-connect";
    case "tunnel":
      return onThisDevice ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? "sign-in-account-or-link-problems"
        : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "This device";
    case "relay":
      return "T3 Connect";
    case "tunnel":
      return `${host} tunnel`;
    case "server":
      return `T3 Code on ${host}`;
  }
}

function tailnetHeadline(input: ConnectionDiagnosisInput): string {
  const host = input.hostLabel;
  switch (input.localTailscale) {
    case "stopped":
      return "Tailscale is off on this device";
    case "needs-login":
      return "Tailscale on this device needs sign-in";
    case "not-installed":
      return "Tailscale is not installed on this device";
    default:
      return input.relayStatus?.status === "online"
        ? `${host} is online on T3 Connect, but its Tailscale address did not answer`
        : `${host} did not answer over Tailscale`;
  }
}

function tailnetSteps(input: ConnectionDiagnosisInput): string[] {
  const host = input.hostLabel;
  const awake = `Make sure ${host} is awake and T3 Code is running on it.`;
  switch (input.localTailscale) {
    case "stopped":
    case "needs-login":
    case "not-installed":
      return ["Turn on Tailscale on this device and sign in. T3 Code reconnects on its own."];
    case "running":
      return [`Check that Tailscale is on and signed in on ${host}.`, awake];
    default:
      return [`Check that Tailscale is on and signed in on this device and on ${host}.`, awake];
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  // A direct route that did not answer, where every Tailscale route also failed.
  const tailnetRoutes =
    located.hop === "server" &&
    located.cause === null &&
    failure?._tag === "ConnectionTransientError"
      ? failedTailnetRoutes(input.state.routes)
      : [];
  const tailnet = tailnetRoutes.length > 0;
  const tailscaleOff = tailnet && (input.localTailscale ?? "running") !== "running";
  const relayPath =
    located.hop === "relay" ||
    located.hop === "tunnel" ||
    (failure === null && input.relayStatus?.status === "offline") ||
    (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(tailscaleOff ? "device" : located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result: index < failedIndex ? "ok" : index === failedIndex ? "failed" : "unchecked",
  }));

  // The relay health check only explains the state when no attempt has failed yet.
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", located.cause ?? failure?.reason);
  add("HTTP status", httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "Next retry",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", relayPath ? "T3 Connect" : "Direct");
  for (const route of tailnetRoutes) add("Failed route", `Tailscale ${route.address ?? ""}`.trim());
  if (tailnet) add("Tailscale on this device", input.localTailscale);
  if (input.via !== "relay") add("T3 Connect", input.relayStatus?.status);
  add("App version", input.clientVersion);
  add("Host version", input.serverVersion);
  add("Error", failure?.detail);
  add("Trace ID", failure?.traceId);

  return {
    headline: tailnet ? tailnetHeadline(input) : headline(host, located, failure),
    hops,
    steps: tailnet ? tailnetSteps(input) : steps(host, located, failure),
    facts,
    moreInfoUrl: tailnet
      ? TAILSCALE_TROUBLESHOOTING_URL
      : relayPath
        ? t3ConnectTroubleshootingUrl(helpSection(located, failure))
        : null,
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `T3 Code connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}
