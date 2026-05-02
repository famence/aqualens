/** RGBA color (RGB: 0–255, alpha: 0–1). Used internally for auto-computed background tint. */
export interface TintColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Fallback when `background-color` cannot be parsed (no glass tint). */
export const DEFAULT_TINT: TintColor = { r: 255, g: 255, b: 255, a: 0 };

/**
 * Base added to every `z-index` derived from `stackingIndex` so lenses sit
 * above common layout utilities (`z-10`, sticky headers, etc.). If page
 * content stacks above the lens element, `backdrop-filter` (SVG mode) never
 * samples those pixels, so they stay sharp while the background refracts.
 */
export const STACKING_Z_INDEX_BASE = 100;

/** CSS `z-index` for the lens DOM when `stackingIndex` is set. */
export function lensStackingZIndex(stackingIndex: number): number {
  return STACKING_Z_INDEX_BASE + stackingIndex * 2 + 1;
}

/** CSS `z-index` for the WebGL canvas host (one layer below the lens DOM). */
export function hostStackingZIndex(stackingIndex: number): number {
  return STACKING_Z_INDEX_BASE + stackingIndex * 2;
}

/** CSS `z-index` for SVG merge-group overlays (same band as the canvas host). */
export function mergeOverlayStackingZIndex(stackingIndex: number): number {
  return STACKING_Z_INDEX_BASE + stackingIndex * 2;
}

/**
 * How the liquid-glass effect is rendered.
 *
 *  - `auto`  — pick the best backend at runtime: `svg` on Chromium-based
 *    browsers (cheap, GPU-composited), `webgl` everywhere else.
 *  - `webgl` — original WebGL2 backend with html2canvas snapshot.
 *  - `svg`   — SVG `<feDisplacementMap>` applied as `backdrop-filter`,
 *    based on the kube.io approach. Chromium-only; falls back to
 *    `webgl` automatically if unsupported.
 *  - `css`   — CSS-only fallback (formerly known as `powerSave`). Cheap,
 *    works everywhere, looks the least like real glass.
 *
 * @default "auto"
 */
export type RenderMode = "auto" | "webgl" | "svg" | "css";

/**
 * Glass surface profile shape for the SVG renderer's bezel refraction.
 * Apple's Liquid Glass mostly uses `convex-squircle`; the others are
 * provided for parity with the kube.io article and creative use cases.
 */
export type SurfaceShape =
  | "convex-circle"
  | "convex-squircle"
  | "concave"
  | "lip";

/**
 * Refraction (distortion) parameters for the liquid glass lens.
 * All fields are optional; unspecified values fall back to defaults.
 */
export interface RefractionOptions {
  /** Glass thickness in pixels — higher values produce stronger distortion. @default 20 */
  thickness?: number;
  /** Refraction intensity multiplier (0 = no refraction). @default 1 */
  factor?: number;
  /** Lens zoom amount (-0.9 = zoom out, 0 = neutral, 1 = zoom in). @default 0 */
  zoom?: number;
  /** Chromatic aberration (color fringing) amount. @default 7 */
  dispersion?: number;
  /** Fresnel edge-highlight range in pixels. @default 0 */
  fresnelRange?: number;
  /** Fresnel edge-highlight hardness (0–100). @default 0 */
  fresnelHardness?: number;
  /** Fresnel edge-highlight intensity (0–100). @default 0 */
  fresnelFactor?: number;
}

/**
 * Glare (specular highlight) parameters for the liquid glass lens.
 * All fields are optional; unspecified values fall back to defaults.
 */
export interface GlareOptions {
  /** Highlight spread range in pixels. @default 20 */
  range?: number;
  /** Highlight hardness (0–100). @default 20 */
  hardness?: number;
  /** Highlight intensity (0–100). @default 30 */
  factor?: number;
  /** Light convergence (0–100). @default 50 */
  convergence?: number;
  /** Opposite-side highlight intensity (0–100). @default 80 */
  oppositeFactor?: number;
  /** Light angle in degrees. @default 0 */
  angle?: number;
}

/** Explicit source element used to build the snapshot texture without html2canvas. */
export type SnapshotSourceElement =
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement;

/** Explicit source texture uploaded directly to WebGL (advanced mode). */
export type SnapshotSourceTexture = CanvasImageSource;

/** Pixel dimensions of {@link SnapshotSourceTexture} when they cannot be inferred reliably. */
export interface SnapshotSourceTextureSize {
  width: number;
  height: number;
}

/**
 * User-facing options for creating a liquid glass effect.
 * By default, tint color is auto-computed from the element's CSS `background-color`.
 */
export interface AqualensOptions {
  /** CSS selector or URL for the snapshot background target. */
  snapshot?: string;
  /** Render resolution multiplier (0.1–3.0). @default 2.0 */
  resolution?: number;
  /**
   * Optional known visual source that should be used as the snapshot texture
   * instead of html2canvas. Useful for image/video/canvas-driven scenes where
   * DOM rasterization is unnecessary.
   */
  sourceElement?: SnapshotSourceElement | null;
  /**
   * Optional texture source uploaded directly to WebGL. When provided, this
   * takes precedence over `sourceElement`.
   */
  sourceTexture?: SnapshotSourceTexture | null;
  /**
   * Optional explicit size for `sourceTexture` when width/height cannot be
   * inferred from the object itself.
   */
  sourceTextureSize?: SnapshotSourceTextureSize;
  /** Refraction (distortion) parameters. */
  refraction?: RefractionOptions;
  /** Glare (specular highlight) parameters. */
  glare?: GlareOptions;
  /** Gaussian blur radius in pixels. @default 1 */
  blurRadius?: number;
  /** Clip blur at element edges to prevent bleeding. @default true */
  blurEdge?: boolean;
  /**
   * Explicit stacking index that controls lens merge grouping and overlay priority.
   * Lenses with the same stackingIndex merge together (in `webgl` mode) or just
   * stack in z-order (in `svg` mode); higher values render on top.
   * When omitted, the lens is rendered individually (no merging) in natural DOM
   * order and always below any lens that has an explicit stackingIndex.
   *
   * Note: the `svg` backend never merges sibling lenses into a shared blob —
   * use `mode="webgl"` if you need true multi-lens merging.
   */
  stackingIndex?: number;
  /**
   * Bezel surface profile used by the SVG renderer. Ignored by other modes.
   * @default "convex-squircle"
   */
  surfaceShape?: SurfaceShape;
  /**
   * Refractive index of the glass for the SVG renderer (Snell's law).
   * Ignored by other modes. Set to 1 for no refraction; default of 1.5 is
   * the value used by Apple's Liquid Glass and the kube.io article.
   * @default 1.5
   */
  refractiveIndex?: number;
  /** Lifecycle callbacks. */
  on?: {
    /** Called once after the lens is initialized and ready to render. */
    init?(lens: AqualensLensInstance): void;
  };
}

/** Extended options that include a CSS selector for the target element. */
export interface AqualensLensOptions extends AqualensOptions {
  /** CSS selector of the target element for the lens. */
  target?: string;
}

/**
 * Internal fully-resolved configuration consumed by the renderer and lens.
 * All fields are required. `tint` is set by the lens from the element's
 * computed `background-color` at initialization (not a public option).
 */
export interface AqualensConfig {
  resolution: number;
  refraction: Required<RefractionOptions>;
  glare: Required<GlareOptions>;
  blurRadius: number;
  blurEdge: boolean;
  /**
   * When set, lenses with the same value merge together and render above implicit ones.
   * When undefined, the lens is rendered individually in natural order, below explicit lenses.
   */
  stackingIndex?: number;
  /** Bezel surface profile used by the SVG renderer. */
  surfaceShape: SurfaceShape;
  /** Refractive index for the SVG renderer (Snell's law). */
  refractiveIndex: number;
  /** Filled by the lens from computed `background-color` before the backdrop runs. */
  tint: TintColor;
  on: AqualensOptions["on"];
}

export interface AqualensLensInstance {
  element: HTMLElement;
  options: AqualensConfig;
  rectPx: DOMRectLike | null;
  radiusGl: number;
  radiusCss: number;
  radiusGlCorners: {
    tl: number;
    tr: number;
    br: number;
    bl: number;
  };
  radiusCssCorners: {
    tl: number;
    tr: number;
    br: number;
    bl: number;
  };
  getEffectiveZ(): number;
  updateMetrics(): void;
  destroy(): void;
}

export interface DOMRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AqualensRendererInstance {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  lenses: AqualensLensInstance[];
  /** When true with multiple z-groups, upper lenses clip lower ones (macOS-style). */
  opaqueOverlap: boolean;
  texture: WebGLTexture | null;
  textureWidth: number;
  textureHeight: number;
  scaleFactor: number;
  useExternalTicker: boolean;
  addLens(element: HTMLElement, options: AqualensConfig): AqualensLensInstance;
  render(): void;
  captureSnapshot(): Promise<boolean>;
  addDynamicElement(element: HTMLElement | HTMLElement[] | string): void;
  destroy(): void;
}

export const DEFAULT_OPTIONS: AqualensConfig = {
  resolution: 2.0,
  refraction: {
    thickness: 20,
    factor: 1,
    zoom: 0,
    dispersion: 7,
    fresnelRange: 0,
    fresnelHardness: 0,
    fresnelFactor: 0,
  },
  glare: {
    range: 20,
    hardness: 20,
    factor: 30,
    convergence: 50,
    oppositeFactor: 80,
    angle: 0,
  },
  blurRadius: 4,
  blurEdge: true,
  surfaceShape: "convex-squircle",
  refractiveIndex: 1.5,
  tint: DEFAULT_TINT,
  on: {},
};
