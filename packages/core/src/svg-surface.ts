/**
 * Glass bezel surface profile functions used by the SVG renderer.
 *
 * Each function maps a normalised distance from the bezel outer edge
 * (`x = 0` — outer rim of the lens) to the bezel inner edge (`x = 1` —
 * start of the flat top). The returned value is the bezel surface
 * height at that point, also normalised to `[0, 1]`. The value `1`
 * means "physical glass thickness" — i.e. height = 1 corresponds to
 * the user-controlled `glassThickness` parameter when the displacement
 * profile is sampled.
 *
 * Math is taken verbatim from the reference implementation by kube.io
 * (https://kube.io/blog/liquid-glass-css-svg/) so the resulting glass
 * profile matches the article's interactive demos and the WWDC 2025
 * Liquid Glass presets.
 */
export type SurfaceFn = (x: number) => number;

export interface SurfaceFnDef {
  title: string;
  fn: SurfaceFn;
}

export const CONVEX_CIRCLE: SurfaceFnDef = {
  title: "Convex Circle",
  fn: (x) => Math.sqrt(1 - (1 - x) ** 2),
};

export const CONVEX_SQUIRCLE: SurfaceFnDef = {
  title: "Convex Squircle",
  fn: (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4),
};

export const CONCAVE: SurfaceFnDef = {
  title: "Concave",
  fn: (x) => 1 - CONVEX_CIRCLE.fn(x),
};

export const LIP: SurfaceFnDef = {
  title: "Lip",
  fn: (x) => {
    const convex = CONVEX_SQUIRCLE.fn(Math.min(x * 2, 1));
    const concave = CONCAVE.fn(x) + 0.1;
    const smootherstep = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
    return convex * (1 - smootherstep) + concave * smootherstep;
  },
};

/**
 * Public name of a surface profile, used by `surfaceShape` config option.
 * Apple's Liquid Glass mostly uses convex squircle, so that's our default.
 */
export type SurfaceShape = "convex-circle" | "convex-squircle" | "concave" | "lip";

export function resolveSurfaceFn(shape: SurfaceShape | undefined): SurfaceFnDef {
  switch (shape) {
    case "convex-circle":
      return CONVEX_CIRCLE;
    case "concave":
      return CONCAVE;
    case "lip":
      return LIP;
    case "convex-squircle":
    default:
      return CONVEX_SQUIRCLE;
  }
}
