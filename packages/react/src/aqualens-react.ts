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
  getSharedRenderer,
  updateSharedRendererConfig,
  setOpaqueOverlap,
  getSharedPowerSaveRenderer,
  DEFAULT_OPTIONS,
} from "@aqualens/core";
