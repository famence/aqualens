import type { CornerRadii } from "./css-parser";

export interface DisplacementMapResult {
  dataUrl: string;
  maxDisplacement: number;
}

const IOR_GLASS = 1.5;
const IOR_AIR = 1.0;

function surfaceHeight(x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  return Math.pow(1 - Math.pow(1 - clamped, 4), 0.25);
}

function surfaceDerivative(x: number): number {
  const delta = 0.001;
  return (surfaceHeight(x + delta) - surfaceHeight(x - delta)) / (2 * delta);
}

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
    if (Math.abs(disp) > maxMag) maxMag = Math.abs(disp);
  }

  const normalized = new Float32Array(samples);
  if (maxMag > 0) {
    for (let i = 0; i < samples; i++) normalized[i] = raw[i] / maxMag;
  }

  return { normalized, maxDisplacement: maxMag };
}

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

  if (qx > hw - r && qy > hh - r) {
    const cornerDx = qx - (hw - r);
    const cornerDy = qy - (hh - r);
    return r - Math.sqrt(cornerDx * cornerDx + cornerDy * cornerDy);
  }

  return Math.min(hw - qx, hh - qy);
}

function borderNormalInward(
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
  const sx = px < cx ? 1 : -1;
  const sy = py < cy ? 1 : -1;

  let r: number;
  if (px < cx) {
    r = py < cy ? radii.tl : radii.bl;
  } else {
    r = py < cy ? radii.tr : radii.br;
  }

  const hw = width / 2;
  const hh = height / 2;

  if (qx > hw - r && qy > hh - r) {
    const cornerCx = cx + (hw - r) * (px < cx ? -1 : 1);
    const cornerCy = cy + (hh - r) * (py < cy ? -1 : 1);
    const dx = cornerCx - px;
    const dy = cornerCy - py;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return [dx / len, dy / len];
  }

  if (hw - qx < hh - qy) return [sx, 0];
  return [0, sy];
}

/**
 * Generate a displacement map at full resolution.
 * Red = X displacement, Green = Y displacement, 128 = neutral.
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

      if (dist < 0 || dist >= clampedBezel) {
        data[idx] = 128;
        data[idx + 1] = 128;
        data[idx + 2] = 128;
        data[idx + 3] = 255;
        continue;
      }

      const t = dist / clampedBezel;
      const sampleIdx = Math.min(samples - 1, Math.floor(t * samples));
      const magnitude = normalized[sampleIdx];

      const [nx, ny] = borderNormalInward(x + 0.5, y + 0.5, w, h, cornerRadii);

      data[idx] = Math.max(0, Math.min(255, Math.round(128 + nx * magnitude * 127)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + ny * magnitude * 127)));
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
