import { AppRoot } from "./AppRoot";
import { startAppServices } from "./appInit";

const router = startAppServices();
await router.load();

export default function MaxAuthenticatedApp() {
  return <AppRoot router={router} />;
}
