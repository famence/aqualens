import { AqualensRenderer } from "./renderer";
import { SvgRenderer, getSharedSvgRenderer } from "./svg-renderer";
import { PowerSaveRenderer, getSharedPowerSaveRenderer } from "./power-save-renderer";
import { resolveRenderMode } from "./detect";
import type { AqualensRenderMode } from "./types";

type AnyRenderer = AqualensRenderer | SvgRenderer | PowerSaveRenderer;

let instance: AnyRenderer | null = null;
let initPromise: Promise<AnyRenderer> | null = null;
let resolvedMode: "webgl" | "svg" | "css" | null = null;

let lastSnapshotTarget: HTMLElement | null = null;
let lastResolution: number | null = null;

/**
 * Returns the shared Aqualens renderer. On first call, resolves the render mode
 * and creates the appropriate backend. Subsequent calls return the same instance.
 */
export function getSharedRenderer(
  snapshotTarget?: HTMLElement | null,
  resolution?: number,
  mode?: AqualensRenderMode,
): Promise<AnyRenderer> {
  if (instance) return Promise.resolve(instance);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const resolved = await resolveRenderMode(mode ?? "auto");
    resolvedMode = resolved;

    if (resolved === "css") {
      const renderer = getSharedPowerSaveRenderer();
      instance = renderer;
      return renderer;
    }

    if (resolved === "svg") {
      const renderer = getSharedSvgRenderer();
      instance = renderer;
      return renderer;
    }

    const target = snapshotTarget ?? document.body;
    const resolutionValue = Math.max(0.1, Math.min(3.0, resolution ?? 2.0));
    lastSnapshotTarget = target;
    lastResolution = resolutionValue;

    const renderer = new AqualensRenderer(target, resolutionValue);
    await renderer.captureSnapshot();
    renderer.startRenderLoop();
    instance = renderer;
    return renderer;
  })();

  return initPromise;
}

/**
 * Updates the shared WebGL renderer's snapshot target and/or resolution, then recaptures.
 * No-op for SVG and CSS renderers (they don't use snapshots).
 */
export function updateSharedRendererConfig(
  snapshotTarget?: HTMLElement | null,
  resolution?: number,
): Promise<void> {
  if (!instance || !(instance instanceof AqualensRenderer))
    return Promise.resolve();

  const target =
    snapshotTarget !== undefined ? (snapshotTarget ?? document.body) : null;
  const resolutionValue =
    resolution !== undefined
      ? Math.max(0.1, Math.min(3.0, resolution))
      : null;
  const targetChanged =
    target !== null && target !== lastSnapshotTarget;
  const resolutionChanged =
    resolutionValue !== null && (lastResolution === null || resolutionValue !== lastResolution);
  if (!targetChanged && !resolutionChanged) return Promise.resolve();

  if (targetChanged && target !== null) {
    instance.setSnapshotTarget(target);
    lastSnapshotTarget = target;
  }
  if (resolutionChanged && resolutionValue !== null) {
    instance.setResolution(resolutionValue);
    lastResolution = resolutionValue;
  }
  return instance.captureSnapshot().then(() => {});
}

/**
 * Sets overlap compositing for the shared WebGL renderer.
 * No-op for SVG and CSS renderers.
 */
export function setOpaqueOverlap(value: boolean): void {
  if (!instance || !(instance instanceof AqualensRenderer)) return;
  if (instance.opaqueOverlap === value) return;
  instance.opaqueOverlap = value;
  instance.requestRender();
}

/** Returns the resolved mode after initialization, or null if not yet initialized. */
export function getResolvedMode(): "webgl" | "svg" | "css" | null {
  return resolvedMode;
}
