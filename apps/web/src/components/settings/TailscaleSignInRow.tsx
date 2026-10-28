import { TAILNET_SIGN_IN_PORT } from "@t3tools/client-runtime/connection";
import type { DesktopServerExposureState } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { refreshDesktopNetworkAccessState } from "~/state/desktopNetworkAccess";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The desktop switch that lets this user's own Tailscale devices connect with no code. */
export function TailscaleSignInRow({
  state,
}: {
  readonly state: DesktopServerExposureState | null;
}) {
  const [isUpdating, setIsUpdating] = useState(false);
  const enabled = state?.tailscaleSignInEnabled === true;
  const port = state?.port;
  const movedPort = enabled && port !== undefined && port !== TAILNET_SIGN_IN_PORT;

  const handleChange = async (next: boolean) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const confirmed = await requestConfirmDialog(
      next
        ? `Turn on Tailscale sign-in?\nYour own untagged Tailscale devices get full access with no pairing code. ${
            state?.mode === "network-accessible"
              ? ""
              : "T3 Code listens on your tailnet but stays closed to your LAN. "
          }T3 Code will restart.`
        : "Turn off Tailscale sign-in?\nDevices that signed in through Tailscale disconnect within an hour. T3 Code will restart.",
    );
    if (confirmed !== true) return;
    setIsUpdating(true);
    try {
      await bridge.setTailscaleSignInEnabled(next);
      refreshDesktopNetworkAccessState();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change Tailscale sign-in",
          description: error instanceof Error ? error.message : "The setting was not saved.",
        }),
      );
    }
    setIsUpdating(false);
  };

  return (
    <SettingsRow
      title={searchableSetting("tailscale-sign-in").title}
      description={
        enabled
          ? "Your own Tailscale devices connect with no pairing code."
          : "Let your own Tailscale devices connect with no pairing code."
      }
      status={
        movedPort ? (
          <span className="block text-destructive">
            Port {TAILNET_SIGN_IN_PORT} is in use, so T3 Code runs on {port}. Other devices do not
            find it on their own; add it by name with :{port}.
          </span>
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          disabled={isUpdating || state === null}
          onCheckedChange={(checked) => void handleChange(checked)}
          aria-label="Enable Tailscale sign-in"
        />
      }
    />
  );
}
