import { MoonIcon, SunIcon } from "lucide-react";

/** The light/dark switch's markup, shared by the signed-in header and the sign-in screen. */
export function MaxThemeToggleButton({
  light,
  onToggle,
  className,
}: {
  readonly light: boolean;
  readonly onToggle: () => void;
  readonly className?: string | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      aria-pressed={light}
      data-theme-current={light ? "light" : "dark"}
      className={className ? `max-icon-button ${className}` : "max-icon-button"}
      onClick={onToggle}
    >
      {light ? (
        <MoonIcon aria-hidden="true" className="size-4" />
      ) : (
        <SunIcon aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}
