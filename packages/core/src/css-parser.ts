export interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

export function parseCornerRadius(
  value: string,
  rect: DOMRect,
  emBase: number,
): number {
  const normalized = (value || "0").split("/")[0].trim();
  if (!normalized) return 0;

  if (normalized.toLowerCase().startsWith("calc(")) {
    const pixels = parseCalcToPx(normalized, rect, emBase);
    return Number.isFinite(pixels) ? Math.max(0, pixels) : 0;
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  const horizontal = parts[0] ?? "0";
  const vertical = parts[1] ?? horizontal;

  const horizontalPixels = parseLengthToPx(horizontal, rect.width, emBase);
  const verticalPixels = parseLengthToPx(vertical, rect.height, emBase);

  if (!Number.isFinite(horizontalPixels) || !Number.isFinite(verticalPixels))
    return 0;
  return Math.max(0, Math.min(horizontalPixels, verticalPixels));
}

/**
 * Parse full calc(...) expression (e.g. "calc(3.35959% + 931.875px)" from
 * getComputedStyle when animating between px and %). Percent terms use
 * max(width, height) as reference so the radius matches the visual.
 */
function parseCalcToPx(
  value: string,
  rect: DOMRect,
  emBase: number,
): number {
  const raw = value.trim();
  if (!raw.toLowerCase().startsWith("calc(")) return NaN;
  let depth = 0;
  let start = -1;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === "(") {
      if (depth === 0) start = index + 1;
      depth++;
    } else if (raw[index] === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        const expression = raw.slice(start, index).trim();
        const refPct = Math.max(rect.width, rect.height);
        const terms = expression.match(
          /[+-]?\s*[\d.]+\s*(?:px|%|vw|vh|vmin|vmax|rem|em)?/gi,
        );
        if (!terms || terms.length === 0) return NaN;
        let sum = 0;
        for (const term of terms) {
          const trimmedTerm = term.trim().replace(/\s+/g, "");
          const sign = trimmedTerm.startsWith("-")
            ? -1
            : trimmedTerm.startsWith("+")
              ? 1
              : 1;
          const numPart = trimmedTerm.replace(/^[+-]/, "");
          const match = numPart.match(
            /^([\d.]+)(px|%|vw|vh|vmin|vmax|rem|em)?$/i,
          );
          if (!match) continue;
          const numericValue = parseFloat(match[1]);
          if (!Number.isFinite(numericValue)) continue;
          const unit = (match[2] || "px").toLowerCase();
          let value = 0;
          switch (unit) {
            case "px":
              value = numericValue;
              break;
            case "%":
              value = (refPct * numericValue) / 100;
              break;
            case "vw":
              value = (window.innerWidth * numericValue) / 100;
              break;
            case "vh":
              value = (window.innerHeight * numericValue) / 100;
              break;
            case "vmin":
              value =
                (Math.min(window.innerWidth, window.innerHeight) *
                  numericValue) /
                100;
              break;
            case "vmax":
              value =
                (Math.max(window.innerWidth, window.innerHeight) *
                  numericValue) /
                100;
              break;
            case "rem":
              value =
                numericValue *
                (parseFloat(
                  window.getComputedStyle(document.documentElement).fontSize,
                ) || 16);
              break;
            case "em":
              value = numericValue * emBase;
              break;
            default:
              value = numericValue;
          }
          sum += sign * value;
        }
        return sum;
      }
    }
  }
  return NaN;
}

function parseLengthToPx(
  value: string,
  percentBase: number,
  emBase: number,
): number {
  const input = (value || "0").trim().toLowerCase();
  if (!input) return 0;

  const resolveTerm = (term: string): number => {
    const token = term.trim().toLowerCase();
    if (!token) return 0;

    const match = token.match(
      /^([+-]?\d*\.?\d+)(px|%|vw|vh|vmin|vmax|rem|em)?$/i,
    );
    if (!match) return parseFloat(token) || 0;

    const numeric = parseFloat(match[1]);
    if (!Number.isFinite(numeric)) return 0;
    const unit = (match[2] || "px").toLowerCase();

    switch (unit) {
      case "px":
        return numeric;
      case "%":
        return (percentBase * numeric) / 100;
      case "vw":
        return (window.innerWidth * numeric) / 100;
      case "vh":
        return (window.innerHeight * numeric) / 100;
      case "vmin":
        return (
          (Math.min(window.innerWidth, window.innerHeight) * numeric) / 100
        );
      case "vmax":
        return (
          (Math.max(window.innerWidth, window.innerHeight) * numeric) / 100
        );
      case "rem": {
        const rootSize =
          parseFloat(
            window.getComputedStyle(document.documentElement).fontSize,
          ) || 16;
        return rootSize * numeric;
      }
      case "em":
        return emBase * numeric;
      default:
        return numeric;
    }
  };

  if (!input.startsWith("calc(")) return resolveTerm(input);

  const expression = input.slice(5, -1);
  const terms = expression.match(
    /[+-]?\s*\d*\.?\d+(?:px|%|vw|vh|vmin|vmax|rem|em)?/gi,
  );
  if (!terms) return 0;

  return terms.reduce((sum, term) => sum + resolveTerm(term), 0);
}

export function normalizeCornerRadii(
  radii: CornerRadii,
  width: number,
  height: number,
): CornerRadii {
  const safe: CornerRadii = {
    tl: Number.isFinite(radii.tl) ? Math.max(0, radii.tl) : 0,
    tr: Number.isFinite(radii.tr) ? Math.max(0, radii.tr) : 0,
    br: Number.isFinite(radii.br) ? Math.max(0, radii.br) : 0,
    bl: Number.isFinite(radii.bl) ? Math.max(0, radii.bl) : 0,
  };

  const top = safe.tl + safe.tr;
  const bottom = safe.bl + safe.br;
  const left = safe.tl + safe.bl;
  const right = safe.tr + safe.br;

  const scale = Math.min(
    1,
    top > 0 ? width / top : 1,
    bottom > 0 ? width / bottom : 1,
    left > 0 ? height / left : 1,
    right > 0 ? height / right : 1,
  );

  return {
    tl: safe.tl * scale,
    tr: safe.tr * scale,
    br: safe.br * scale,
    bl: safe.bl * scale,
  };
}
