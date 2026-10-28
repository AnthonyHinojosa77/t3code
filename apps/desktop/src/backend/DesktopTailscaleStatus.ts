import {
  type DesktopTailscaleStatus as DesktopTailscaleStatusResult,
  tailscaleStateFromBackend,
  type TailscaleState,
} from "@t3tools/contracts";
import {
  readTailscaleStatus,
  type TailscaleCommandError,
  type TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import { tailscaleIpv4AddressKey } from "./DesktopServerExposure.ts";

const CACHE_TTL = Duration.seconds(60);

function stateOfReadError(
  error: TailscaleCommandError | TailscaleStatusParseError,
): TailscaleState {
  switch (error._tag) {
    case "TailscaleCommandSpawnError":
      return "not_installed";
    case "TailscaleCommandExitError":
      if (error.stderrDiagnostic === "not-logged-in") return "needs_login";
      return error.stderrDiagnostic === "permission-denied" ? "unreadable" : "not_running";
    default:
      return "unreadable";
  }
}

const readLocalStatus = Effect.gen(function* () {
  const read = yield* Effect.result(readTailscaleStatus);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (Result.isFailure(read)) {
    return { state: stateOfReadError(read.failure), checkedAt, peers: [] };
  }
  return {
    state: tailscaleStateFromBackend(read.success.backendState),
    checkedAt,
    peers: read.success.peers.map((peer) => ({
      tailnetAddresses: peer.tailnetIpv4Addresses,
      magicDnsName: peer.magicDnsName,
      online: peer.online,
      lastSeen: peer.lastSeen,
      active: peer.active,
      curAddr: peer.curAddr,
      relay: peer.relay,
      peerRelay: peer.peerRelay,
    })),
  };
}).pipe(Effect.withSpan("desktop.tailscaleStatus.read"));

export class DesktopTailscaleStatus extends Context.Service<
  DesktopTailscaleStatus,
  {
    /** This device's Tailscale, for connection diagnosis. Read only on request, never polled. */
    readonly read: Effect.Effect<DesktopTailscaleStatusResult>;
  }
>()("@t3tools/desktop/backend/DesktopTailscaleStatus") {}

/** @public */
export const make = Effect.gen(function* () {
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Keyed by this device's tailnet addresses, like DesktopServerExposure, so
  // logging in or out reads again while repeated checks skip macOS TCC prompts.
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: CACHE_TTL,
    lookup: (_addresses: string) =>
      readLocalStatus.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  });
  return DesktopTailscaleStatus.of({
    read: networkInterfaces.read.pipe(
      Effect.flatMap((interfaces) => Cache.get(cache, tailscaleIpv4AddressKey(interfaces))),
    ),
  });
});

export const layer = Layer.effect(DesktopTailscaleStatus, make);
