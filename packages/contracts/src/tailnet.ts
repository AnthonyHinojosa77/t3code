import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Every grant and session a device gets through Tailscale sign-in has this subject prefix. */
export const TAILNET_SUBJECT_PREFIX = "tailscale:";

/** The auth subject of the Tailscale node with this StableID. */
export const tailnetSubject = (stableNodeId: string): string =>
  `${TAILNET_SUBJECT_PREFIX}${stableNodeId}`;

/** A two-minute grant bound to the request's DPoP key. Exchange it at `/oauth/token`. */
export const AuthTailnetSignInResult = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthTailnetSignInResult = typeof AuthTailnetSignInResult.Type;

/** Why this host refused Tailscale sign-in. Each reason is a check from the security model. */
export const TailnetSignInRefusedReason = Schema.Literals([
  "disabled",
  "browser_request",
  "not_direct_tailnet",
  "tailscale_unavailable",
  "tailscale_outdated",
  "owner_unknown",
  "tagged_device",
  "shared_device",
  "other_user",
  "own_node",
  "routes_for_others",
  "blocked",
  "rate_limited",
]);
export type TailnetSignInRefusedReason = typeof TailnetSignInRefusedReason.Type;

/** A device that signed in through Tailscale, or one this host blocks. */
export const TailnetDevice = Schema.Struct({
  stableNodeId: TrimmedNonEmptyString,
  label: Schema.NullOr(TrimmedNonEmptyString),
  blockedAt: Schema.NullOr(Schema.DateTimeUtc),
  activeSessionCount: NonNegativeInt,
});
export type TailnetDevice = typeof TailnetDevice.Type;

export const TailnetDeviceInput = Schema.Struct({
  stableNodeId: TrimmedNonEmptyString,
});
export type TailnetDeviceInput = typeof TailnetDeviceInput.Type;

export const TailnetDeviceList = Schema.Struct({
  devices: Schema.Array(TailnetDevice),
});
export type TailnetDeviceList = typeof TailnetDeviceList.Type;

/** Another T3 Code environment on this host's tailnet. Holds no route or credential. */
export const TailnetPeerEnvironment = Schema.Struct({
  name: TrimmedNonEmptyString,
  magicDnsName: Schema.NullOr(TrimmedNonEmptyString),
  tailnetIpv4: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
});
export type TailnetPeerEnvironment = typeof TailnetPeerEnvironment.Type;

export const TailnetPeerList = Schema.Struct({
  peers: Schema.Array(TailnetPeerEnvironment),
});
export type TailnetPeerList = typeof TailnetPeerList.Type;

export class TailnetAccessError extends Schema.TaggedError<TailnetAccessError>()(
  "TailnetAccessError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
