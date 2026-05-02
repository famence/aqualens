import type { CornerRadii } from "./css-parser";
import type { SurfaceFn } from "./svg-surface";

/**
 * Refraction physics + displacement-map rasterisation for the SVG
 * renderer.
 *
 * High-level pipeline (mirrors the kube.io article):
 *   1. {@link calculateDisplacementProfile} samples the refraction at a
 *      number of points along a single bezel cross-section. The result
 *      is an array of lateral pixel displacements indexed by the
 *      *normalised* distance from the bezel outer edge to its inner
 *      edge.
 *   2. {@link buildCombinedLensImageData} rasterises the profile +
 *      specular highlight into a single `ImageData` whose R/G channels
 *      encode the X/Y displacement and B channel encodes specular
 *      alpha. Consumed by `<feDisplacementMap>` (R/G) and
 *      `<feColorMatrix>` (B) inside the SVG filter pipeline.
 *
 * Each lens is a single rounded rectangle described via
 * {@link RoundedRectShape}. Multi-shape "merge" silhouettes are
 * intentionally not supported by this backend — use the WebGL renderer
 * when you need to merge multiple lenses into one blob.
 */

export interface RoundedRectShape {
  /** Rect bbox in SVG pixel coordinates (origin = top-left of map image). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Per-corner radii. Match the lens's CSS `border-radius` corners. */
  radii: CornerRadii;
}

/**
 * Sample the lateral displacement caused by refraction along a bezel
 * cross-section. The output array is indexed by `i / samples`, where
 * `i ∈ [0, samples)` corresponds to the *normalised* distance from the
 * outer edge of the bezel.
 *
 * Math is the simplified Snell's law refraction described in the
 * kube.io article — we assume the incident ray is fully vertical (no
 * perspective) and only the first refraction event is modelled.
 */
export function calculateDisplacementProfile(
  glassThickness: number,
  bezelWidth: number,
  surfaceFn: SurfaceFn,
  refractiveIndex: number,
  samples = 128,
): number[] {
  const eta = 1 / refractiveIndex;

  const refract = (
    normalX: number,
    normalY: number,
  ): [number, number] | null => {
    const dot = normalY;
    const k = 1 - eta * eta * (1 - dot * dot);
    if (k < 0) return null;
    const kSqrt = Math.sqrt(k);
    return [
      -(eta * dot + kSqrt) * normalX,
      eta - (eta * dot + kSqrt) * normalY,
    ];
  };

  const out = new Array<number>(samples);
  for (let i = 0; i < samples; i++) {
    const x = i / samples;
    const y = surfaceFn(x);

    const dx = x < 1 ? 0.0001 : -0.0001;
    const y2 = surfaceFn(x + dx);
    const derivative = (y2 - y) / dx;
    const magnitude = Math.sqrt(derivative * derivative + 1);
    const normalX = -derivative / magnitude;
    const normalY = -1 / magnitude;
    const refracted = refract(normalX, normalY);

    if (!refracted) {
      out[i] = 0;
    } else {
      const remainingHeight = y * bezelWidth + glassThickness;
      out[i] = refracted[0] * (remainingHeight / refracted[1]);
    }
  }
  return out;
}

export function maxAbsoluteDisplacement(profile: number[]): number {
  let maximum = 0;
  for (const value of profile) {
    const absolute = Math.abs(value);
    if (absolute > maximum) maximum = absolute;
  }
  return maximum;
}

export interface DisplacementMapInputs {
  /** Output ImageData width in CSS pixels (will be multiplied by dpr). */
  cssWidth: number;
  cssHeight: number;
  /** Device pixel ratio of the produced ImageData. */
  dpr: number;
  /** Lens shapes — currently always a single-element array. */
  shapes: RoundedRectShape[];
  /** Bezel width in CSS pixels — distance from edge inward where refraction occurs. */
  bezelWidth: number;
  /** Pre-computed displacement profile from {@link calculateDisplacementProfile}. */
  profile: number[];
  /** Pre-computed maximum absolute displacement of `profile` (px). */
  maxDisplacement: number;
}

function clamp255(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value | 0;
}

/**
 * Combined refraction + specular rasteriser.
 *
 * Packs three pieces of information into one ImageData:
 *   - X displacement → red channel
 *   - Y displacement → green channel
 *   - specular alpha → blue channel
 *   - opaque         → alpha channel
 *
 * The SVG filter pipeline then plugs this image into
 * `<feDisplacementMap>` (R/G channels) and into a `<feColorMatrix>`
 * extracting the B channel as the specular layer's alpha — one
 * `<feImage>` powering both the refraction and the rim highlight.
 *
 * Implementation: closed-form rounded-rect math (single shape only).
 * Mirrors the kube.io reference rasteriser.
 */
export interface CombinedLensInputs extends DisplacementMapInputs {
  /** Light direction angle in radians (0 = rightward, π/2 = downward). */
  specularAngleRad: number;
  /** Primary highlight intensity 0–1. */
  primaryIntensity: number;
  /** Opposite-side highlight intensity 0–1, multiplies primary. */
  oppositeFactor: number;
}

export function buildCombinedLensImageData(
  inputs: CombinedLensInputs,
): ImageData {
  const {
    cssWidth,
    cssHeight,
    dpr,
    shapes,
    bezelWidth,
    profile,
    maxDisplacement,
    specularAngleRad,
    primaryIntensity,
    oppositeFactor,
  } = inputs;
  const bufferWidth = Math.max(1, Math.ceil(cssWidth * dpr));
  const bufferHeight = Math.max(1, Math.ceil(cssHeight * dpr));
  const imageData = new ImageData(bufferWidth, bufferHeight);

  // Neutral fill: R=128, G=128, B=0, A=255.
  new Uint32Array(imageData.data.buffer).fill(0xff008080);

  const bezel = bezelWidth * dpr;
  const sampleCount = profile.length;
  const lightX = Math.cos(specularAngleRad);
  // SVG Y axis points down — match kube.io's reference frame.
  const lightY = -Math.sin(specularAngleRad);
  // Specular rim is only ~2 CSS-px wide centred 1 CSS-px inside the
  // silhouette, so we can early-out on pixels deeper than `2 * dpr`
  // for the specular write.
  const specularInnerLimit = 2 * dpr;

  if (shapes.length !== 1) return imageData;
  rasteriseSingleShape(
    imageData.data,
    bufferWidth,
    bufferHeight,
    shapes[0],
    dpr,
    bezel,
    profile,
    sampleCount,
    maxDisplacement,
    lightX,
    lightY,
    primaryIntensity,
    oppositeFactor,
    specularInnerLimit,
  );
  return imageData;
}

/**
 * Single-rounded-rectangle fast path.
 *
 * For each pixel inside the bezel band of one rounded rectangle we
 * compute everything in **closed form**, with no SDF probes:
 *
 *   - Determine which corner the pixel belongs to (4 quadrants by
 *     lens centre). Pick the relevant per-corner radius.
 *   - Compute the offset `(x, y)` from the corner's *arc centre*. In
 *     the straight-edge regions one of `x` or `y` is forced to 0.
 *   - `distFromCenter = sqrt(x² + y²)` is the radial distance from
 *     the arc centre. The pixel is in the bezel band iff
 *     `distFromCenter ∈ [r - bezel, r + 1]`.
 *   - The outward surface normal is just `(x / distFromCenter,
 *     y / distFromCenter)` — radial in the corner arcs, axis-aligned
 *     on the straight edges.
 *
 * This trades 5× SDF evaluations + a finite-difference gradient (the
 * old per-pixel cost) for ~25 ops per pixel. In the dominant
 * single-lens scenario it cuts the rasteriser's CPU cost by roughly
 * **3-5×** depending on bezel size and lens dimensions.
 *
 * Per-corner radii are honoured by selecting `r` from the relevant
 * corner; the math degrades gracefully for `r → 0` because the AA
 * band (`+1` slack) keeps the bezel band non-empty.
 */
function rasteriseSingleShape(
  data: Uint8ClampedArray,
  bufferWidth: number,
  bufferHeight: number,
  shape: RoundedRectShape,
  dpr: number,
  bezel: number,
  profile: number[],
  sampleCount: number,
  maxDisplacement: number,
  lightX: number,
  lightY: number,
  primaryIntensity: number,
  oppositeFactor: number,
  specularInnerLimit: number,
): void {
  // Geometry in raster pixel units.
  const sx = shape.x * dpr;
  const sy = shape.y * dpr;
  const sw = shape.width * dpr;
  const sh = shape.height * dpr;
  const tl = shape.radii.tl * dpr;
  const tr = shape.radii.tr * dpr;
  const br = shape.radii.br * dpr;
  const bl = shape.radii.bl * dpr;

  // Quadrant boundaries: a pixel is in the "left half" if its x is
  // less than the lens centre x, etc. The corner radii then determine
  // which arc centre the pixel pivots around.
  const cx = sx + sw / 2;
  const cy = sy + sh / 2;

  // Bezel iteration bounds for this shape.
  const slack = bezel + 2;
  const minX = Math.max(0, Math.floor(sx - slack));
  const minY = Math.max(0, Math.floor(sy - slack));
  const maxX = Math.min(bufferWidth, Math.ceil(sx + sw + slack));
  const maxY = Math.min(bufferHeight, Math.ceil(sy + sh + slack));
  if (maxX <= minX || maxY <= minY) return;

  const invMaxDisp = maxDisplacement > 0 ? 1 / maxDisplacement : 0;

  for (let py = minY; py < maxY; py++) {
    const isTop = py < cy;
    const rowOffsetBase = py * bufferWidth;

    for (let px = minX; px < maxX; px++) {
      const isLeft = px < cx;

      // Pick the relevant corner radius and arc centre. Arc centre
      // sits inset by `r` from the bbox corner along both axes.
      let r: number;
      let ccx: number;
      let ccy: number;
      if (isLeft) {
        if (isTop) {
          r = tl;
          ccx = sx + r;
          ccy = sy + r;
        } else {
          r = bl;
          ccx = sx + r;
          ccy = sy + sh - r;
        }
      } else {
        if (isTop) {
          r = tr;
          ccx = sx + sw - r;
          ccy = sy + r;
        } else {
          r = br;
          ccx = sx + sw - r;
          ccy = sy + sh - r;
        }
      }

      // Offset from the arc centre, clamped to the "outward" axis
      // direction. Pixels on the straight portion of an edge get one
      // coordinate clamped to 0, which makes the radial direction
      // collapse to an axis-aligned outward normal — exactly what we
      // want for straight-edge bezels.
      const dxRaw = px - ccx;
      const dyRaw = py - ccy;
      const x = isLeft ? Math.min(0, dxRaw) : Math.max(0, dxRaw);
      const y = isTop ? Math.min(0, dyRaw) : Math.max(0, dyRaw);

      const distSq = x * x + y * y;
      const rPlus1 = r + 1;
      // Bezel band check: distFromCenter ∈ [r - bezel, r + 1]. We
      // square both bounds to keep the hot loop branchy-but-fast.
      if (distSq > rPlus1 * rPlus1) continue;
      const rMinusBezel = r - bezel;
      if (rMinusBezel > 0 && distSq < rMinusBezel * rMinusBezel) continue;

      const dist = Math.sqrt(distSq);
      const distanceFromSide = r - dist;
      // SDF: positive outside, negative inside. distanceFromSide is
      // its negation so we don't need to negate again per branch.
      const signedDist = -distanceFromSide;
      // 1-px AA band on the outside of the silhouette.
      const opacity = signedDist > 0 ? Math.max(0, 1 - signedDist) : 1;

      // Outward surface normal. In the corner arc this is radial; on
      // straight edges one component is 0.
      let gradX: number;
      let gradY: number;
      if (dist > 1e-6) {
        const inv = 1 / dist;
        gradX = x * inv;
        gradY = y * inv;
      } else {
        // At the arc centre exactly — no meaningful direction.
        continue;
      }

      const offset = (rowOffsetBase + px) * 4;

      // ---- displacement (R, G) ----
      const normalisedDistance =
        distanceFromSide >= 0 && bezel > 0
          ? distanceFromSide >= bezel
            ? 1
            : distanceFromSide / bezel
          : 0;
      const sampleIndex = Math.min(
        sampleCount - 1,
        (normalisedDistance * sampleCount) | 0,
      );
      const displacement = profile[sampleIndex] ?? 0;
      const norm = displacement * invMaxDisp;
      const dX = -gradX * norm * opacity;
      const dY = -gradY * norm * opacity;
      data[offset] = clamp255(128 + dX * 127);
      data[offset + 1] = clamp255(128 + dY * 127);

      // ---- specular alpha (B) ----
      if (signedDist >= -specularInnerLimit && primaryIntensity > 0) {
        const t = distanceFromSide / dpr;
        const oneMinusT = 1 - t;
        const rimWeight = Math.sqrt(Math.max(0, 1 - oneMinusT * oneMinusT));
        if (rimWeight > 0) {
          const dot = gradX * lightX + gradY * lightY;
          const dotAbs = dot >= 0 ? dot : -dot;
          // Primary side gets full intensity; opposite side scaled
          // by `oppositeFactor`. Both contribute via the dot magnitude.
          const sideIntensity =
            dot > 0
              ? dotAbs * primaryIntensity
              : dot < 0
                ? dotAbs * primaryIntensity * oppositeFactor
                : 0;
          if (sideIntensity > 0) {
            const specularAlpha = sideIntensity * rimWeight * opacity;
            if (specularAlpha > 0) {
              data[offset + 2] = clamp255(255 * specularAlpha);
            }
          }
        }
      }
    }
  }
}

/** Reused 2D canvas for PNG encoding — avoids per–cache-miss `createElement`. */
let encodeCanvas: HTMLCanvasElement | null = null;
let encodeContext: CanvasRenderingContext2D | null = null;

/**
 * Encode an ImageData as a PNG data URL. Falls back to JPEG if the
 * browser refuses PNG for any reason. Used to plug the displacement
 * map into `<feImage href="...">`.
 */
export function imageDataToDataUrl(imageData: ImageData): string {
  const w = imageData.width;
  const h = imageData.height;
  if (!encodeCanvas || encodeCanvas.width !== w || encodeCanvas.height !== h) {
    encodeCanvas = document.createElement("canvas");
    encodeCanvas.width = w;
    encodeCanvas.height = h;
    encodeContext = encodeCanvas.getContext("2d");
  }
  const context = encodeContext;
  if (!context) throw new Error("Aqualens SVG: 2D canvas context unavailable");
  context.putImageData(imageData, 0, 0);
  return encodeCanvas.toDataURL();
}
