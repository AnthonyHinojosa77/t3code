import { useTheme } from "../../hooks/useTheme";
import { MaxThemeToggleButton } from "./MaxThemeToggleButton";

/**
 * Old MAX's light/dark switch. The choice is T3's appearance preference, so it persists across
 * reloads and Agent mode follows it too. Dark stays the first-visit default.
 */
export function MaxThemeToggle({ className }: { readonly className?: string }) {
  const { resolvedTheme, setAppearanceMode } = useTheme();
  const light = resolvedTheme === "light";
  return (
    <MaxThemeToggleButton
      light={light}
      className={className}
      onToggle={() => setAppearanceMode(light ? "dark" : "light")}
    />
  );
}
