export { Aqualens } from "./components/Aqualens";
export type { AqualensProps } from "./components/Aqualens";

export { useAqualens, useDynamicElement } from "./hooks/use-aqualens";

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
} from "@aqualens/core";

export {
  AqualensRenderer,
  AqualensLens,
  PowerSaveRenderer,
  PowerSaveLens,
  SvgRenderer,
  SvgLens,
  getSharedRenderer,
  updateSharedRendererConfig,
  setOpaqueOverlap,
  getSharedPowerSaveRenderer,
  getSharedSvgRenderer,
  setSvgOpaqueOverlap,
  supportsSvgBackdropFilter,
  DEFAULT_OPTIONS,
} from "@aqualens/core";
