export function debounce<T extends (...args: unknown[]) => void>(
  callback: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => callback(...args), wait);
  };
}

export function effectiveZ(element: HTMLElement): number {
  let node: HTMLElement | null = element;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    if (style.position !== "static" && style.zIndex !== "auto") {
      const zIndex = parseInt(style.zIndex, 10);
      if (!isNaN(zIndex)) return zIndex;
    }
    node = node.parentElement;
  }
  return 0;
}

/**
 * Parse getComputedStyle(...).backgroundColor to { r, g, b, a }.
 * Supports rgb/rgba with commas, CSS Color 4 slash alpha, and falls back
 * to canvas parsing for formats like oklch(...) and color(...).
 */
export function parseBgColorToRgba(
  cssValue: string,
): { r: number; g: number; b: number; a: number } | null {
  const value = cssValue.trim();
  if (!value) return null;

  const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
  const toChannel255 = (raw: string): number => {
    const trimmed = raw.trim();
    if (!trimmed) return 0;
    if (trimmed.endsWith("%")) {
      const percent = parseFloat(trimmed.slice(0, -1));
      if (!Number.isFinite(percent)) return 0;
      return Math.round(Math.max(0, Math.min(255, (percent / 100) * 255)));
    }
    const numericValue = parseFloat(trimmed);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.round(Math.max(0, Math.min(255, numericValue)));
  };
  const toAlpha01 = (raw?: string): number => {
    if (!raw) return 1;
    const trimmed = raw.trim();
    if (!trimmed) return 1;
    if (trimmed.endsWith("%")) {
      const percent = parseFloat(trimmed.slice(0, -1));
      return Number.isFinite(percent) ? clamp01(percent / 100) : 1;
    }
    const numericValue = parseFloat(trimmed);
    return Number.isFinite(numericValue) ? clamp01(numericValue) : 1;
  };

  const rgbMatch = value.match(/^rgba?\s*\(\s*([^)]+)\s*\)$/i);
  if (rgbMatch) {
    const inner = rgbMatch[1].trim();
    if (inner.includes("/")) {
      const [rgbPartRaw, alphaPartRaw] = inner
        .split(/\s*\/\s*/, 2)
        .map((part) => part.trim());
      const rgbParts = rgbPartRaw
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (rgbParts.length >= 3) {
        return {
          r: toChannel255(rgbParts[0]!),
          g: toChannel255(rgbParts[1]!),
          b: toChannel255(rgbParts[2]!),
          a: toAlpha01(alphaPartRaw),
        };
      }
    } else {
      const commaParts = inner
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const parts =
        commaParts.length >= 3
          ? commaParts
          : inner
              .split(/\s+/)
              .map((part) => part.trim())
              .filter(Boolean);
      if (parts.length >= 3) {
        return {
          r: toChannel255(parts[0]!),
          g: toChannel255(parts[1]!),
          b: toChannel255(parts[2]!),
          a: toAlpha01(parts[3]),
        };
      }
    }
  }

  // Fallback for modern color spaces (oklch/color/lab/...) via browser parser.
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) return null;
  canvasContext.clearRect(0, 0, 1, 1);
  const sentinel = "rgba(1, 2, 3, 0.004)";
  canvasContext.fillStyle = sentinel;
  canvasContext.fillStyle = value;
  if (
    canvasContext.fillStyle === sentinel &&
    value.toLowerCase() !== sentinel
  ) {
    return null;
  }
  canvasContext.fillRect(0, 0, 1, 1);
  const pixelData = canvasContext.getImageData(0, 0, 1, 1).data;
  return {
    r: pixelData[0],
    g: pixelData[1],
    b: pixelData[2],
    a: pixelData[3] / 255,
  };
}

export interface ShadowParams {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: { r: number; g: number; b: number; a: number };
}

export function parseBoxShadow(value: string): ShadowParams | null {
  if (!value || value === "none") return null;

  const parts = value.split(/,(?![^(]*\))/);

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part || part === "none") continue;
    if (/\binset\b/i.test(part)) continue;

    const colorFnRe =
      /\b(?:rgba?|hsla?|oklab|oklch|lab|lch|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/i;
    const colorMatch = part.match(colorFnRe) || part.match(/#[0-9a-f]+/i);
    const colorStr = colorMatch ? colorMatch[0] : "";
    const withoutColor = part.replace(colorStr, "").trim();
    const nums = withoutColor.match(/(-?[\d.]+)px/g);
    if (!nums || nums.length < 2) continue;

    const values = nums.map((num) => parseFloat(num));
    const offsetX = values[0];
    const offsetY = values[1];
    const blur = values[2] || 0;
    const spread = values[3] || 0;

    let r = 0,
      g = 0,
      b = 0,
      a = 0;

    if (colorStr) {
      const slashAlpha = colorStr.match(/\/\s*([\d.]+)(%?)\s*\)/);
      if (slashAlpha) {
        a = parseFloat(slashAlpha[1]);
        if (slashAlpha[2] === "%") a /= 100;
      }

      const rgbMatch = colorStr.match(
        /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/,
      );
      if (rgbMatch) {
        r = parseFloat(rgbMatch[1]);
        g = parseFloat(rgbMatch[2]);
        b = parseFloat(rgbMatch[3]);
        if (!slashAlpha) {
          const fourthMatch = colorStr.match(
            /rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,]+([\d.]+%?)\s*\)/,
          );
          if (fourthMatch) {
            a = parseFloat(fourthMatch[1]);
            if (fourthMatch[1].endsWith("%")) a /= 100;
          } else {
            a = 1;
          }
        }
      }
    }

    if (a <= 0) continue;
    if (blur <= 0 && offsetX === 0 && offsetY === 0 && spread <= 0) continue;

    return { offsetX, offsetY, blur, spread, color: { r, g, b, a } };
  }

  return null;
}

export function parseTransform(
  transform: string,
): [number, number, number, number, number, number] {
  if (transform === "none") return [1, 0, 0, 1, 0, 0];
  const matrixMatch = transform.match(/matrix\((.+)\)/);
  if (matrixMatch) {
    return matrixMatch[1].split(",").map(parseFloat) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
  }
  const matrix3dMatch = transform.match(/matrix3d\((.+)\)/);
  if (matrix3dMatch) {
    const matrixValues = matrix3dMatch[1].split(",").map(parseFloat);
    return [
      matrixValues[0],
      matrixValues[1],
      matrixValues[4],
      matrixValues[5],
      matrixValues[12],
      matrixValues[13],
    ];
  }
  return [1, 0, 0, 1, 0, 0];
}
