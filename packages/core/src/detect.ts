import type { AqualensRenderMode } from "./types";

let _svgSupported: boolean | null = null;

/**
 * Detect whether the browser supports the SVG filter + CSS backdrop-filter
 * stack required by SvgRenderer.
 */
export function detectSvgFilterSupport(): boolean {
  if (_svgSupported !== null) return _svgSupported;

  if (typeof document === "undefined" || typeof CSS === "undefined") {
    _svgSupported = false;
    return false;
  }

  const backdropOk =
    CSS.supports("backdrop-filter", "blur(1px)") ||
    CSS.supports("-webkit-backdrop-filter", "blur(1px)");

  if (!backdropOk) {
    _svgSupported = false;
    return false;
  }

  let svgFilterOk = false;
  try {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    const filter = document.createElementNS(svgNS, "filter");
    const feDisp = document.createElementNS(svgNS, "feDisplacementMap");
    feDisp.setAttribute("in", "SourceGraphic");
    feDisp.setAttribute("in2", "SourceGraphic");
    feDisp.setAttribute("scale", "1");
    filter.appendChild(feDisp);
    svg.appendChild(filter);
    document.body.appendChild(svg);
    svgFilterOk =
      feDisp instanceof SVGFEDisplacementMapElement &&
      typeof feDisp.scale !== "undefined";
    svg.remove();
  } catch {
    svgFilterOk = false;
  }

  _svgSupported = svgFilterOk;
  return _svgSupported;
}

/**
 * Best-effort low-power device detection.
 * Uses Battery API (where available) and prefers-reduced-motion.
 */
export async function detectLowPower(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  if (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return true;
  }

  try {
    if ("getBattery" in navigator) {
      const battery: any = await (navigator as any).getBattery();
      if (battery && !battery.charging && battery.level < 0.15) {
        return true;
      }
    }
  } catch {
    // Battery API unavailable or blocked
  }

  return false;
}

/**
 * Resolve `"auto"` mode to a concrete renderer backend.
 * Explicit modes (`"webgl"`, `"svg"`, `"css"`) pass through unchanged.
 */
export async function resolveRenderMode(
  mode: AqualensRenderMode = "auto",
): Promise<"webgl" | "svg" | "css"> {
  if (mode === "webgl" || mode === "svg" || mode === "css") return mode;

  const svgOk = detectSvgFilterSupport();
  if (svgOk) return "svg";

  const lowPower = await detectLowPower();
  return lowPower ? "css" : "webgl";
}
