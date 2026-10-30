import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { MaxAuthGate } from "./components/max/MaxAuthGate";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const AuthenticatedApp = lazy(() => import("./MaxAuthenticatedApp"));

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = (
  <MaxAuthGate>
    <Suspense fallback={<p role="status">Connecting to MAX…</p>}>
      <AuthenticatedApp />
    </Suspense>
  </MaxAuthGate>
);

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.resolve(
  managedAuthShellModule?.then((module) => module.default) ?? null,
)
  .then((ManagedAuthShell) => {
    // Authenticated route loading happens inside the lazy application module.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
