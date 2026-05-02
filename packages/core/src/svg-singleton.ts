import { SvgRenderer } from "./svg-renderer";

let instance: SvgRenderer | null = null;

/**
 * Lazily initialise (and return) the shared SVG renderer. Mirrors the
 * `getSharedRenderer` API of the WebGL backend so callers can swap
 * backends without touching everything else.
 */
export function getSharedSvgRenderer(): SvgRenderer {
  if (typeof document === "undefined") {
    throw new Error(
      "Aqualens SVG: shared renderer requires a browser document",
    );
  }
  if (!instance) instance = new SvgRenderer();
  return instance;
}

/** Toggle macOS-style cascade overlap on the shared SVG renderer. */
export function setSvgOpaqueOverlap(value: boolean): void {
  if (!instance) return;
  if (instance.opaqueOverlap === value) return;
  instance.opaqueOverlap = value;
  instance.requestRender();
}
