import { AqualensRenderer } from "./renderer";
import type {
  SnapshotSourceElement,
  SnapshotSourceTexture,
  SnapshotSourceTextureSize,
} from "./types";

let instance: AqualensRenderer | null = null;
let initPromise: Promise<AqualensRenderer> | null = null;

/** Last config passed to updateSharedRendererConfig to avoid redundant recapture. */
let lastSnapshotTarget: HTMLElement | null = null;
let lastResolution: number | null = null;
let lastSourceElement: SnapshotSourceElement | null = null;
let lastSourceTexture: SnapshotSourceTexture | null = null;
let lastSourceTextureSize: SnapshotSourceTextureSize | null = null;

/**
 * Returns the shared Aqualens renderer. Creates it on first call (with optional
 * snapshot target and resolution). Subsequent calls return the same instance;
 * config is ignored after first creation. Use updateSharedRendererConfig() when
 * snapshotTarget or resolution props change.
 */
export function getSharedRenderer(
  snapshotTarget?: HTMLElement | null,
  resolution?: number,
  sourceElement?: SnapshotSourceElement | null,
  sourceTexture?: SnapshotSourceTexture | null,
  sourceTextureSize?: SnapshotSourceTextureSize,
): Promise<AqualensRenderer> {
  if (instance) return Promise.resolve(instance);
  if (initPromise) return initPromise;

  const target = snapshotTarget ?? document.body;
  const resolutionValue = Math.max(0.1, Math.min(3.0, resolution ?? 2.0));
  lastSnapshotTarget = target;
  lastResolution = resolutionValue;
  lastSourceElement = sourceElement ?? null;
  lastSourceTexture = sourceTexture ?? null;
  lastSourceTextureSize = sourceTextureSize ?? null;

  initPromise = (async () => {
    const renderer = new AqualensRenderer(target, resolutionValue, {
      sourceElement,
      sourceTexture,
      sourceTextureSize,
    });
    await renderer.captureSnapshot();
    renderer.startRenderLoop();
    instance = renderer;
    return renderer;
  })();

  return initPromise;
}

/**
 * Updates the shared renderer's snapshot target and/or resolution, then recaptures once.
 * No-op if the renderer is not created yet or if target and resolution are unchanged.
 */
export function updateSharedRendererConfig(
  snapshotTarget?: HTMLElement | null,
  resolution?: number,
  sourceElement?: SnapshotSourceElement | null,
  sourceTexture?: SnapshotSourceTexture | null,
  sourceTextureSize?: SnapshotSourceTextureSize,
): Promise<void> {
  if (!instance) return Promise.resolve();
  const target =
    snapshotTarget !== undefined ? snapshotTarget ?? document.body : null;
  const resolutionValue =
    resolution !== undefined ? Math.max(0.1, Math.min(3.0, resolution)) : null;
  const targetChanged = target !== null && target !== lastSnapshotTarget;
  const resolutionChanged =
    resolutionValue !== null &&
    (lastResolution === null || resolutionValue !== lastResolution);
  const nextSourceElement =
    sourceElement !== undefined ? sourceElement ?? null : lastSourceElement;
  const nextSourceTexture =
    sourceTexture !== undefined ? sourceTexture ?? null : lastSourceTexture;
  const nextSourceTextureSize =
    sourceTextureSize !== undefined ? sourceTextureSize ?? null : lastSourceTextureSize;
  const sourceChanged =
    nextSourceElement !== lastSourceElement ||
    nextSourceTexture !== lastSourceTexture ||
    nextSourceTextureSize?.width !== lastSourceTextureSize?.width ||
    nextSourceTextureSize?.height !== lastSourceTextureSize?.height;
  if (!targetChanged && !resolutionChanged && !sourceChanged)
    return Promise.resolve();

  if (targetChanged && target !== null) {
    instance.setSnapshotTarget(target);
    lastSnapshotTarget = target;
  }
  if (resolutionChanged && resolutionValue !== null) {
    instance.setResolution(resolutionValue);
    lastResolution = resolutionValue;
  }
  if (sourceChanged) {
    instance.setSnapshotSource({
      sourceElement: nextSourceElement,
      sourceTexture: nextSourceTexture,
      sourceTextureSize: nextSourceTextureSize,
    });
    lastSourceElement = nextSourceElement;
    lastSourceTexture = nextSourceTexture;
    lastSourceTextureSize = nextSourceTextureSize;
  }
  return instance.captureSnapshot().then(() => {});
}

/**
 * Sets overlap compositing for the shared renderer when lenses use different z-indices.
 * When true, higher z-groups erase lower layers under their shape and sample the original snapshot.
 */
export function setOpaqueOverlap(value: boolean): void {
  if (!instance) return;
  if (instance.opaqueOverlap === value) return;
  instance.opaqueOverlap = value;
  instance.requestRender();
}
