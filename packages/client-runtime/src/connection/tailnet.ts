import type {
  AuthClientPresentationMetadata,
  EnvironmentId,
  TailnetPeerEnvironment,
  TailnetSignInRefusedReason,
} from "@t3tools/contracts";
import { isSharedAddressSpaceHost, normalizeHostname } from "@t3tools/shared/hostClassification";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

/** Where `t3 up` and the desktop "Tailscale sign-in" switch listen. */
export const TAILNET_SIGN_IN_PORT = 3773;

const SINGLE_LABEL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function isTailnetName(hostname: string): boolean {
  if (hostname.endsWith(".ts.net")) return true;
  return SINGLE_LABEL_HOST.test(hostname) && !/^\d+$/u.test(hostname) && hostname !== "localhost";
}

/**
 * The direct tailnet address to sign in at, from what a user typed or scanned:
 * `studio`, `studio.tailnet.ts.net`, or `100.x.y.z`, each with an optional
 * port, or a plain `http://` URL with no pairing code (the `t3 up` QR). Null
 * for anything else, which goes to the pairing-code flow.
 */
export function tailnetSignInBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return null;
  // A path, query, or fragment is a pairing link, not a bare address.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  const hostname = normalizeHostname(url.hostname);
  if (!isSharedAddressSpaceHost(hostname) && !isTailnetName(hostname)) return null;
  return `http://${hostname}:${url.port === "" ? TAILNET_SIGN_IN_PORT : url.port}/`;
}

/** Hosts refuse browser origins, and a page on plain `http://100.x` cannot make a DPoP key. */
export function supportsTailnetSignIn(metadata: AuthClientPresentationMetadata): boolean {
  return metadata.surface === "desktop" || metadata.surface === "mobile";
}

// Off Tailscale, a pinned name can resolve to a LAN address the host refuses; it
// works again once Tailscale is back, like the other two.
const TRANSIENT_REFUSALS: ReadonlySet<TailnetSignInRefusedReason> = new Set([
  "not_direct_tailnet",
  "tailscale_unavailable",
  "rate_limited",
]);

export function tailnetRefusalError(reason: TailnetSignInRefusedReason, traceId?: string) {
  const fields = {
    detail: `The environment refused Tailscale sign-in (${reason}).`,
    hop: "server" as const,
    via: "direct" as const,
    tailnetRefusal: reason,
    ...(traceId === undefined ? {} : { traceId }),
  };
  return TRANSIENT_REFUSALS.has(reason)
    ? new ConnectionTransientError({ reason: "remote-unavailable", ...fields })
    : new ConnectionBlockedError({ reason: "permission", ...fields });
}

export type DiscoveredMachineAction =
  | { readonly _tag: "Add" }
  | { readonly _tag: "Skip" }
  /** A saved environment answered at an address it was never saved with. */
  | { readonly _tag: "Conflict"; readonly label: string };

function routeHosts(entry: ConnectionCatalogEntry): ReadonlySet<string> {
  return new Set(
    connectionRoutes(entry).flatMap((route) => {
      const url = routeHttpBaseUrl(route);
      return url !== null && URL.canParse(url) ? [normalizeHostname(new URL(url).hostname)] : [];
    }),
  );
}

/**
 * What to do with a machine found on the tailnet. A removed machine stays
 * removed, and a found address never joins a saved environment's routes: the
 * public descriptor does not prove which machine answered.
 */
export function discoveredMachineAction(input: {
  readonly machine: Pick<TailnetPeerEnvironment, "environmentId" | "tailnetIpv4" | "magicDnsName">;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly dismissed: ReadonlySet<EnvironmentId>;
}): DiscoveredMachineAction {
  const { machine } = input;
  if (input.dismissed.has(machine.environmentId)) return { _tag: "Skip" };
  const saved = input.entries.get(machine.environmentId);
  if (saved === undefined) return { _tag: "Add" };
  const hosts = routeHosts(saved);
  const dnsName = machine.magicDnsName === null ? null : normalizeHostname(machine.magicDnsName);
  const known =
    hosts.has(normalizeHostname(machine.tailnetIpv4)) ||
    (dnsName !== null && (hosts.has(dnsName) || hosts.has(dnsName.split(".")[0]!)));
  // Without a direct address to compare, T3 Connect and SSH routes cannot conflict.
  if (known || hosts.size === 0) return { _tag: "Skip" };
  return { _tag: "Conflict", label: saved.target.label };
}

/** Machines with `tailnetSignIn` that `discoveredMachineAction` would add, once per environment. */
export function machinesToAdd<
  Machine extends Pick<TailnetPeerEnvironment, "environmentId" | "tailnetIpv4" | "magicDnsName">,
>(input: {
  readonly machines: ReadonlyArray<Machine>;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly dismissed: ReadonlySet<EnvironmentId>;
}): {
  readonly add: ReadonlyArray<Machine>;
  readonly conflicts: ReadonlyArray<{ readonly machine: Machine; readonly label: string }>;
} {
  const seen = new Set<EnvironmentId>();
  const add: Machine[] = [];
  const conflicts: Array<{ readonly machine: Machine; readonly label: string }> = [];
  for (const machine of input.machines) {
    if (seen.has(machine.environmentId)) continue;
    seen.add(machine.environmentId);
    const action = discoveredMachineAction({ ...input, machine });
    if (action._tag === "Add") add.push(machine);
    if (action._tag === "Conflict") conflicts.push({ machine, label: action.label });
  }
  return { add, conflicts };
}
