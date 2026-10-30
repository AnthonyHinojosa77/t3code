/**
 * The one loading screen MAX shows from first paint until the app is on screen. `index.html`
 * paints the same markup before any JavaScript runs and owns its styles (the `.max-boot` rules
 * in its `<style>`), so the sign-in check and the app bundle's Suspense fallback render the
 * identical screen and nothing flashes between them.
 */
export function MaxBootScreen() {
  return (
    <div className="max-boot" data-max-boot="">
      <div className="max-boot-mark">MAX</div>
      <p className="max-boot-status" role="status">
        Connecting…
      </p>
      <div className="max-boot-bar" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
