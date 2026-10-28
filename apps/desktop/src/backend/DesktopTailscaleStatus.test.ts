import { describe, expect, it } from "@effect/vitest";
import type { TailscalePeer, TailscaleStatus } from "@t3tools/tailscale";

import { tailnetProbeCandidates } from "./DesktopTailscaleStatus.ts";

const peer = (name: string, overrides: Partial<TailscalePeer>): TailscalePeer => ({
  stableNodeId: name,
  hostName: name,
  magicDnsName: `${name}.tail1234.ts.net`,
  os: "linux",
  tailnetIpv4Addresses: [`100.88.1.${name.length}`],
  userId: "owner",
  tags: [],
  sharedIn: false,
  online: true,
  lastSeen: null,
  keyExpired: false,
  active: false,
  curAddr: null,
  relay: null,
  peerRelay: null,
  ...overrides,
});

describe("tailnetProbeCandidates", () => {
  it("probes online peers this user owns or that are tagged, never shared-in ones", () => {
    const status = {
      backendState: "Running",
      selfUserId: "owner",
      peers: [
        peer("studio", {}),
        peer("server", { userId: null, tags: ["tag:server"] }),
        peer("asleep", { online: false }),
        peer("friend", { userId: "friend" }),
        peer("shared", { sharedIn: true }),
      ],
    } as unknown as TailscaleStatus;

    expect(tailnetProbeCandidates(status).map(({ peer }) => peer.hostName)).toEqual([
      "studio",
      "server",
    ]);
    expect(tailnetProbeCandidates({ ...status, backendState: "NeedsLogin" })).toEqual([]);
  });
});
