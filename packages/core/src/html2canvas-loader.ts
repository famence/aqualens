type Html2CanvasFn = (
  element: HTMLElement,
  options?: Record<string, any>,
) => Promise<HTMLCanvasElement>;

let _html2canvas: Html2CanvasFn | null = null;
let _loadAttempted = false;

/**
 * Lazily loads `html2canvas-pro` via dynamic import.
 * Returns the function on success, or `null` if the package is not installed.
 * Logs a console error on first failure.
 */
export async function getHtml2Canvas(): Promise<Html2CanvasFn | null> {
  if (_html2canvas) return _html2canvas;
  if (_loadAttempted) return null;
  _loadAttempted = true;

  try {
    const mod = await import("html2canvas-pro");
    _html2canvas = mod.default ?? mod;
    return _html2canvas;
  } catch {
    console.error(
      "[aqualens] html2canvas-pro is required for WebGL mode but is not installed.\n" +
      "Install it with: npm install html2canvas-pro",
    );
    return null;
  }
}
