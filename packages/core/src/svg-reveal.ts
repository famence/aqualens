/**
 * Reveal-mode support for the SVG renderer.
 *
 * The WebGL backend hides reveal elements via `opacity: 0` and rasterises
 * each one via html2canvas, then composites the captured pixels on top of
 * the page snapshot before sampling. The SVG backend instead leverages the
 * native CSS `backdrop-filter`: as long as the reveal element is part of
 * the page's painting under the lens, the lens's filter pipeline picks it
 * up automatically and refracts it like any other backdrop pixel.
 *
 * Strategy:
 *
 *   1. Hide reveal elements globally with an `opacity: 0` rule scoped to
 *      `html[data-aqualens-svg-mode="true"]`. This rule replaces the WebGL
 *      renderer's equivalent style (which is only installed when the WebGL
 *      pipeline boots).
 *   2. For each visible lens whose `stackingIndex >= revealValue`, compute
 *      a rounded-rect path that traces the lens silhouette in the reveal
 *      element's local coordinate space.
 *   3. Apply the union of those paths as an inline `clip-path` on the
 *      reveal element (via `setProperty("important")` so the clip beats
 *      the global opacity rule's `!important`). At the same time we set
 *      `opacity: 1 !important` inline so the cascade rule no longer hides
 *      the element.
 *   4. The page paints the reveal element in its natural place, but only
 *      inside the lens silhouette. The lens then samples it and the
 *      browser refracts it for free.
 *
 * `on-lens` reveals work the same way except the element's `z-index` is
 * bumped above the lens. Refraction still applies because the element
 * carries the same clip-path; it just paints on top of the glass tint
 * instead of through it.
 */

import type { SvgLens } from "./svg-renderer";
import { lensStackingZIndex } from "./types";

const REVEAL_INDEX_ATTR = "data-aqualens-reveal-index";
const REVEAL_MODE_ATTR = "data-aqualens-reveal-mode";

export const SVG_REVEAL_SELECTOR = `[${REVEAL_INDEX_ATTR}]`;
export const SVG_REVEAL_OBSERVED_ATTRS: readonly string[] = [
  REVEAL_INDEX_ATTR,
  REVEAL_MODE_ATTR,
];

const SVG_MODE_FLAG_ATTR = "data-aqualens-svg-mode";
const STYLE_ID = "aqualens-svg-reveal-styles";

/**
 * Hide reveal elements while SVG mode is active. The `data-aqualens-svg-mode`
 * flag is toggled by {@link ensureSvgRevealStyles} / {@link clearSvgRevealStyles}
 * so the rule only applies when at least one `SvgRenderer` is alive.
 */
const DYNAMIC_STYLES_CSS = `
html[${SVG_MODE_FLAG_ATTR}="true"] [${REVEAL_INDEX_ATTR}] {
  opacity: 0 !important;
  pointer-events: none !important;
}
`;

type RevealMode = "under-lens" | "on-lens";

export interface SvgRevealMeta {
  element: HTMLElement;
  revealValue: number;
  mode: RevealMode;
  /** Last `clip-path` value we wrote, kept for change detection. */
  lastClipPath: string;
  /** Whether we currently override `opacity` inline. */
  opacityOverridden: boolean;
  /** Whether we currently override `z-index` inline (on-lens mode). */
  zIndexOverridden: boolean;
  /** Saved `style.zIndex` so we can restore it when the override is dropped. */
  savedZIndex: string;
  /** Saved `getPropertyPriority("z-index")` ("important" or ""). */
  savedZIndexPriority: string;
  /** Saved `style.position` so we can restore it. */
  savedPosition: string;
}

export function ensureSvgRevealStyles(): void {
  if (typeof document === "undefined") return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = DYNAMIC_STYLES_CSS;
    document.head.appendChild(style);
  }
  document.documentElement.setAttribute(SVG_MODE_FLAG_ATTR, "true");
}

export function clearSvgRevealStyles(): void {
  if (typeof document === "undefined") return;
  const style = document.getElementById(STYLE_ID);
  if (style?.parentNode) style.parentNode.removeChild(style);
  document.documentElement.removeAttribute(SVG_MODE_FLAG_ATTR);
}

function parseRevealValue(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRevealMode(raw: string | null): RevealMode {
  return raw === "on-lens" ? "on-lens" : "under-lens";
}

/**
 * Walk the document, reconcile {@link SvgRevealMeta} entries with reveal
 * elements found via {@link SVG_REVEAL_SELECTOR}, drop entries whose
 * elements have been removed, and add new ones for newly-mounted elements.
 */
export function discoverSvgReveals(reveals: SvgRevealMeta[]): void {
  if (typeof document === "undefined") return;
  const elements = document.querySelectorAll<HTMLElement>(SVG_REVEAL_SELECTOR);
  const seen = new Set<HTMLElement>();
  for (const element of elements) {
    seen.add(element);
    const value = parseRevealValue(element.getAttribute(REVEAL_INDEX_ATTR));
    if (value === null) continue;
    const mode = parseRevealMode(element.getAttribute(REVEAL_MODE_ATTR));
    const existing = reveals.find((reveal) => reveal.element === element);
    if (existing) {
      if (existing.revealValue !== value) existing.revealValue = value;
      if (existing.mode !== mode) {
        if (existing.mode === "on-lens" && mode !== "on-lens") {
          restoreRevealZIndex(existing);
        }
        existing.mode = mode;
      }
      continue;
    }
    reveals.push({
      element,
      revealValue: value,
      mode,
      lastClipPath: "",
      opacityOverridden: false,
      zIndexOverridden: false,
      savedZIndex: "",
      savedZIndexPriority: "",
      savedPosition: "",
    });
  }
  for (let i = reveals.length - 1; i >= 0; i--) {
    const reveal = reveals[i];
    if (!seen.has(reveal.element) || !reveal.element.isConnected) {
      restoreReveal(reveal);
      reveals.splice(i, 1);
    }
  }
}

/**
 * Build an SVG path-data string tracing a single rounded rectangle with
 * per-corner radii. Output uses `M ... L ... A ... Z` segments suitable
 * for direct embedding inside a CSS `clip-path: path('...')` value.
 *
 * Coordinates are written with two decimal places — enough for sub-pixel
 * precision while keeping the string short (and the `lastClipPath` cache
 * key compact).
 */
function buildRoundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
): string {
  const maxR = Math.min(w / 2, h / 2);
  const rTL = Math.max(0, Math.min(tl, maxR));
  const rTR = Math.max(0, Math.min(tr, maxR));
  const rBR = Math.max(0, Math.min(br, maxR));
  const rBL = Math.max(0, Math.min(bl, maxR));
  const f = (n: number): string => n.toFixed(2);
  return [
    `M${f(x + rTL)},${f(y)}`,
    `L${f(x + w - rTR)},${f(y)}`,
    `A${f(rTR)},${f(rTR)} 0 0 1 ${f(x + w)},${f(y + rTR)}`,
    `L${f(x + w)},${f(y + h - rBR)}`,
    `A${f(rBR)},${f(rBR)} 0 0 1 ${f(x + w - rBR)},${f(y + h)}`,
    `L${f(x + rBL)},${f(y + h)}`,
    `A${f(rBL)},${f(rBL)} 0 0 1 ${f(x)},${f(y + h - rBL)}`,
    `L${f(x)},${f(y + rTL)}`,
    `A${f(rTL)},${f(rTL)} 0 0 1 ${f(x + rTL)},${f(y)}`,
    "Z",
  ].join(" ");
}

/**
 * For each tracked reveal, compute the union of lens silhouettes that
 * should expose it (those whose `stackingIndex >= revealValue`) and write
 * the resulting path as a CSS `clip-path` on the element. When no lens
 * qualifies, restore the element to its hidden state.
 */
export function applyRevealClipPaths(
  reveals: readonly SvgRevealMeta[],
  lenses: readonly SvgLens[],
): void {
  for (const reveal of reveals) {
    const candidates: SvgLens[] = [];
    for (const lens of lenses) {
      const si = lens.options.stackingIndex ?? 0;
      if (si < reveal.revealValue) continue;
      if (!lens.rectPx || lens.rectPx.width <= 0 || lens.rectPx.height <= 0) {
        continue;
      }
      candidates.push(lens);
    }
    if (candidates.length === 0) {
      restoreReveal(reveal);
      continue;
    }
    if (typeof window === "undefined") continue;

    // `clip-path` on a non-transformed element is interpreted in the
    // element's reference box (border-box). Untransformed elements have
    // (viewport - element-bbox) as their local origin, so we just diff
    // the two `getBoundingClientRect`s. Transformed reveal elements need
    // a more involved inverse-transform pass — out of scope here.
    const elemRect = reveal.element.getBoundingClientRect();
    const parts: string[] = [];
    for (const lens of candidates) {
      const rect = lens.rectPx!;
      const x = rect.left - elemRect.left;
      const y = rect.top - elemRect.top;
      const radii = lens.radiusCssCorners;
      parts.push(
        buildRoundedRectPath(
          x,
          y,
          rect.width,
          rect.height,
          radii.tl,
          radii.tr,
          radii.br,
          radii.bl,
        ),
      );
    }
    const clipPathValue = `path('${parts.join(" ")}')`;
    if (clipPathValue !== reveal.lastClipPath) {
      reveal.lastClipPath = clipPathValue;
      reveal.element.style.setProperty(
        "clip-path",
        clipPathValue,
        "important",
      );
    }
    if (!reveal.opacityOverridden) {
      reveal.opacityOverridden = true;
      reveal.element.style.setProperty("opacity", "1", "important");
    }

    if (reveal.mode === "on-lens") {
      let maxSi = 0;
      for (const lens of candidates) {
        const si = lens.options.stackingIndex ?? 0;
        if (si > maxSi) maxSi = si;
      }
      // One layer above the highest revealing lens. The lens's element
      // sits at `lensStackingZIndex(si)`, so `+1` puts the reveal text
      // immediately on top. The clip-path still hides everything outside
      // the lens silhouette so the user only sees the text inside the
      // glass tint area.
      const targetZ = String(lensStackingZIndex(maxSi) + 1);
      if (!reveal.zIndexOverridden) {
        reveal.savedZIndex = reveal.element.style.zIndex;
        reveal.savedZIndexPriority =
          reveal.element.style.getPropertyPriority("z-index");
        reveal.savedPosition = reveal.element.style.position;
        reveal.zIndexOverridden = true;
      }
      reveal.element.style.setProperty("z-index", targetZ, "important");
      const computedPos = window.getComputedStyle(reveal.element).position;
      if (computedPos === "static") {
        reveal.element.style.setProperty("position", "relative", "important");
      }
    } else if (reveal.zIndexOverridden) {
      restoreRevealZIndex(reveal);
    }
  }
}

function restoreRevealZIndex(reveal: SvgRevealMeta): void {
  if (!reveal.zIndexOverridden) return;
  reveal.element.style.removeProperty("z-index");
  if (reveal.savedZIndex) {
    if (reveal.savedZIndexPriority === "important") {
      reveal.element.style.setProperty(
        "z-index",
        reveal.savedZIndex,
        "important",
      );
    } else {
      reveal.element.style.zIndex = reveal.savedZIndex;
    }
  }
  reveal.element.style.removeProperty("position");
  if (reveal.savedPosition) reveal.element.style.position = reveal.savedPosition;
  reveal.zIndexOverridden = false;
  reveal.savedZIndex = "";
  reveal.savedZIndexPriority = "";
  reveal.savedPosition = "";
}

export function restoreReveal(reveal: SvgRevealMeta): void {
  if (reveal.lastClipPath !== "") {
    reveal.element.style.removeProperty("clip-path");
    reveal.lastClipPath = "";
  }
  if (reveal.opacityOverridden) {
    reveal.element.style.removeProperty("opacity");
    reveal.opacityOverridden = false;
  }
  restoreRevealZIndex(reveal);
}

export function restoreAllReveals(reveals: SvgRevealMeta[]): void {
  for (const reveal of reveals) restoreReveal(reveal);
  reveals.length = 0;
}
