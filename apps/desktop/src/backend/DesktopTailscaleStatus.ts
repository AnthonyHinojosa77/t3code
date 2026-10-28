import {
  type DesktopTailscaleStatus as DesktopTailscaleStatusResult,
  EnvironmentId,
  type TailnetPeerEnvironment,
  tailscaleStateFromBackend,
  type TailscaleState,
} from "@t3tools/contracts";
import {
  readT3EnvironmentId,
  readTailscaleStatus,
  type TailscaleCommandError,
  type TailscaleStatus,
  type TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import { tailscaleIpv4AddressKey } from "./DesktopServerExposure.ts";

const CACHE_TTL = Duration.seconds(60);
/** Where `t3 up` boxes and desktops with Tailscale sign-in listen. */
const PROBE_PORT = 3773;
const PROBE_TIMEOUT = Duration.millis(1_500);
const PROBE_CONCURRENCY = 4;

const isEnvironmentId = Schema.is(EnvironmentId);

/**
 * Online peers this user owns or that are tagged. Nodes shared in from other
 * tailnets belong to someone else.
 */
export const tailnetProbeCandidates = (status: TailscaleStatus) =>
  status.backendState !== "Running"
    ? []
    : status.peers.flatMap((peer) => {
        const address = peer.tailnetIpv4Addresses[0];
        const owned =
          peer.tags.length > 0 || (status.selfUserId !== null && peer.userId === status.selfUserId);
        return peer.online && !peer.sharedIn && owned && address !== undefined
          ? [{ peer, address }]
          : [];
      });

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
    /**
     * T3 Code environments among this device's tailnet peers. Probed here, not
     * in the renderer, so ports that are not T3 Code never see a browser fetch.
     */
    readonly discoverEnvironments: Effect.Effect<ReadonlyArray<TailnetPeerEnvironment>>;
  }
>()("@t3tools/desktop/backend/DesktopTailscaleStatus") {}

/** @public */
export const make = Effect.gen(function* () {
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  // Keyed by this device's tailnet addresses, like DesktopServerExposure, so
  // logging in or out reads again while repeated checks skip macOS TCC prompts.
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: CACHE_TTL,
    lookup: (_addresses: string) =>
      readLocalStatus.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  });
  const discoverEnvironments = Effect.gen(function* () {
    const status = yield* readTailscaleStatus;
    const found = yield* Effect.forEach(
      tailnetProbeCandidates(status),
      ({ peer, address }) =>
        readT3EnvironmentId({
          baseUrl: `http://${address}:${PROBE_PORT}`,
          timeout: PROBE_TIMEOUT,
        }).pipe(
          Effect.map((environmentId) =>
            Option.filter(environmentId, isEnvironmentId).pipe(
              Option.map((id): TailnetPeerEnvironment => ({
                name: peer.magicDnsName?.split(".")[0] || peer.hostName || address,
                magicDnsName: peer.magicDnsName,
                tailnetIpv4: address,
                environmentId: id,
              })),
            ),
          ),
        ),
      { concurrency: PROBE_CONCURRENCY },
    );
    return found.flatMap(Option.toArray);
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    // No Tailscale on this device is an empty tailnet, not an error.
    Effect.orElseSucceed((): ReadonlyArray<TailnetPeerEnvironment> => []),
    Effect.withSpan("desktop.tailscaleStatus.discoverEnvironments"),
  );

  return DesktopTailscaleStatus.of({
    read: networkInterfaces.read.pipe(
      Effect.flatMap((interfaces) => Cache.get(cache, tailscaleIpv4AddressKey(interfaces))),
    ),
    discoverEnvironments,
  });
});

export const layer = Layer.effect(DesktopTailscaleStatus, make);
