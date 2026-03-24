export {
  getSharedRenderer,
  updateSharedRendererConfig,
  setOpaqueOverlap,
} from "./renderer-singleton";

export { AqualensRenderer } from "./renderer";
export { AqualensLens } from "./lens";

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
  RefractionOptions,
  GlareOptions,
  DOMRectLike,
  TintColor,
} from "./types";

export { DEFAULT_OPTIONS, DEFAULT_TINT } from "./types";
