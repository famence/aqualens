import { AqualensRenderer } from "./renderer";
import { SvgRenderer, getSharedSvgRenderer } from "./svg-renderer";
import { PowerSaveRenderer, getSharedPowerSaveRenderer } from "./power-save-renderer";
import { resolveRenderMode } from "./detect";
import type { AqualensRenderMode } from "./types";

type AnyRenderer = AqualensRenderer | SvgRenderer | PowerSaveRenderer;

const instances = new Map<string, AnyRenderer>();
const initPromises = new Map<string, Promise<AnyRenderer>>();
let currentMode: "webgl" | "svg" | "css" | null = null;

let lastSnapshotTarget: HTMLElement | null = null;
let lastResolution: number | null = null;

/**
 * Returns a shared renderer for the given mode. Each concrete mode (webgl/svg/css)
 * has its own cached instance so switching modes at runtime works correctly.
 */
export function getSharedRenderer(
  snapshotTarget?: HTMLElement | null,
  resolution?: number,
  mode?: AqualensRenderMode,
): Promise<AnyRenderer> {
  const requestedMode = mode ?? "auto";

  if (requestedMode !== "auto") {
    const existing = instances.get(requestedMode);
    if (existing) {
      currentMode = requestedMode as "webgl" | "svg" | "css";
      return Promise.resolve(existing);
    }
    const pending = initPromises.get(requestedMode);
    if (pending) return pending;
  } else {
    if (currentMode && instances.has(currentMode)) {
      return Promise.resolve(instances.get(currentMode)!);
    }
    const pending = initPromises.get("auto");
    if (pending) return pending;
  }

  const promiseKey = requestedMode;

  const promise = (async () => {
    const resolved = await resolveRenderMode(requestedMode);
    currentMode = resolved;

    const cached = instances.get(resolved);
    if (cached) return cached;

    let renderer: AnyRenderer;

    if (resolved === "css") {
      renderer = getSharedPowerSaveRenderer();
    } else if (resolved === "svg") {
      renderer = getSharedSvgRenderer();
    } else {
      const target = snapshotTarget ?? document.body;
      const resolutionValue = Math.max(0.1, Math.min(3.0, resolution ?? 2.0));
      lastSnapshotTarget = target;
      lastResolution = resolutionValue;

      const webglRenderer = new AqualensRenderer(target, resolutionValue);
      await webglRenderer.captureSnapshot();
      webglRenderer.startRenderLoop();
      renderer = webglRenderer;
    }

    instances.set(resolved, renderer);
    initPromises.delete(promiseKey);
    return renderer;
  })();

  initPromises.set(promiseKey, promise);
  return promise;
}

/**
 * Updates the shared WebGL renderer's snapshot target and/or resolution.
 * No-op for SVG and CSS renderers.
 */
export function updateSharedRendererConfig(
  snapshotTarget?: HTMLElement | null,
  resolution?: number,
): Promise<void> {
  const webgl = instances.get("webgl");
  if (!webgl || !(webgl instanceof AqualensRenderer))
    return Promise.resolve();

  const target =
    snapshotTarget !== undefined ? (snapshotTarget ?? document.body) : null;
  const resolutionValue =
    resolution !== undefined
      ? Math.max(0.1, Math.min(3.0, resolution))
      : null;
  const targetChanged = target !== null && target !== lastSnapshotTarget;
  const resolutionChanged =
    resolutionValue !== null && (lastResolution === null || resolutionValue !== lastResolution);
  if (!targetChanged && !resolutionChanged) return Promise.resolve();

  if (targetChanged && target !== null) {
    webgl.setSnapshotTarget(target);
    lastSnapshotTarget = target;
  }
  if (resolutionChanged && resolutionValue !== null) {
    webgl.setResolution(resolutionValue);
    lastResolution = resolutionValue;
  }
  return webgl.captureSnapshot().then(() => {});
}

/**
 * Sets overlap compositing for the shared WebGL renderer.
 * No-op for SVG and CSS renderers.
 */
export function setOpaqueOverlap(value: boolean): void {
  const webgl = instances.get("webgl");
  if (!webgl || !(webgl instanceof AqualensRenderer)) return;
  if (webgl.opaqueOverlap === value) return;
  webgl.opaqueOverlap = value;
  webgl.requestRender();
}

export function getResolvedMode(): "webgl" | "svg" | "css" | null {
  return currentMode;
}
