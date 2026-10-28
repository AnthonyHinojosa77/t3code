import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useEffectEvent, useRef } from "react";

import { discoverTailnetMachines } from "~/connection/onboarding";
import { environmentSummaries } from "~/state/presentation";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";

const DISCOVERY_INTERVAL_MS = 5 * 60_000;
// Machines connect one by one at startup; one pass covers them all.
const DISCOVERY_MIN_GAP_MS = 30_000;

/**
 * Adds the T3 Code machines on this desktop's tailnet that offer Tailscale
 * sign-in, from its own peer list and from each connected machine, and says so.
 */
export function TailnetDiscoveryCoordinator() {
  const registry = useContext(RegistryContext);
  const discover = useAtomCommand(discoverTailnetMachines, { reportFailure: false });
  // Each conflict is worth one warning per app run, not one every few minutes.
  const warned = useRef(new Set<string>());
  const lastRunAt = useRef(0);

  const run = useEffectEvent(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || Date.now() - lastRunAt.current < DISCOVERY_MIN_GAP_MS) return;
    lastRunAt.current = Date.now();
    const found = await bridge.discoverTailnetEnvironments().catch(() => []);
    const result = await discover(found);
    if (result._tag !== "Success") return;
    for (const machine of result.value.added) {
      toastManager.add({
        type: "success",
        title: `Added ${machine.label}`,
        description: "Found on your tailnet. Remove it in Settings to stop adding it.",
      });
    }
    for (const conflict of result.value.conflicts) {
      const key = `${conflict.label}@${conflict.address}`;
      if (warned.current.has(key)) continue;
      warned.current.add(key);
      toastManager.add({
        type: "warning",
        title: `${conflict.label} answered at a new address`,
        description: `${conflict.address} is not one of its saved routes, so it was not added. Make sure that address is really this machine before you add it as a route.`,
      });
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the tailnet, an outside system, at start, every few minutes, and when the connected machines change
  useEffect(() => {
    const unsubscribe = registry.subscribe(
      environmentSummaries.connectedEnvironmentIdsAtom,
      () => void run(),
      { immediate: true },
    );
    const timer = setInterval(() => void run(), DISCOVERY_INTERVAL_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [registry]);

  return null;
}
