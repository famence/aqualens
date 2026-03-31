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
 * Refraction (distortion) parameters for the liquid glass lens.
 * All fields are optional; unspecified values fall back to defaults.
 */
export interface RefractionOptions {
  /** Glass thickness in pixels — higher values produce stronger distortion. @default 20 */
  thickness?: number;
  /** Refraction intensity multiplier. @default 1.4 */
  factor?: number;
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

/**
 * User-facing options for creating a liquid glass effect.
 * By default, tint color is auto-computed from the element's CSS `background-color`.
 */
export interface AqualensOptions {
  /** CSS selector or URL for the snapshot background target. */
  snapshot?: string;
  /** Render resolution multiplier (0.1–3.0). @default 2.0 */
  resolution?: number;
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
   * Lenses with the same stackingIndex merge together; higher values render on top.
   * When omitted, the lens is rendered individually (no merging) in natural DOM order
   * and always below any lens that has an explicit stackingIndex.
   */
  stackingIndex?: number;
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
    factor: 1.4,
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
  tint: DEFAULT_TINT,
  on: {},
};
