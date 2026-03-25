export { Aqualens } from "./components/Aqualens";
export type {
  AqualensProps,
  AqualensRef,
} from "./components/Aqualens";

export { useAqualens, useDynamicElement } from "./hooks/use-aqualens";

export type {
  AqualensOptions,
  AqualensLensOptions,
  AqualensLensInstance,
  AqualensRendererInstance,
  AqualensConfig,
  AqualensRenderMode,
  RefractionOptions,
  GlareOptions,
  DOMRectLike,
  TintColor,
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
  detectSvgFilterSupport,
  detectLowPower,
  resolveRenderMode,
  DEFAULT_OPTIONS,
} from "@aqualens/core";
