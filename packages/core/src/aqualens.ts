export {
  getSharedRenderer,
  updateSharedRendererConfig,
  setOpaqueOverlap,
} from "./renderer-singleton";

export { AqualensRenderer } from "./renderer";
export { AqualensLens, LENS_DOM_ATTR } from "./lens";

export {
  PowerSaveRenderer,
  PowerSaveLens,
  getSharedPowerSaveRenderer,
} from "./power-save-renderer";

export type {
  AqualensOptions,
  AqualensLensOptions,
  AqualensLensInstance,
  AqualensRendererInstance,
  AqualensConfig,
  SnapshotSourceElement,
  SnapshotSourceTexture,
  SnapshotSourceTextureSize,
  RefractionOptions,
  GlareOptions,
  DOMRectLike,
  TintColor,
} from "./types";

export { DEFAULT_OPTIONS, DEFAULT_TINT } from "./types";
