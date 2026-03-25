import type { CornerRadii } from "./css-parser";

export interface DisplacementMapResult {
  dataUrl: string;
  maxDisplacement: number;
}

const IOR_GLASS = 1.5;
const IOR_AIR = 1.0;

/**
 * Convex squircle surface: y = (1 - (1-x)^4)^(1/4)
 * x ranges from 0 (outer edge) to 1 (end of bezel / flat interior).
 */
function surfaceHeight(x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  return Math.pow(1 - Math.pow(1 - clamped, 4), 0.25);
}

/**
 * Numerical derivative of the surface function at a given point.
 */
function surfaceDerivative(x: number): number {
  const delta = 0.001;
  const y1 = surfaceHeight(x - delta);
  const y2 = surfaceHeight(x + delta);
  return (y2 - y1) / (2 * delta);
}

/**
 * Given a surface derivative, compute the angle of incidence
 * and apply Snell's law to get refracted displacement.
 *
 * Rays are orthogonal to the background plane (coming straight down).
 * The surface normal is derived from the derivative rotated by -90 degrees.
 */
function computeDisplacement(
  derivative: number,
  ior: number,
  heightAtPoint: number,
): number {
  const normalX = -derivative;
  const normalY = 1;
  const normalLen = Math.sqrt(normalX * normalX + normalY * normalY);

  const sinIncident = Math.abs(normalX) / normalLen;
  if (sinIncident < 1e-6) return 0;

  const sinRefracted = (IOR_AIR / ior) * sinIncident;
  if (sinRefracted >= 1) return 0;

  const thetaIncident = Math.asin(sinIncident);
  const thetaRefracted = Math.asin(sinRefracted);

  const displacement =
    heightAtPoint * (Math.tan(thetaIncident) - Math.tan(thetaRefracted));
  return displacement * Math.sign(derivative);
}

/**
 * Pre-calculate displacement magnitudes for 128 samples across the bezel.
 * Returns normalized displacements (0..1) and the maximum displacement in pixels.
 */
function precomputeBezelDisplacements(
  bezelWidthPx: number,
  refractionFactor: number,
): { normalized: Float32Array; maxDisplacement: number } {
  const samples = 128;
  const ior = IOR_GLASS * refractionFactor;
  const raw = new Float32Array(samples);
  let maxMag = 0;

  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / samples;
    const deriv = surfaceDerivative(t);
    const height = surfaceHeight(t) * bezelWidthPx;
    const disp = computeDisplacement(deriv, ior, height);
    raw[i] = disp;
    const mag = Math.abs(disp);
    if (mag > maxMag) maxMag = mag;
  }

  const normalized = new Float32Array(samples);
  if (maxMag > 0) {
    for (let i = 0; i < samples; i++) {
      normalized[i] = raw[i] / maxMag;
    }
  }

  return { normalized, maxDisplacement: maxMag };
}

/**
 * Compute the signed distance from a point to a rounded rectangle border.
 * Returns positive values inside the shape, negative outside.
 */
function signedDistanceRoundedRect(
  px: number,
  py: number,
  width: number,
  height: number,
  radii: CornerRadii,
): number {
  const cx = width / 2;
  const cy = height / 2;
  const qx = Math.abs(px - cx);
  const qy = Math.abs(py - cy);

  let r: number;
  if (px < cx) {
    r = py < cy ? radii.tl : radii.bl;
  } else {
    r = py < cy ? radii.tr : radii.br;
  }

  const hw = width / 2;
  const hh = height / 2;

  const inCornerX = qx > hw - r;
  const inCornerY = qy > hh - r;

  if (inCornerX && inCornerY) {
    const cornerDx = qx - (hw - r);
    const cornerDy = qy - (hh - r);
    const cornerDist = Math.sqrt(cornerDx * cornerDx + cornerDy * cornerDy);
    return r - cornerDist;
  }

  const distX = hw - qx;
  const distY = hh - qy;
  return Math.min(distX, distY);
}

/**
 * Compute the outward-pointing normal direction at a point near the border
 * of a rounded rectangle. Returns [nx, ny] normalized.
 */
function borderNormal(
  px: number,
  py: number,
  width: number,
  height: number,
  radii: CornerRadii,
): [number, number] {
  const cx = width / 2;
  const cy = height / 2;
  const qx = Math.abs(px - cx);
  const qy = Math.abs(py - cy);
  const sx = px < cx ? -1 : 1;
  const sy = py < cy ? -1 : 1;

  let r: number;
  if (px < cx) {
    r = py < cy ? radii.tl : radii.bl;
  } else {
    r = py < cy ? radii.tr : radii.br;
  }

  const hw = width / 2;
  const hh = height / 2;

  const inCornerX = qx > hw - r;
  const inCornerY = qy > hh - r;

  if (inCornerX && inCornerY) {
    const cornerCx = (hw - r) * sx + cx;
    const cornerCy = (hh - r) * sy + cy;
    const dx = px - cornerCx;
    const dy = py - cornerCy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return [dx / len, dy / len];
  }

  const distX = hw - qx;
  const distY = hh - qy;

  if (distX < distY) {
    return [sx, 0];
  }
  return [0, sy];
}

/**
 * Generate an SVG displacement map image for a rounded rectangle element.
 *
 * The displacement map encodes X displacement in the Red channel and
 * Y displacement in the Green channel, with 128 as the neutral value (no displacement).
 */
export function generateDisplacementMap(
  width: number,
  height: number,
  cornerRadii: CornerRadii,
  bezelWidthPx: number,
  refractionFactor: number,
): DisplacementMapResult {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const clampedBezel = Math.max(1, bezelWidthPx);

  const { normalized, maxDisplacement } = precomputeBezelDisplacements(
    clampedBezel,
    refractionFactor,
  );

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(w, h);
  const data = imageData.data;
  const samples = normalized.length;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const dist = signedDistanceRoundedRect(x + 0.5, y + 0.5, w, h, cornerRadii);

      if (dist < 0) {
        data[idx] = 128;
        data[idx + 1] = 128;
        data[idx + 2] = 128;
        data[idx + 3] = 255;
        continue;
      }

      if (dist >= clampedBezel) {
        data[idx] = 128;
        data[idx + 1] = 128;
        data[idx + 2] = 128;
        data[idx + 3] = 255;
        continue;
      }

      const t = dist / clampedBezel;
      const sampleIdx = Math.min(samples - 1, Math.floor(t * samples));
      const magnitude = normalized[sampleIdx];

      const [nx, ny] = borderNormal(x + 0.5, y + 0.5, w, h, cornerRadii);

      const dispX = nx * magnitude;
      const dispY = ny * magnitude;

      data[idx] = Math.round(128 + dispX * 127);
      data[idx + 1] = Math.round(128 + dispY * 127);
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    maxDisplacement,
  };
}
