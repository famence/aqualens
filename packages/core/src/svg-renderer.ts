import {
  parseBgColorToRgba,
  parseBoxShadow,
  type ShadowParams,
} from "./utils";
import {
  parseCornerRadius,
  normalizeCornerRadii,
  type CornerRadii,
} from "./css-parser";
import {
  DEFAULT_TINT,
  lensStackingZIndex,
  type AqualensConfig,
  type AqualensLensInstance,
  type DOMRectLike,
} from "./types";
import { resolveSurfaceFn } from "./svg-surface";
import {
  buildCombinedLensImageData,
  calculateDisplacementProfile,
  imageDataToDataUrl,
  maxAbsoluteDisplacement,
  type RoundedRectShape,
} from "./svg-displacement-map";
import {
  ensureSvgRevealStyles,
  clearSvgRevealStyles,
  discoverSvgReveals,
  applyRevealClipPaths,
  restoreAllReveals,
  SVG_REVEAL_SELECTOR,
  SVG_REVEAL_OBSERVED_ATTRS,
  type SvgRevealMeta,
} from "./svg-reveal";

/**
 * Strips inline declarations that only move/stack the lens without
 * changing border-radius, size, colours, or blur — the dominant case
 * when React updates `left`/`top` every `mousemove` on the demo page.
 * Anything not matched here still forces a full style re-read.
 */
const POSITION_ONLY_STYLE_PROPS =
  /(?:^|;)\s*(?:left|top|right|bottom|inset|transform|translate|translateX|translateY|translateZ|z-index|will-change|-webkit-backdrop-filter|backdrop-filter)\s*:[^;]*/gi;

function styleSignatureForLensGeometry(style: string): string {
  return style
    .replace(POSITION_ONLY_STYLE_PROPS, ";")
    .replace(/;+/g, ";")
    .replace(/^;|;$/g, "")
    .trim()
    .toLowerCase();
}

function styleChangeAffectsLensGeometry(
  oldStyle: string,
  newStyle: string,
): boolean {
  return styleSignatureForLensGeometry(oldStyle) !== styleSignatureForLensGeometry(newStyle);
}

/** Marker attribute identical to the WebGL renderer's. */
export const SVG_LENS_DOM_ATTR = "data-aqualens-lens";

/** Single hidden SVG container that hosts every lens's `<filter>` definition. */
const SVG_HOST_ATTR = "data-aqualens-svg-host";

/**
 * Rendering pipeline for the SVG (`backdrop-filter: url(#…)`) backend.
 *
 * Each lens gets its own DOM scaffolding:
 *   - the user-visible lens element (`lens.element`) — receives
 *     `backdrop-filter: url(#filterId)`;
 *   - a tint overlay div — applies the auto-extracted background colour;
 *   - a specular overlay `<img>` — composited via `mix-blend-mode: screen`
 *     (specular layer) so it adds bright rim light on top of refracted
 *     content.
 *
 * The SVG backend renders each lens in isolation: lenses sharing a
 * `stackingIndex` do *not* merge into a single blob. Use `mode="webgl"`
 * when you need multi-lens merging.
 *
 * Opaque overlap (`renderer.opaqueOverlap = true`) is emulated by
 * drawing a `clip-path` on lower groups that subtracts the silhouette
 * of every higher group sitting on top of them. Because the cut-out
 * area no longer paints, the higher group's `backdrop-filter` ends up
 * sampling the original page (snapshot) under it — matching the
 * macOS-style cascade behaviour of the WebGL renderer.
 */
export class SvgRenderer {
  lenses: SvgLens[] = [];
  /** macOS-style cascade overlay toggle. */
  opaqueOverlap = false;
  /** Hidden `<svg>` element that owns all `<filter>` and `<clipPath>` defs. */
  private _host: SVGSVGElement;
  private _hostDefs: SVGDefsElement;
  private _destroyed = false;
  private _renderScheduled = false;
  private _filterIdCounter = 0;
  /** Stable id seed for SVG filter ids — avoids cross-instance collisions. */
  private _instanceId: string;
  private _scrollHandler: () => void;
  private _resizeHandler: () => void;
  /**
   * Reveal elements (`data-aqualens-reveal-index`) currently tracked on
   * the page. Populated lazily by {@link discoverSvgReveals} when the
   * MutationObserver flags the DOM as dirty.
   */
  _reveals: SvgRevealMeta[] = [];
  private _revealObserver: MutationObserver | null = null;
  private _revealDirty = true;

  constructor() {
    this._instanceId = `aql${Math.floor(Math.random() * 1e9).toString(36)}`;
    this._host = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    ) as SVGSVGElement;
    this._host.setAttribute(SVG_HOST_ATTR, "");
    this._host.setAttribute("aria-hidden", "true");
    this._host.style.cssText =
      "position:absolute;width:0;height:0;pointer-events:none;left:0;top:0;visibility:hidden;";
    this._hostDefs = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "defs",
    ) as SVGDefsElement;
    this._host.appendChild(this._hostDefs);
    document.body.appendChild(this._host);

    // Scroll/resize: only relevant when reveal elements are tracked.
    // Without reveals the browser re-tracks `backdrop-filter` natively
    // for every lens as the page scrolls, so we have nothing to do.
    this._scrollHandler = () => {
      if (this._destroyed) return;
      if (this._reveals.length === 0 || this.lenses.length === 0) return;
      // Non-fixed lenses scroll with the page, so their viewport
      // rect is stale until we re-read it. Marking everything dirty
      // is cheap and avoids per-lens position-mode introspection.
      for (const lens of this.lenses) lens._markRectDirty();
      this.requestRender();
    };
    this._resizeHandler = () => {
      if (this._destroyed) return;
      if (this._reveals.length === 0 || this.lenses.length === 0) return;
      for (const lens of this.lenses) lens._markRectDirty();
      this.requestRender();
    };
    window.addEventListener("scroll", this._scrollHandler, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", this._resizeHandler, { passive: true });

    ensureSvgRevealStyles();
    this._installRevealObserver();
  }

  /**
   * Watch the document for reveal-related mutations: nodes being added or
   * removed, or the gating attributes (`data-aqualens-reveal-index`,
   * `data-aqualens-reveal-mode`) changing on existing nodes. Any of those
   * flips `_revealDirty`, prompting a fresh `discoverSvgReveals` pass on
   * the next render.
   */
  private _installRevealObserver(): void {
    if (typeof MutationObserver === "undefined") return;
    if (typeof document === "undefined") return;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          this._revealDirty = true;
          this.requestRender();
          return;
        }
        if (mutation.type !== "childList") continue;
        if (
          containsRevealNode(mutation.addedNodes) ||
          containsRevealNode(mutation.removedNodes)
        ) {
          this._revealDirty = true;
          this.requestRender();
          return;
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: SVG_REVEAL_OBSERVED_ATTRS as string[],
    });
    this._revealObserver = observer;
  }

  addLens(element: HTMLElement, options: AqualensConfig): SvgLens {
    const lens = new SvgLens(this, element, options);
    this.lenses.push(lens);
    this.requestRender();
    return lens;
  }

  removeLens(lens: SvgLens): void {
    const index = this.lenses.indexOf(lens);
    if (index !== -1) this.lenses.splice(index, 1);
    this.requestRender();
  }

  requestRender(): void {
    if (this._destroyed || this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this.render();
    });
  }

  /** Allocate a unique id for an SVG defs node. */
  _allocateId(prefix: string): string {
    return `${this._instanceId}-${prefix}-${++this._filterIdCounter}`;
  }

  /** Append a `<filter>` / `<clipPath>` node to the shared `<defs>`. */
  _appendDef(node: SVGElement): void {
    this._hostDefs.appendChild(node);
  }

  /** Remove a defs node when its owning lens is torn down. */
  _removeDef(node: SVGElement): void {
    if (node.parentNode === this._hostDefs) this._hostDefs.removeChild(node);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    window.removeEventListener("scroll", this._scrollHandler, true);
    window.removeEventListener("resize", this._resizeHandler);
    if (this._revealObserver) {
      this._revealObserver.disconnect();
      this._revealObserver = null;
    }
    restoreAllReveals(this._reveals);
    clearSvgRevealStyles();
    for (const lens of this.lenses) lens.destroy();
    this.lenses.length = 0;
    if (this._host.parentNode) this._host.parentNode.removeChild(this._host);
  }

  // ---- main render pass ----

  render(): void {
    if (this._destroyed) return;
    for (const lens of this.lenses) lens._refreshMetrics();

    if (this._revealDirty) {
      this._revealDirty = false;
      discoverSvgReveals(this._reveals);
    }

    // Each lens renders alone — the SVG backend never merges sibling
    // lenses into a single shared blob (use `mode="webgl"` for that).
    // Lenses are still ordered by `stackingIndex` (implicit ones first,
    // then explicit ascending) so the opaque-overlap clip-path math has
    // a deterministic group ordering.
    const implicit: SvgLens[] = [];
    const explicit: { lens: SvgLens; stackingIndex: number }[] = [];
    for (const lens of this.lenses) {
      const stackingIndex = lens.options.stackingIndex;
      if (stackingIndex === undefined) implicit.push(lens);
      else explicit.push({ lens, stackingIndex });
    }
    explicit.sort((a, b) => a.stackingIndex - b.stackingIndex);

    type Group = { lenses: SvgLens[]; key: string };
    const groups: Group[] = [];
    for (let index = 0; index < implicit.length; index++) {
      groups.push({ lenses: [implicit[index]], key: `imp-${index}` });
    }
    for (let index = 0; index < explicit.length; index++) {
      const { lens, stackingIndex } = explicit[index];
      groups.push({ lenses: [lens], key: `exp-${stackingIndex}-${index}` });
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const visible = group.lenses.filter((lens) => lens._isVisible());
      if (visible.length === 0) {
        for (const lens of group.lenses) lens._renderHidden();
        continue;
      }
      visible[0]._renderSingle();
    }

    // Opaque overlap: lower groups must be cut out under higher ones so
    // the higher group's backdrop-filter samples the original page.
    if (this.opaqueOverlap && groups.length > 1) {
      this._applyOpaqueOverlap(groups);
    } else {
      // Tear down any clip-paths we may have applied on a previous
      // frame when the toggle was on.
      for (const group of groups) {
        for (const lens of group.lenses) lens._clearClipPath();
      }
    }

    // Update reveal element clip-paths. Done after lenses to ensure
    // their `rectPx` reflects the latest `_refreshMetrics` pass.
    if (this._reveals.length > 0) {
      applyRevealClipPaths(this._reveals, this.lenses);
    }
  }

  private _applyOpaqueOverlap(
    groups: { lenses: SvgLens[]; key: string }[],
  ): void {
    // For each group except the topmost, build a clip-path that
    // subtracts the silhouettes of every higher group. We use one
    // `<clipPath>` per affected lens, sized to the lens's own bbox.
    for (let groupIndex = 0; groupIndex < groups.length - 1; groupIndex++) {
      const lowerGroup = groups[groupIndex];
      const higherShapes: RoundedRectShape[] = [];
      for (let h = groupIndex + 1; h < groups.length; h++) {
        for (const lens of groups[h].lenses) {
          const shape = lens._getViewportShape();
          if (shape) higherShapes.push(shape);
        }
      }
      for (const lens of lowerGroup.lenses) {
        lens._applyClipPath(higherShapes);
      }
    }
    // Topmost group needs no cut-outs.
    const top = groups[groups.length - 1];
    for (const lens of top.lenses) lens._clearClipPath();
  }
}

/**
 * Returns true if any node in the list is itself a reveal element or
 * contains one in its subtree. Used by the SvgRenderer's MutationObserver
 * to skip rediscovery when the change has nothing to do with reveals.
 */
function containsRevealNode(nodes: NodeList): boolean {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!(node instanceof Element)) continue;
    if (node.matches?.(SVG_REVEAL_SELECTOR)) return true;
    if (node.querySelector?.(SVG_REVEAL_SELECTOR)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
//  Per-lens state
// ---------------------------------------------------------------------------

interface FilterRefs {
  filterNode: SVGFilterElement;
  filterId: string;
  /**
   * Combined map image: encodes X displacement in R, Y displacement
   * in G, specular alpha in B. Reused by the per-channel
   * `<feDisplacementMap>` nodes (which read R/G) and by a
   * `<feColorMatrix>` that extracts the B channel as the specular
   * layer's alpha.
   */
  feImageCombined: SVGFEImageElement;
  /**
   * Per-channel displacement nodes for chromatic aberration. When the
   * filter is built without dispersion, all three references point at
   * the same single `<feDisplacementMap>` node — `_regenerateFilter`
   * still updates "all three" but the assignments collapse to one.
   */
  feDisplacementMapR: SVGFEDisplacementMapElement;
  feDisplacementMapG: SVGFEDisplacementMapElement;
  feDisplacementMapB: SVGFEDisplacementMapElement;
  feGaussianBlur: SVGFEGaussianBlurElement;
  /** Whether this filter was built with the chromatic-aberration pipeline. */
  withDispersion: boolean;
}

interface DisplacementCacheKey {
  width: number;
  height: number;
  radii: string;
  glassThickness: number;
  bezelWidth: number;
  surfaceShape: string;
  refractiveIndex: number;
  factor: number;
  blur: number;
  glareAlpha: number;
  glareAngle: number;
  glareOpposite: number;
  dpr: number;
  rasterDpr: number;
  tintR: number;
  tintG: number;
  tintB: number;
  tintA: number;
}

function cacheKeyToString(key: DisplacementCacheKey): string {
  return JSON.stringify(key);
}

export class SvgLens implements AqualensLensInstance {
  renderer: SvgRenderer;
  element: HTMLElement;
  options: AqualensConfig;
  rectPx: DOMRectLike | null = null;
  radiusGl = 0;
  radiusCss = 0;
  radiusGlCorners: CornerRadii = { tl: 0, tr: 0, br: 0, bl: 0 };
  radiusCssCorners: CornerRadii = { tl: 0, tr: 0, br: 0, bl: 0 };

  shadowParams: ShadowParams | null = null;

  private _resizeObserver: ResizeObserver | null = null;
  private _attrObserver: MutationObserver | null = null;
  private _userBgColor = "";
  private _userBg = "";

  /** Per-lens `<filter>`. Lazily allocated. */
  private _filter: FilterRefs | null = null;
  /** Tint and specular overlays inside the lens element. */
  private _tintEl: HTMLDivElement | null = null;
  private _specularEl: HTMLImageElement | null = null;
  /** Last cache key used to skip redundant displacement-map regeneration. */
  private _lastDisplacementKey: string | null = null;
  /** Last computed tint background string applied to `_tintEl`. */
  private _lastTintBg: string | null = null;
  /**
   * Last `backdrop-filter` value we wrote on `lens.element`. Cached
   * to skip redundant `setProperty` calls — every redundant write
   * triggers our `_attrObserver`, which would otherwise schedule a
   * follow-up render and double the work per real position change.
   */
  private _lastAppliedBackdropFilter: string | null = null;
  /** Last applied clip-path data — used to avoid redundant DOM writes. */
  private _appliedClipPath: string | null = null;
  /** Original z-index restored on destroy / when stackingIndex unset. */
  private _stackingZApplied = false;
  private _savedZIndexInline = "";
  private _appliedZIndex: string | null = null;
  /** Whether we marked the element with `data-aqualens-lens`. */
  private _markedLens = false;

  /** Used by `_isVisible` to gate empty-rect renders. */
  private _rectDirty = true;
  private _lastRectW = 0;
  private _lastRectH = 0;
  /**
   * When true, re-run tint extraction + border-radius parsing (both need
   * `getComputedStyle`). Cleared on each successful pass. Skipped on
   * frames where only the viewport bbox moved (e.g. `left`/`top`
   * updates) — see the `MutationObserver` path.
   */
  private _styleMetricsDirty = true;

  constructor(
    renderer: SvgRenderer,
    element: HTMLElement,
    options: AqualensConfig,
  ) {
    this.renderer = renderer;
    this.element = element;
    this.options = { ...options, tint: DEFAULT_TINT };

    if (
      !this.element.style.position ||
      this.element.style.position === "static"
    ) {
      this.element.style.position = "relative";
    }
    this.element.setAttribute(SVG_LENS_DOM_ATTR, "");
    this._markedLens = true;

    const computedShadow = window.getComputedStyle(this.element).boxShadow;
    this.shadowParams = parseBoxShadow(computedShadow);

    this._captureUserInlineBg();
    this._applyTransparentBgOverride();
    this._updateTintFromCss();

    // Tint and specular are children of the lens element. The tint sits
    // BEHIND the user content (`z-index: -1` inside the isolated lens),
    // the specular sits ABOVE everything (a very high z-index inside
    // the lens's own stacking context, capped by `isolation: isolate`).
    if (!this.element.style.isolation) {
      this.element.style.isolation = "isolate";
    }
    this._buildOverlays();
    this._refreshMetrics();
    this._syncStackingZIndex();

    this._fireInit();

    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => {
        this._rectDirty = true;
        this._styleMetricsDirty = true;
        this.renderer.requestRender();
      });
      this._resizeObserver.observe(this.element);
    }

    if (typeof MutationObserver !== "undefined") {
      this._attrObserver = new MutationObserver((mutations) => {
        // We need to differentiate two kinds of style mutations:
        //
        //   1. **Real foreign writes** — React re-renders, user code,
        //      WAAPI / `commitStyles()`, devtools edits, etc. These
        //      may genuinely change the lens's tint or geometry and
        //      must trigger reconciliation + re-render.
        //
        //   2. **Net-zero peeks** — our own `_updateTintFromCss`
        //      strips our `transparent !important` background overrides
        //      to read the cascade, then re-applies them. Multiple
        //      `setProperty` calls happen synchronously but the
        //      attribute string ends in the same shape it started.
        //
        // Skipping the second case is critical for perf: every render
        // performs at least one net-zero peek when reading the tint,
        // which would otherwise schedule another render via the
        // `requestRender` call below — turning every position update
        // into 2× the work. We compare the earliest mutation's
        // `oldValue` with the element's current `style` attribute
        // string; if they match, the batch was net-zero and we bail.
        let classChanged = false;
        let styleOldValue: string | null = null;
        for (const mutation of mutations) {
          if (mutation.type !== "attributes") continue;
          if (mutation.attributeName === "class") classChanged = true;
          else if (
            mutation.attributeName === "style" &&
            styleOldValue === null
          ) {
            styleOldValue = mutation.oldValue ?? "";
          }
        }
        let realStyleChange = false;
        if (styleOldValue !== null) {
          const currentStyle = this.element.getAttribute("style") ?? "";
          realStyleChange = styleOldValue !== currentStyle;
        }
        if (realStyleChange) this._reconcileBgOverride();
        if (classChanged) {
          this._rectDirty = true;
          this._styleMetricsDirty = true;
        } else if (realStyleChange) {
          this._rectDirty = true;
          const currentStyle = this.element.getAttribute("style") ?? "";
          if (styleChangeAffectsLensGeometry(styleOldValue ?? "", currentStyle)) {
            this._styleMetricsDirty = true;
          }
        }
        if (realStyleChange || classChanged) {
          this.renderer.requestRender();
        }
      });
      this._attrObserver.observe(this.element, {
        attributes: true,
        attributeFilter: ["style", "class"],
        attributeOldValue: true,
      });
    }
  }

  // ------------------------------------------------------------------
  //  Public API used by the SvgRenderer
  // ------------------------------------------------------------------

  getEffectiveZ(): number {
    return this.options.stackingIndex ?? 0;
  }

  updateMetrics(): void {
    this._refreshMetrics();
  }

  destroy(): void {
    this._resizeObserver?.disconnect();
    this._attrObserver?.disconnect();
    this._resizeObserver = null;
    this._attrObserver = null;
    this._tintEl?.remove();
    this._specularEl?.remove();
    this._tintEl = null;
    this._specularEl = null;
    this._destroyFilter();
    this._clearClipPath();
    this._restoreInlineBg();
    if (this._stackingZApplied) {
      if (this._savedZIndexInline === "") {
        this.element.style.removeProperty("z-index");
      } else {
        this.element.style.zIndex = this._savedZIndexInline;
      }
      this._stackingZApplied = false;
    }
    if (this._markedLens) {
      this.element.removeAttribute(SVG_LENS_DOM_ATTR);
      this._markedLens = false;
    }
    this.element.style.removeProperty("backdrop-filter");
    this.element.style.removeProperty("-webkit-backdrop-filter");
    this.renderer.removeLens(this);
  }

  _markRectDirty(): void {
    this._rectDirty = true;
  }

  _refreshMetrics(): void {
    this._syncStackingZIndex();
    if (this._rectDirty) {
      const rect = this.element.getBoundingClientRect();
      this.rectPx = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      this._rectDirty = false;
      if (
        rect.width !== this._lastRectW ||
        rect.height !== this._lastRectH
      ) {
        this._lastRectW = rect.width;
        this._lastRectH = rect.height;
        this._styleMetricsDirty = true;
      }
    }
    if (!this.rectPx || this.rectPx.width <= 0 || this.rectPx.height <= 0)
      return;
    if (!this._styleMetricsDirty) return;
    this._styleMetricsDirty = false;

    this._updateTintFromCss();

    const style = window.getComputedStyle(this.element);
    const rootStyle = window.getComputedStyle(document.documentElement);
    const emBase =
      parseFloat(style.fontSize) || parseFloat(rootStyle.fontSize) || 16;
    const rect = this.rectPx as unknown as DOMRect;
    let raw: CornerRadii = {
      tl: parseCornerRadius(style.borderTopLeftRadius, rect, emBase),
      tr: parseCornerRadius(style.borderTopRightRadius, rect, emBase),
      br: parseCornerRadius(style.borderBottomRightRadius, rect, emBase),
      bl: parseCornerRadius(style.borderBottomLeftRadius, rect, emBase),
    };
    const sum = raw.tl + raw.tr + raw.br + raw.bl;
    if (
      sum <= 0 &&
      style.borderRadius &&
      style.borderRadius !== "0px" &&
      style.borderRadius !== "none"
    ) {
      const fallback = parseCornerRadius(
        style.borderRadius.trim(),
        rect,
        emBase,
      );
      if (Number.isFinite(fallback) && fallback > 0) {
        raw = { tl: fallback, tr: fallback, br: fallback, bl: fallback };
      }
    }
    const corners = normalizeCornerRadii(raw, rect.width, rect.height);
    this.radiusCssCorners = corners;
    this.radiusCss = Math.max(corners.tl, corners.tr, corners.br, corners.bl);
    const dpr = this._effectiveDpr();
    this.radiusGl = this.radiusCss * dpr;
    this.radiusGlCorners = {
      tl: corners.tl * dpr,
      tr: corners.tr * dpr,
      br: corners.br * dpr,
      bl: corners.bl * dpr,
    };
  }

  _isVisible(): boolean {
    const rect = this.rectPx;
    return !!(rect && rect.width > 1 && rect.height > 1);
  }

  /** Lens shape in viewport coords (used for opaque-overlap clipping). */
  _getViewportShape(): RoundedRectShape | null {
    const rect = this.rectPx;
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      radii: this.radiusCssCorners,
    };
  }

  /** Single-lens render path: per-lens filter + per-lens overlays. */
  _renderSingle(): void {
    const rect = this.rectPx;
    if (!rect) return;
    const dpr = this._effectiveDpr();
    const shape: RoundedRectShape = {
      x: 0,
      y: 0,
      width: rect.width,
      height: rect.height,
      radii: this.radiusCssCorners,
    };
    const filter = this._ensureFilter(this._dispersionRequested());
    this._regenerateFilter(filter, shape, rect.width, rect.height, dpr);
    this._applyBackdropFilter(filter.filterId);
    this._showOverlays();
    this._syncTintBackground();
  }

  _renderHidden(): void {
    this._destroyFilter();
    if (this._tintEl) this._tintEl.style.display = "none";
    if (this._specularEl) this._specularEl.style.display = "none";
    this.element.style.removeProperty("backdrop-filter");
    this.element.style.removeProperty("-webkit-backdrop-filter");
  }

  // ------------------------------------------------------------------
  //  Internal helpers
  // ------------------------------------------------------------------

  private _effectiveDpr(): number {
    return Math.min(this.options.resolution, window.devicePixelRatio || 1);
  }

  /**
   * Whether this lens currently asks for chromatic-aberration. Drives
   * the choice between the heavy 3-channel filter pipeline and the
   * cheap single-`<feDisplacementMap>` pipeline. Recomputed every
   * render so toggling `refraction.dispersion` to/from 0 swaps the
   * pipeline on the next frame.
   */
  private _dispersionRequested(): boolean {
    return (this.options.refraction.dispersion ?? 0) > 0;
  }

  private _ensureFilter(withDispersion: boolean): FilterRefs {
    if (this._filter && this._filter.withDispersion === withDispersion) {
      return this._filter;
    }
    // Mode swap (CA on/off) requires a full rebuild because the filter
    // primitive graph is structurally different. Tear down the old
    // node, drop the cached backdrop-filter id, and rebuild fresh.
    if (this._filter) {
      this.renderer._removeDef(this._filter.filterNode);
      this._lastDisplacementKey = null;
      this._lastAppliedBackdropFilter = null;
    }
    this._filter = this._buildEmptyFilter(withDispersion);
    return this._filter;
  }

  private _destroyFilter(): void {
    if (!this._filter) return;
    this.renderer._removeDef(this._filter.filterNode);
    this._filter = null;
    this._lastDisplacementKey = null;
    this._lastAppliedBackdropFilter = null;
    this.element.style.removeProperty("backdrop-filter");
    this.element.style.removeProperty("-webkit-backdrop-filter");
  }

  private _buildEmptyFilter(withDispersion: boolean): FilterRefs {
    const ns = "http://www.w3.org/2000/svg";
    const filterId = this.renderer._allocateId("filter");
    const filterNode = document.createElementNS(
      ns,
      "filter",
    ) as SVGFilterElement;
    filterNode.setAttribute("id", filterId);
    // Static, broad filter region anchored to the lens bounding box.
    // `objectBoundingBox` units (default for `filterUnits`) make this
    // insensitive to the lens's pixel size — the region grows
    // automatically as the lens grows. The 200% extension on every
    // side gives `<feDisplacementMap>` enough headroom to sample
    // SourceGraphic from beyond the lens silhouette without clipping
    // even at strong refraction + chromatic-aberration settings.
    //
    // Mirrors the kube.io reference, and replaces a `userSpaceOnUse`
    // region that we used to recompute every render — saving 4
    // setAttribute calls per frame in the steady state.
    filterNode.setAttribute("x", "-50%");
    filterNode.setAttribute("y", "-50%");
    filterNode.setAttribute("width", "200%");
    filterNode.setAttribute("height", "200%");
    // `primitiveUnits="userSpaceOnUse"` keeps inner primitive coords
    // (feImage's x/y/width/height) in pixels, which is what we use.
    filterNode.setAttribute("primitiveUnits", "userSpaceOnUse");
    filterNode.setAttribute("color-interpolation-filters", "sRGB");

    const feGaussianBlur = document.createElementNS(
      ns,
      "feGaussianBlur",
    ) as SVGFEGaussianBlurElement;
    feGaussianBlur.setAttribute("in", "SourceGraphic");
    feGaussianBlur.setAttribute("stdDeviation", "0");
    feGaussianBlur.setAttribute("result", "blurred");

    // Single image holding both displacement (R/G) and specular (B).
    // See `buildCombinedLensImageData` for the channel layout.
    const feImageCombined = document.createElementNS(
      ns,
      "feImage",
    ) as SVGFEImageElement;
    feImageCombined.setAttribute("result", "combMap");
    feImageCombined.setAttribute("preserveAspectRatio", "none");

    filterNode.appendChild(feGaussianBlur);
    filterNode.appendChild(feImageCombined);

    let feDisplacementMapR: SVGFEDisplacementMapElement;
    let feDisplacementMapG: SVGFEDisplacementMapElement;
    let feDisplacementMapB: SVGFEDisplacementMapElement;

    if (withDispersion) {
      // Per-channel displacement (chromatic aberration). Three
      // feDisplacementMap nodes share the source/map but use slightly
      // different `scale` values (see `_regenerateFilter`); we then
      // strip down each output to one colour channel and sum the
      // three streams to produce the final fringed image.
      feDisplacementMapR = createDisplacementNode(
        ns,
        "blurred",
        "combMap",
        "dispR",
      );
      feDisplacementMapG = createDisplacementNode(
        ns,
        "blurred",
        "combMap",
        "dispG",
      );
      feDisplacementMapB = createDisplacementNode(
        ns,
        "blurred",
        "combMap",
        "dispB",
      );

      const onlyR = makeChannelExtract(ns, "dispR", "onlyR", 0);
      const onlyG = makeChannelExtract(ns, "dispG", "onlyG", 1);
      const onlyB = makeChannelExtract(ns, "dispB", "onlyB", 2);

      const sumRG = document.createElementNS(ns, "feComposite");
      sumRG.setAttribute("in", "onlyR");
      sumRG.setAttribute("in2", "onlyG");
      sumRG.setAttribute("operator", "arithmetic");
      sumRG.setAttribute("k1", "0");
      sumRG.setAttribute("k2", "1");
      sumRG.setAttribute("k3", "1");
      sumRG.setAttribute("k4", "0");
      sumRG.setAttribute("result", "sumRG");

      const sumRGB = document.createElementNS(ns, "feComposite");
      sumRGB.setAttribute("in", "sumRG");
      sumRGB.setAttribute("in2", "onlyB");
      sumRGB.setAttribute("operator", "arithmetic");
      sumRGB.setAttribute("k1", "0");
      sumRGB.setAttribute("k2", "1");
      sumRGB.setAttribute("k3", "1");
      sumRGB.setAttribute("k4", "0");
      sumRGB.setAttribute("result", "displaced");

      filterNode.appendChild(feDisplacementMapR);
      filterNode.appendChild(feDisplacementMapG);
      filterNode.appendChild(feDisplacementMapB);
      filterNode.appendChild(onlyR);
      filterNode.appendChild(onlyG);
      filterNode.appendChild(onlyB);
      filterNode.appendChild(sumRG);
      filterNode.appendChild(sumRGB);
    } else {
      // Fast pipeline: a single feDisplacementMap. About 3× cheaper on
      // the GPU than the chromatic-aberration variant since we drop
      // two displacement passes plus six channel-extract / composite
      // primitives. Used whenever `refraction.dispersion === 0`.
      const dispNode = createDisplacementNode(
        ns,
        "blurred",
        "combMap",
        "displaced",
      );
      // Reuse the same node reference for R/G/B so `_regenerateFilter`'s
      // scale-update path stays uniform across both pipelines.
      feDisplacementMapR = dispNode;
      feDisplacementMapG = dispNode;
      feDisplacementMapB = dispNode;
      filterNode.appendChild(dispNode);
    }

    // Extract specular from the B channel of the combined map. The
    // matrix turns each pixel `(R, G, B, A)` into `(B, B, B, B)` —
    // a *premultiplied-equivalent* representation of "white at rim
    // intensity". Crucially, when the B channel is zero, the entire
    // pixel collapses to `(0, 0, 0, 0)` rather than `(1, 1, 1, 0)`.
    //
    // The previous `(1, 1, 1, B)` matrix tripped over Chrome's
    // `<feBlend mode="screen">` non-premultiplied compositing path: at
    // alpha=0 the formula `1 - (1 - Csrc)·(1 - Cdst)` collapses to
    // `Cdst` only when `Csrc = 0`. With `Csrc = 1` the result
    // saturates to white over the entire silhouette, painting a
    // visible white film inside the lens whenever the rim contribution
    // was zero.
    const specularExtract = document.createElementNS(ns, "feColorMatrix");
    specularExtract.setAttribute("in", "combMap");
    specularExtract.setAttribute("type", "matrix");
    specularExtract.setAttribute(
      "values",
      "0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 1 0 0",
    );
    specularExtract.setAttribute("result", "specular");

    const feBlend = document.createElementNS(
      ns,
      "feBlend",
    ) as SVGFEBlendElement;
    feBlend.setAttribute("in", "displaced");
    feBlend.setAttribute("in2", "specular");
    feBlend.setAttribute("mode", "screen");

    filterNode.appendChild(specularExtract);
    filterNode.appendChild(feBlend);
    this.renderer._appendDef(filterNode);
    return {
      filterNode,
      filterId,
      feImageCombined,
      feDisplacementMapR,
      feDisplacementMapG,
      feDisplacementMapB,
      feGaussianBlur,
      withDispersion,
    };
  }

  /** Recompute the displacement and specular images iff cache key changed. */
  private _regenerateFilter(
    filter: FilterRefs,
    shape: RoundedRectShape,
    cssWidth: number,
    cssHeight: number,
    dpr: number,
  ): void {
    const refraction = this.options.refraction;
    const glassThickness = refraction.thickness;
    // Bezel width: derived from `glare.range` so it stays consistent
    // with the other backends. Capped at half of the smaller side to
    // avoid the whole lens becoming bezel.
    const minSide = Math.min(cssWidth, cssHeight);
    const bezelWidth = Math.max(
      4,
      Math.min(this.options.glare.range || 20, minSide / 2),
    );
    const surfaceShape = this.options.surfaceShape;
    const refractiveIndex = this.options.refractiveIndex;
    const blur = Math.max(0, this.options.blurRadius * 0.25);
    const tint = this.options.tint;
    const glare = this.options.glare;
    const refractionFactor = Math.max(0, refraction.factor);

    // Raster resolution matches the lens's effective DPR (no
    // oversampling). The closed-form single-shape rasteriser produces
    // clean gradients at 1× and the SVG filter pipeline composites at
    // native pixel density on its own.
    const rasterDpr = Math.max(1, dpr);

    // Cap the longest edge of the displacement bitmap (in device
    // pixels). Full-viewport demo lenses would otherwise allocate
    // multi-megapixel `ImageData` + PNG encode every cache miss.
    const MAX_RASTER_LONG_EDGE = 720;
    const projectedLong = Math.max(cssWidth, cssHeight) * rasterDpr;
    const effectiveRasterDpr =
      projectedLong > MAX_RASTER_LONG_EDGE
        ? rasterDpr * (MAX_RASTER_LONG_EDGE / projectedLong)
        : rasterDpr;

    // Cache key built from the *exact* lens geometry. The displacement
    // bitmap and the lens silhouette must agree on the same width /
    // height / radii for the filter region to line up with the DOM box;
    // any mismatch shows up as a faint double edge along the rim.
    const radiiSignature =
      `${shape.x},${shape.y},${shape.width},${shape.height},` +
      `${shape.radii.tl}/${shape.radii.tr}/${shape.radii.br}/${shape.radii.bl}`;
    const cacheKey: DisplacementCacheKey = {
      width: cssWidth,
      height: cssHeight,
      radii: radiiSignature,
      glassThickness,
      bezelWidth,
      surfaceShape,
      refractiveIndex,
      factor: refractionFactor,
      blur,
      glareAlpha: glare.factor,
      glareAngle: glare.angle,
      glareOpposite: glare.oppositeFactor,
      dpr,
      rasterDpr: effectiveRasterDpr,
      tintR: tint.r,
      tintG: tint.g,
      tintB: tint.b,
      tintA: tint.a,
    };
    const keyString = cacheKeyToString(cacheKey);
    if (keyString === this._lastDisplacementKey) return;
    this._lastDisplacementKey = keyString;

    const surfaceFn = resolveSurfaceFn(surfaceShape).fn;
    const profile = calculateDisplacementProfile(
      glassThickness,
      bezelWidth,
      surfaceFn,
      refractiveIndex,
    );
    const maxDisplacement = maxAbsoluteDisplacement(profile);

    // Single combined image carries displacement (R/G) + specular (B).
    // Rasterised at the lens's exact CSS dimensions so `<feImage>` does
    // not have to stretch the bitmap (which produces a visible double
    // edge along the silhouette).
    const combined = buildCombinedLensImageData({
      cssWidth,
      cssHeight,
      dpr: effectiveRasterDpr,
      shapes: [shape],
      bezelWidth,
      profile,
      maxDisplacement,
      specularAngleRad: (glare.angle * Math.PI) / 180,
      primaryIntensity: Math.min(1, glare.factor / 100),
      oppositeFactor: Math.min(1, glare.oppositeFactor / 100),
    });
    const combinedUrl = imageDataToDataUrl(combined);

    // Base displacement scale, in CSS pixels. The displacement map
    // encodes normalised values in `[-1, 1]` so the actual pixel shift
    // at any sample position is `scale * normalised_value`.
    //
    // The 2× amplifier is empirical — without it, the kube.io profile's
    // peak magnitude (~38 CSS-px at default thickness/factor) lands
    // visibly *softer* than the WebGL backend's at the same parameters.
    // The discrepancy shows up because the WebGL shader uses a different
    // surface curvature model that concentrates more refraction at the
    // very rim, while the kube.io convex-squircle peaks slightly inside
    // the bezel. Doubling the base scale brings the apparent strength
    // of edge bending into visual parity with WebGL while preserving
    // the same `factor` knob the user already tunes against.
    const REFRACTION_AMPLIFIER = 2;
    const baseScale =
      maxDisplacement * refractionFactor * REFRACTION_AMPLIFIER;

    // Chromatic dispersion. Mirrors the WebGL backend's per-channel
    // refraction-index trick (N_R = 0.98, N_B = 1.02) applied to the
    // sample offset: red samples a *bit further* than green, blue a
    // *bit closer*. The dispersion strength comes from
    // `refraction.dispersion` in the same units as the WebGL config so
    // the two backends produce visually matching colour fringes.
    const dispersion = Math.max(0, this.options.refraction.dispersion);
    const N_R_DELTA = -0.02;
    const N_B_DELTA = 0.02;
    const dispScaleR = baseScale * (1 - N_R_DELTA * dispersion);
    const dispScaleG = baseScale;
    const dispScaleB = baseScale * (1 - N_B_DELTA * dispersion);

    // Update primitive attributes. The filter region itself is static
    // (`x="-50%" y="-50%" width="200%" height="200%"` set once in
    // `_buildEmptyFilter`) so we never touch it here — saves four
    // setAttribute calls per render in the steady state.
    filter.feImageCombined.setAttribute("href", combinedUrl);
    filter.feImageCombined.setAttribute("x", "0");
    filter.feImageCombined.setAttribute("y", "0");
    filter.feImageCombined.setAttribute("width", String(cssWidth));
    filter.feImageCombined.setAttribute("height", String(cssHeight));
    if (filter.withDispersion) {
      filter.feDisplacementMapR.setAttribute("scale", String(dispScaleR));
      filter.feDisplacementMapG.setAttribute("scale", String(dispScaleG));
      filter.feDisplacementMapB.setAttribute("scale", String(dispScaleB));
    } else {
      // Fast pipeline: all three references point at the same node;
      // one setAttribute is enough.
      filter.feDisplacementMapR.setAttribute("scale", String(baseScale));
    }
    filter.feGaussianBlur.setAttribute("stdDeviation", String(blur));
  }

  private _applyBackdropFilter(filterId: string): void {
    const value = `url(#${filterId})`;
    if (this._lastAppliedBackdropFilter === value) return;
    this._lastAppliedBackdropFilter = value;
    this.element.style.setProperty("backdrop-filter", value, "important");
    (this.element.style as CSSStyleDeclaration).setProperty(
      "-webkit-backdrop-filter",
      value,
      "important",
    );
  }

  private _showOverlays(): void {
    if (this._tintEl) this._tintEl.style.display = "block";
    // The specular `<img>` overlay is intentionally kept hidden — the
    // filter pipeline already paints the rim highlight onto the
    // refracted backdrop (via the combined image's B channel +
    // `<feColorMatrix>`/`<feBlend>` extract), so this overlay would
    // double-apply specular at the rim AND require a per-cache-miss
    // `toDataURL`. We keep the element around to support a future
    // opt-in mode that paints rim highlights on top of lens children.
    if (this._specularEl) this._specularEl.style.display = "none";
  }

  /**
   * Sync the tint overlay's CSS background to the current `options.tint`.
   * Guarded by a string compare so the `MutationObserver` doesn't spin
   * up a follow-up render every frame.
   */
  private _syncTintBackground(): void {
    if (!this._tintEl) return;
    const tint = this.options.tint;
    const next =
      tint.a > 0
        ? `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${tint.a})`
        : "transparent";
    if (next !== this._lastTintBg) {
      this._lastTintBg = next;
      this._tintEl.style.background = next;
    }
  }

  private _buildOverlays(): void {
    const tint = document.createElement("div");
    tint.setAttribute("data-aqualens-tint", "");
    tint.style.cssText =
      "position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;background:transparent;";
    this.element.appendChild(tint);
    this._tintEl = tint;

    const specular = document.createElement("img");
    specular.setAttribute("data-aqualens-specular", "");
    specular.setAttribute("alt", "");
    specular.style.cssText =
      "position:absolute;inset:0;z-index:2147483647;pointer-events:none;border-radius:inherit;mix-blend-mode:screen;width:100%;height:100%;display:block;";
    this.element.appendChild(specular);
    this._specularEl = specular;
  }

  private _captureUserInlineBg(): void {
    const style = this.element.style;
    if (style.getPropertyPriority("background-color") !== "important") {
      this._userBgColor = style.getPropertyValue("background-color");
    }
    if (style.getPropertyPriority("background") !== "important") {
      this._userBg = style.getPropertyValue("background");
    }
  }

  private _applyTransparentBgOverride(): void {
    const style = this.element.style;
    style.setProperty("background-color", "transparent", "important");
    style.setProperty("background", "transparent", "important");
  }

  private _reconcileBgOverride(): void {
    const style = this.element.style;
    let needReapply = false;
    if (style.getPropertyPriority("background-color") !== "important") {
      const value = style.getPropertyValue("background-color");
      if (value !== "") this._userBgColor = value;
      needReapply = true;
    }
    if (style.getPropertyPriority("background") !== "important") {
      const value = style.getPropertyValue("background");
      if (value !== "") this._userBg = value;
      needReapply = true;
    }
    if (needReapply) this._applyTransparentBgOverride();
  }

  private _restoreInlineBg(): void {
    const style = this.element.style;
    if (style.getPropertyPriority("background-color") === "important") {
      style.removeProperty("background-color");
    }
    if (style.getPropertyPriority("background") === "important") {
      style.removeProperty("background");
    }
    if (this._userBgColor) style.setProperty("background-color", this._userBgColor);
    if (this._userBg) style.setProperty("background", this._userBg);
  }

  private _updateTintFromCss(): void {
    const style = this.element.style;
    const hasOverride =
      style.getPropertyPriority("background-color") === "important" ||
      style.getPropertyPriority("background") === "important";

    let bgCol: string;
    if (hasOverride) {
      const restoredBgColor = !!this._userBgColor;
      const restoredBg = !!this._userBg;
      style.removeProperty("background-color");
      style.removeProperty("background");
      if (restoredBgColor)
        style.setProperty("background-color", this._userBgColor);
      if (restoredBg) style.setProperty("background", this._userBg);
      bgCol = window.getComputedStyle(this.element).backgroundColor;
      if (restoredBgColor) style.removeProperty("background-color");
      if (restoredBg) style.removeProperty("background");
      style.setProperty("background-color", "transparent", "important");
      style.setProperty("background", "transparent", "important");
    } else {
      bgCol = window.getComputedStyle(this.element).backgroundColor;
    }
    const parsed = parseBgColorToRgba(bgCol);
    this.options.tint = parsed ?? DEFAULT_TINT;
  }

  private _syncStackingZIndex(): void {
    const stackingIndex = this.options.stackingIndex;
    if (stackingIndex !== undefined) {
      if (!this._stackingZApplied) {
        this._savedZIndexInline = this.element.style.zIndex;
        this._stackingZApplied = true;
      }
      const desired = String(lensStackingZIndex(stackingIndex));
      if (this._appliedZIndex !== desired) {
        this.element.style.zIndex = desired;
        this._appliedZIndex = desired;
      }
    } else if (this._stackingZApplied) {
      if (this._savedZIndexInline === "") {
        this.element.style.removeProperty("z-index");
      } else {
        this.element.style.zIndex = this._savedZIndexInline;
      }
      this._stackingZApplied = false;
      this._savedZIndexInline = "";
      this._appliedZIndex = null;
    }
  }

  /**
   * Apply (or refresh) a clip-path that subtracts every higher-group
   * lens silhouette from this lens. Empty `higherShapes` triggers
   * removal.
   */
  _applyClipPath(higherShapes: RoundedRectShape[]): void {
    const rect = this.rectPx;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      this._clearClipPath();
      return;
    }
    if (higherShapes.length === 0) {
      this._clearClipPath();
      return;
    }

    // Build an SVG path with even-odd fill rule:
    //   - outer rect = own bbox in lens-local coords;
    //   - holes = each higher lens's silhouette intersected with our bbox.
    const ownPath = this._buildRoundedRectPath(
      0,
      0,
      rect.width,
      rect.height,
      this.radiusCssCorners,
    );
    const holePaths: string[] = [];
    for (const shape of higherShapes) {
      const localX = shape.x - rect.left;
      const localY = shape.y - rect.top;
      // Skip if no overlap with our bbox.
      if (
        localX + shape.width <= 0 ||
        localY + shape.height <= 0 ||
        localX >= rect.width ||
        localY >= rect.height
      ) {
        continue;
      }
      holePaths.push(
        this._buildRoundedRectPath(
          localX,
          localY,
          shape.width,
          shape.height,
          shape.radii,
        ),
      );
    }
    if (holePaths.length === 0) {
      this._clearClipPath();
      return;
    }

    const pathData = `${ownPath} ${holePaths.join(" ")}`;
    const clipValue = `path(evenodd, "${pathData}")`;
    if (this._appliedClipPath === clipValue) return;
    this._appliedClipPath = clipValue;
    this.element.style.setProperty("clip-path", clipValue);
    (this.element.style as CSSStyleDeclaration).setProperty(
      "-webkit-clip-path",
      clipValue,
    );
  }

  _clearClipPath(): void {
    if (this._appliedClipPath === null) return;
    this._appliedClipPath = null;
    this.element.style.removeProperty("clip-path");
    this.element.style.removeProperty("-webkit-clip-path");
  }

  private _buildRoundedRectPath(
    x: number,
    y: number,
    width: number,
    height: number,
    radii: CornerRadii,
  ): string {
    // Clamp radii to half of each side, in case the caller forgot.
    const tl = Math.min(radii.tl, width / 2, height / 2);
    const tr = Math.min(radii.tr, width / 2, height / 2);
    const br = Math.min(radii.br, width / 2, height / 2);
    const bl = Math.min(radii.bl, width / 2, height / 2);
    const right = x + width;
    const bottom = y + height;
    return [
      `M${x + tl} ${y}`,
      `L${right - tr} ${y}`,
      tr > 0 ? `A${tr} ${tr} 0 0 1 ${right} ${y + tr}` : "",
      `L${right} ${bottom - br}`,
      br > 0 ? `A${br} ${br} 0 0 1 ${right - br} ${bottom}` : "",
      `L${x + bl} ${bottom}`,
      bl > 0 ? `A${bl} ${bl} 0 0 1 ${x} ${bottom - bl}` : "",
      `L${x} ${y + tl}`,
      tl > 0 ? `A${tl} ${tl} 0 0 1 ${x + tl} ${y}` : "",
      "Z",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private _fireInit(): void {
    this.options.on?.init?.(this);
  }
}

/**
 * Build a `<feDisplacementMap>` node bound to the given source / map
 * channel ids. Used by the SVG filter assembly path to spawn three
 * sibling per-channel displacement nodes (R, G, B) with identical
 * inputs but distinct scales — the basis of our chromatic-aberration
 * effect. The `scale` attribute is finalised later in
 * `_regenerateFilter`, so we initialise it to 0 (no shift).
 */
function createDisplacementNode(
  ns: string,
  inAttr: string,
  in2Attr: string,
  resultAttr: string,
): SVGFEDisplacementMapElement {
  const node = document.createElementNS(
    ns,
    "feDisplacementMap",
  ) as SVGFEDisplacementMapElement;
  node.setAttribute("in", inAttr);
  node.setAttribute("in2", in2Attr);
  node.setAttribute("xChannelSelector", "R");
  node.setAttribute("yChannelSelector", "G");
  node.setAttribute("scale", "0");
  node.setAttribute("result", resultAttr);
  return node;
}

/**
 * Build a `<feColorMatrix>` that keeps just one of the input image's
 * RGB channels (zeroing the other two and the alpha). Used inside the
 * chromatic-aberration filter pipeline to combine three displacement
 * passes into one final image.
 */
function makeChannelExtract(
  ns: string,
  inAttr: string,
  resultAttr: string,
  channelIndex: 0 | 1 | 2,
): SVGFEColorMatrixElement {
  const r = channelIndex === 0 ? "1" : "0";
  const g = channelIndex === 1 ? "1" : "0";
  const b = channelIndex === 2 ? "1" : "0";
  const node = document.createElementNS(
    ns,
    "feColorMatrix",
  ) as SVGFEColorMatrixElement;
  node.setAttribute("in", inAttr);
  node.setAttribute("type", "matrix");
  node.setAttribute(
    "values",
    `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`,
  );
  node.setAttribute("result", resultAttr);
  return node;
}

