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

export {
  SvgRenderer,
  SvgLens,
  SVG_LENS_DOM_ATTR,
} from "./svg-renderer";
export {
  getSharedSvgRenderer,
  setSvgOpaqueOverlap,
} from "./svg-singleton";
export {
  supportsSvgBackdropFilter,
  _setSvgSupportForTesting,
} from "./svg-detection";
export {
  CONVEX_CIRCLE,
  CONVEX_SQUIRCLE,
  CONCAVE,
  LIP,
  resolveSurfaceFn,
} from "./svg-surface";

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
  RenderMode,
  SurfaceShape,
} from "./types";

export type { SurfaceFn, SurfaceFnDef } from "./svg-surface";

export {
  DEFAULT_OPTIONS,
  DEFAULT_TINT,
  STACKING_Z_INDEX_BASE,
  lensStackingZIndex,
  hostStackingZIndex,
  mergeOverlayStackingZIndex,
} from "./types";
