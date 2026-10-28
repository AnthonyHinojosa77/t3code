import { type TailnetPeerEnvironment, WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";

import * as ConnectionOnboarding from "../connection/onboarding.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

const PEER_LIST_TIMEOUT = Duration.seconds(10);
const PEER_LIST_CONCURRENCY = 4;

/** Block and Unblock for the devices that signed in to a host through Tailscale. */
export function createTailnetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    listDevices: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet:list-devices",
      tag: WS_METHODS.tailnetDevicesList,
    }),
    blockDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet:block-device",
      tag: WS_METHODS.tailnetDevicesBlock,
    }),
    unblockDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet:unblock-device",
      tag: WS_METHODS.tailnetDevicesUnblock,
    }),
  };
}

/**
 * Adds the T3 Code machines on the tailnet that offer Tailscale sign-in: the
 * ones this device found itself (`found`, from the desktop's peer list) and the
 * ones each connected machine reports. Machines that cannot answer are skipped.
 */
export const discoverTailnetMachines = Effect.fn("clientRuntime.tailnet.discoverMachines")(
  function* (found: ReadonlyArray<TailnetPeerEnvironment>) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    const environmentIds = [...(yield* SubscriptionRef.get(registry.entries)).keys()];
    const reported = yield* Effect.forEach(
      environmentIds,
      (environmentId) =>
        registry.state(environmentId).pipe(
          Effect.flatMap((state) =>
            state.phase === "connected"
              ? registry.run(environmentId, request(WS_METHODS.tailnetPeersList, {}))
              : Effect.succeed({ peers: [] }),
          ),
          Effect.timeout(PEER_LIST_TIMEOUT),
          // Older hosts and narrow sessions cannot list peers.
          Effect.orElseSucceed(() => ({ peers: [] })),
        ),
      { concurrency: PEER_LIST_CONCURRENCY },
    );
    return yield* onboarding.addDiscoveredTailnetMachines([
      ...found,
      ...reported.flatMap((answer) => answer.peers),
    ]);
  },
);
