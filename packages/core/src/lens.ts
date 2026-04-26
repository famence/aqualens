import { parseBgColorToRgba, parseBoxShadow, type ShadowParams } from "./utils";
import type { AqualensRenderer } from "./renderer";
import {
  DEFAULT_TINT,
  type AqualensConfig,
  type DOMRectLike,
  type AqualensLensInstance,
} from "./types";
import {
  parseCornerRadius,
  normalizeCornerRadii,
  type CornerRadii,
} from "./css-parser";

/** Marker attribute placed on the DOM element of every lens. */
export const LENS_DOM_ATTR = "data-aqualens-lens";

export class AqualensLens implements AqualensLensInstance {
  renderer: AqualensRenderer;
  element: HTMLElement;
  options: AqualensConfig;
  rectPx: DOMRectLike | null = null;
  radiusGl = 0;
  radiusCss = 0;
  radiusGlCorners: CornerRadii = { tl: 0, tr: 0, br: 0, bl: 0 };
  radiusCssCorners: CornerRadii = { tl: 0, tr: 0, br: 0, bl: 0 };
  shadowParams: ShadowParams | null = null;

  /**
   * The public `<canvas>` element appended into the lens DOM as the very
   * first child. WebGL renders into the renderer's offscreen private canvas
   * and the relevant region is then copied here via `drawImage`. Because
   * this canvas lives **inside** the lens, the lens's own DOM content
   * paints naturally on top of it (CSS stacking) and is therefore never
   * picked up by WebGL refraction.
   */
  publicCanvas: HTMLCanvasElement;
  publicCtx: CanvasRenderingContext2D;
  /** Public canvas backing-store dimensions, in device pixels. */
  publicCanvasW = 0;
  publicCanvasH = 0;
  /** Padding (CSS px) added around the lens rect to host shadow / shadowPad. */
  publicCanvasPad = 0;
  /** Whether we installed `isolation: isolate` (so destroy() can revert it). */
  private _isolationApplied = false;
  /** Whether we overrode element `z-index` from `stackingIndex`. */
  private _stackingZApplied = false;
  /** Original inline z-index before we started syncing to stackingIndex. */
  private _savedZIndexInline = "";

  /**
   * Shadow copy of the user's last-known non-important inline
   * `background-color`. Updated:
   *  - once at construction (capturing the value React/HTML put on the
   *    element before we attached);
   *  - whenever `MutationObserver` detects a foreign mutation that
   *    re-introduced a non-important `background-color` (e.g. React
   *    re-rendering with a new `style={{ backgroundColor }}` value, or
   *    `Animation.commitStyles()` baking a WAAPI value into inline).
   *
   * Without this shadow, the `transparent !important` override we install
   * in `_enterWebglTint` would clobber the user's inline value in CSSOM
   * (CSSOM only stores one declaration per property), and we'd have no
   * way to (a) sample the underlying tint colour or (b) restore the inline
   * declaration during a strip-and-restore peek of the cascade.
   */
  private _userBgColor = "";
  /** Mirror of `_userBgColor` for the `background` shorthand. */
  private _userBg = "";

  private _initCalled = false;

  private _sizeObs: ResizeObserver | null = null;

  _rectDirty = true;

  /** When true, next updateMetrics() will re-read getComputedStyle and recalc corner radii. */
  private _styleMetricsDirty = true;
  private _lastRectW = 0;
  private _lastRectH = 0;
  private readonly _boundInvalidateStyle?: () => void;
  private _attrObserver: MutationObserver | null = null;
  private _styleAnimationRaf: number | null = null;
  private _activeStyleAnimations = 0;
  private readonly _boundStartStyleAnimation?: EventListener;
  private readonly _boundStopStyleAnimation?: EventListener;
  /**
   * Saved reference to the original `Element.prototype.animate` so we can
   * restore it on `destroy()`. We wrap `element.animate` to plug WAAPI
   * animations (used by framer-motion v11+ for properties like
   * `backgroundColor`) into the same `_styleAnimationRaf` resampling loop
   * that handles CSS transitions/animations.
   */
  private _origAnimate: HTMLElement["animate"] | null = null;

  _contentCapture: HTMLCanvasElement | null = null;
  _contentCaptureDirty = true;
  _contentCapturing = false;
  _contentObserver: MutationObserver | null = null;

  constructor(
    renderer: AqualensRenderer,
    element: HTMLElement,
    options: AqualensConfig,
  ) {
    this.renderer = renderer;
    this.element = element;
    this.options = { ...options };

    // The lens element must establish a containing block for our
    // absolutely-positioned public canvas. If the user did not pick a
    // positioned value we default to `relative`.
    if (
      !this.element.style.position ||
      this.element.style.position === "static"
    ) {
      this.element.style.position = "relative";
    }

    // Marker attribute used by snapshot / dynamic-capture paths to
    // identify "this is a lens, ignore its subtree from refraction
    // sources" — without this, dynamic-capture html2canvas of a fixed
    // ancestor would re-bake lens content (icons, tabs) into the source
    // texture and lenses would refract themselves.
    this.element.setAttribute(LENS_DOM_ATTR, "");

    const boxShadow = window.getComputedStyle(this.element).boxShadow;
    this.shadowParams = parseBoxShadow(boxShadow);
    this.element.style.setProperty("box-shadow", "none", "important");

    this.element.style.setProperty("backdrop-filter", "none", "important");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.element.style as any).setProperty(
      "-webkit-backdrop-filter",
      "none",
      "important",
    );
    // background-image override is applied in both tint modes to suppress
    // gradients (we only honour the user's solid background-color for tint).
    this.element.style.setProperty("background-image", "none", "important");

    // Capture the user's inline background-color *before* we install our
    // `transparent !important` override (which would erase the user's
    // value from CSSOM).
    this._captureUserInlineBg();
    // Make sure the lens itself never paints any background — the WebGL
    // canvas inside the lens paints both the refracted scene AND the tint
    // colour, so any CSS background would show through anti-aliased
    // edges and double-tint anything inside the SDF shape.
    this._applyOverride();
    this._updateTintFromCss();
    this._syncStackingZIndex();

    // Build the per-lens public canvas. It is positioned absolute and
    // covers the full lens rect (including shadowPad on every side) so
    // glass refraction, glare and box-shadow all fit inside it.
    //
    // CRITICAL: `z-index: -1` puts the canvas BEHIND the lens's DOM
    // content. Without it, the canvas (positioned, painting group 6)
    // would paint OVER any in-flow children of the lens (painting
    // group 3) and obscure them. To make sure `z-index: -1` stays
    // contained inside the lens (and doesn't bleed below the lens's
    // own background), we also force the lens itself to establish a
    // stacking context via `isolation: isolate`.
    this.publicCanvas = document.createElement("canvas");
    this.publicCanvas.setAttribute("data-aqualens-canvas", "");
    this.publicCanvas.setAttribute("data-liquid-ignore", "");
    this.publicCanvas.style.cssText =
      "position:absolute;pointer-events:none;left:0;top:0;width:100%;height:100%;z-index:-1;";
    const ctx = this.publicCanvas.getContext("2d");
    if (!ctx) {
      throw new Error("Aqualens: 2D canvas context unavailable");
    }
    this.publicCtx = ctx;
    if (this.element.firstChild) {
      this.element.insertBefore(this.publicCanvas, this.element.firstChild);
    } else {
      this.element.appendChild(this.publicCanvas);
    }
    if (!this.element.style.isolation) {
      this.element.style.isolation = "isolate";
      this._isolationApplied = true;
    }

    this.updateMetrics();
    this._syncPublicCanvasSize();

    if (typeof ResizeObserver !== "undefined") {
      this._sizeObs = new ResizeObserver(() => {
        this.invalidateStyleMetrics();
        this.updateMetrics();
        this._syncPublicCanvasSize();
        this.renderer.requestRender();
      });
      this._sizeObs.observe(this.element);
    }

    this._boundInvalidateStyle = () => {
      this.invalidateStyleMetrics();
      this.renderer.requestRender();
    };
    this._boundStartStyleAnimation = () => this._startStyleAnimationTracking();
    this._boundStopStyleAnimation = () => this._stopStyleAnimationTracking();
    this.element.addEventListener(
      "transitionrun",
      this._boundStartStyleAnimation,
      {
        passive: true,
      },
    );
    this.element.addEventListener(
      "animationstart",
      this._boundStartStyleAnimation,
      {
        passive: true,
      },
    );
    this.element.addEventListener(
      "transitionend",
      this._boundStopStyleAnimation,
      {
        passive: true,
      },
    );
    this.element.addEventListener(
      "transitioncancel",
      this._boundStopStyleAnimation,
      {
        passive: true,
      },
    );
    this.element.addEventListener(
      "animationend",
      this._boundStopStyleAnimation,
      {
        passive: true,
      },
    );
    this.element.addEventListener(
      "animationcancel",
      this._boundStopStyleAnimation,
      {
        passive: true,
      },
    );
    if (typeof MutationObserver !== "undefined") {
      this._attrObserver = new MutationObserver((mutations) => {
        // Strategy: differentiate **net** changes to the `style` attribute
        // (real foreign mutations from React / commitStyles / devtools…)
        // from **net-zero** changes (our own strip-and-restore peeks in
        // `_updateTintFromCss`, which start and end with the same
        // attribute string). We compare the earliest record's `oldValue`
        // with the element's current `style` attribute — equal means no
        // real change, so we skip reconciliation and invalidation. This
        // is robust regardless of how many intermediate setProperty calls
        // we make per peek.
        let classChanged = false;
        let styleOldValue: string | null = null;
        for (const mutation of mutations) {
          if (mutation.type !== "attributes") continue;
          if (mutation.attributeName === "class") {
            classChanged = true;
          } else if (
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

        if (realStyleChange) {
          // A foreign style attribute write happened (React re-render,
          // commitStyles(), user `el.style.x = ...`, devtools edits…).
          // Reconcile the bg-color override: if the user's non-important
          // inline value re-appeared, capture it into the shadow store
          // and re-apply our override on top.
          this._reconcileBgOverride();
        }

        if (realStyleChange || classChanged) {
          this._boundInvalidateStyle?.();
        }
      });
      this._attrObserver.observe(this.element, {
        attributes: true,
        attributeFilter: ["style", "class"],
        attributeOldValue: true,
      });
    }

    if (typeof MutationObserver !== "undefined") {
      this._contentObserver = new MutationObserver((mutations) => {
        // Skip mutations that are just our own public canvas being
        // resized / its attributes touched — they don't change the
        // lens's user-content silhouette.
        let realChange = false;
        for (const mutation of mutations) {
          if (mutation.target === this.publicCanvas) continue;
          if (
            mutation.type === "childList" &&
            (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
          ) {
            // Ignore if the only thing changing is the public canvas itself
            // being added/removed.
            const onlyOurs = [
              ...mutation.addedNodes,
              ...mutation.removedNodes,
            ].every((node) => node === this.publicCanvas);
            if (!onlyOurs) {
              realChange = true;
              break;
            }
          } else if (mutation.type === "characterData") {
            realChange = true;
            break;
          }
        }
        if (!realChange) return;
        this._contentCaptureDirty = true;
        this.renderer.requestRender();
      });
      this._contentObserver.observe(this.element, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    this._installAnimateInterceptor();
  }

  /**
   * Increment the active-animation counter and (re)start the per-frame style
   * resampling loop. Each frame the loop calls `_boundInvalidateStyle`, which
   * marks style metrics dirty so the next render re-reads `background-color`
   * via `_updateTintFromCss` and picks up the in-progress animated value.
   */
  private _startStyleAnimationTracking(): void {
    this._activeStyleAnimations += 1;
    if (this._styleAnimationRaf !== null) return;
    const step = () => {
      if (this._activeStyleAnimations <= 0) {
        this._styleAnimationRaf = null;
        return;
      }
      this._boundInvalidateStyle?.();
      this._styleAnimationRaf = requestAnimationFrame(step);
    };
    this._boundInvalidateStyle?.();
    this._styleAnimationRaf = requestAnimationFrame(step);
  }

  private _stopStyleAnimationTracking(): void {
    if (this._activeStyleAnimations > 0) {
      this._activeStyleAnimations -= 1;
    }
    if (this._activeStyleAnimations > 0) return;
    if (this._styleAnimationRaf !== null) {
      cancelAnimationFrame(this._styleAnimationRaf);
      this._styleAnimationRaf = null;
    }
    this._boundInvalidateStyle?.();
  }

  /**
   * Wrap `element.animate` so any Web Animations API animation started on
   * the lens element (e.g. by framer-motion's `whileTap` / `whileDrag` for
   * `backgroundColor`) drives the same `_styleAnimationRaf` resampling
   * loop as CSS transitions. WAAPI animations don't dispatch
   * `transitionrun` / `animationstart` events on the element and don't
   * mutate inline `style`, so the MutationObserver path doesn't see them.
   */
  private _installAnimateInterceptor(): void {
    const element = this.element;
    if (typeof element.animate !== "function") return;
    const original = element.animate;
    this._origAnimate = original;
    const lens = this;
    element.animate = function patchedAnimate(
      this: HTMLElement,
      ...args: Parameters<HTMLElement["animate"]>
    ): Animation {
      const animation = original.apply(this, args);
      lens._registerWaapiAnimation(animation);
      return animation;
    } as HTMLElement["animate"];
  }

  private _registerWaapiAnimation(animation: Animation): void {
    this._startStyleAnimationTracking();
    let stopped = false;
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      this._stopStyleAnimationTracking();
    };
    animation.finished.then(cleanup, cleanup);
  }

  /** HOT: called every render for every lens; rect only read when dirty, style/radii when dirty. */
  updateMetrics(): void {
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

      if (rect.width <= 0 || rect.height <= 0) {
        this.radiusCss = 0;
        this.radiusGl = 0;
        this.radiusCssCorners = { tl: 0, tr: 0, br: 0, bl: 0 };
        this.radiusGlCorners = { tl: 0, tr: 0, br: 0, bl: 0 };
        this._lastRectW = 0;
        this._lastRectH = 0;
        return;
      }

      const sizeChanged =
        rect.width !== this._lastRectW || rect.height !== this._lastRectH;
      if (sizeChanged) {
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

    const rp = this.rectPx as unknown as DOMRect;
    let rawCorners: CornerRadii = {
      tl: parseCornerRadius(style.borderTopLeftRadius, rp, emBase),
      tr: parseCornerRadius(style.borderTopRightRadius, rp, emBase),
      br: parseCornerRadius(style.borderBottomRightRadius, rp, emBase),
      bl: parseCornerRadius(style.borderBottomLeftRadius, rp, emBase),
    };
    const cornersSum =
      rawCorners.tl + rawCorners.tr + rawCorners.br + rawCorners.bl;
    if (
      cornersSum <= 0 &&
      style.borderRadius &&
      style.borderRadius !== "0px" &&
      style.borderRadius !== "none"
    ) {
      const fallback = parseCornerRadius(style.borderRadius.trim(), rp, emBase);
      if (Number.isFinite(fallback) && fallback > 0) {
        rawCorners = { tl: fallback, tr: fallback, br: fallback, bl: fallback };
      }
    }
    const corners = normalizeCornerRadii(rawCorners, rp.width, rp.height);
    this.radiusCssCorners = corners;
    this.radiusCss = Math.max(corners.tl, corners.tr, corners.br, corners.bl);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.radiusGl = this.radiusCss * dpr;
    this.radiusGlCorners = {
      tl: corners.tl * dpr,
      tr: corners.tr * dpr,
      br: corners.br * dpr,
      bl: corners.bl * dpr,
    };
  }

  /**
   * Resize the public canvas to match the lens rect plus shadowPad on
   * every side. The CSS layout is fixed (`inset: -shadowPad`), but the
   * backing-store dimensions (`canvas.width` / `canvas.height`) are kept
   * in sync with `dpr` and the current rect size so refraction stays
   * sharp on HiDPI displays and animations.
   */
  _syncPublicCanvasSize(): void {
    const rect = this.rectPx;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      if (this.publicCanvasW !== 0 || this.publicCanvasH !== 0) {
        this.publicCanvas.width = 0;
        this.publicCanvas.height = 0;
        this.publicCanvasW = 0;
        this.publicCanvasH = 0;
      }
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const shadowPad = this.computeShadowPad();
    const cssWidth = rect.width + 2 * shadowPad;
    const cssHeight = rect.height + 2 * shadowPad;
    const backingWidth = Math.max(1, Math.ceil(cssWidth * dpr));
    const backingHeight = Math.max(1, Math.ceil(cssHeight * dpr));

    if (shadowPad !== this.publicCanvasPad) {
      this.publicCanvas.style.left = `${-shadowPad}px`;
      this.publicCanvas.style.top = `${-shadowPad}px`;
      this.publicCanvasPad = shadowPad;
    }
    this.publicCanvas.style.width = `${cssWidth}px`;
    this.publicCanvas.style.height = `${cssHeight}px`;
    if (
      this.publicCanvasW !== backingWidth ||
      this.publicCanvasH !== backingHeight
    ) {
      this.publicCanvas.width = backingWidth;
      this.publicCanvas.height = backingHeight;
      this.publicCanvasW = backingWidth;
      this.publicCanvasH = backingHeight;
    }
  }

  /** CSS-pixel padding around the lens rect needed to host the box-shadow. */
  computeShadowPad(): number {
    const shadow = this.shadowParams;
    if (!shadow || shadow.color.a <= 0) return 0;
    return (
      Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) +
      shadow.blur +
      Math.abs(shadow.spread) +
      5
    );
  }

  /** Call when CSS (e.g. border-radius) may have changed so style metrics are recalc'd next frame. */
  invalidateStyleMetrics(): void {
    this._styleMetricsDirty = true;
    this._rectDirty = true;
  }

  /**
   * Keep DOM stacking order in sync with `stackingIndex` so per-lens public
   * canvases layer exactly like the renderer's group ordering.
   *
   * Why this is needed:
   * - With per-lens canvases, final visible order is CSS stacking order of
   *   lens elements.
   * - Renderer cascade order is based on `stackingIndex`.
   * - If those two differ, you can get a physically correct cascade in the
   *   texture pipeline but a visually wrong overlap (upper lens appears below).
   */
  private _syncStackingZIndex(): void {
    const si = this.options.stackingIndex;
    if (si !== undefined) {
      if (!this._stackingZApplied) {
        this._savedZIndexInline = this.element.style.zIndex;
        this._stackingZApplied = true;
      }
      this.element.style.zIndex = String(si);
      return;
    }

    if (!this._stackingZApplied) return;
    if (this._savedZIndexInline === "") {
      this.element.style.removeProperty("z-index");
    } else {
      this.element.style.zIndex = this._savedZIndexInline;
    }
    this._stackingZApplied = false;
    this._savedZIndexInline = "";
  }

  /**
   * Read the user's inline `background-color` / `background` from the
   * element and store them in the shadow fields, but only when the
   * declarations are *not* already our own `!important` overrides
   * (otherwise we'd capture our sentinel and lose the real value).
   */
  private _captureUserInlineBg(): void {
    const style = this.element.style;
    if (style.getPropertyPriority("background-color") !== "important") {
      this._userBgColor = style.getPropertyValue("background-color");
    }
    if (style.getPropertyPriority("background") !== "important") {
      this._userBg = style.getPropertyValue("background");
    }
  }

  /**
   * Install (or re-install) our `transparent !important` override on
   * `background-color` and `background`. The `MutationObserver` filters
   * net-zero attribute changes via `oldValue` comparison, so this
   * function doesn't need to coordinate with it explicitly.
   */
  private _applyOverride(): void {
    const style = this.element.style;
    style.setProperty("background-color", "transparent", "important");
    style.setProperty("background", "transparent", "important");
  }

  /**
   * Called by `MutationObserver` when a foreign mutation hit the element's
   * `style` attribute. If the user's non-important inline `background-color`
   * (or `background`) is back in CSSOM (because React re-rendered, or
   * `Animation.commitStyles()` baked a value, etc.), capture it into the
   * shadow store and re-apply our override on top so the cascade resolves
   * to `transparent` again.
   */
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

    if (needReapply) this._applyOverride();
  }

  /**
   * Re-read the lens's "intended" `background-color` from the cascade and
   * sync it into `options.tint`. The lens element carries a
   * `transparent !important` override on `background-color` /
   * `background`, which would make `getComputedStyle` always return
   * `transparent`. To reach the underlying cascade we do a
   * **strip-and-restore peek**:
   *
   *   1. Remove our override.
   *   2. Re-install the user's last-known non-important inline value
   *      (`_userBgColor` / `_userBg`) so the cascade contains it again.
   *   3. Read `getComputedStyle().backgroundColor` — this resolves the
   *      cascade including any active CSS transition mid-value or WAAPI
   *      animation (used by framer-motion v11+ for `backgroundColor`,
   *      since WAAPI's Animation origin only beats non-`!important`
   *      Author origin).
   *   4. Strip the inline values we just re-installed and re-apply our
   *      override.
   *
   * All four steps are synchronous (no paint between them) so the user
   * never sees the lens uncovered. The whole sequence ends with the
   * element's `style` attribute string identical to the pre-peek state,
   * which lets the `MutationObserver`'s `oldValue` net-change check
   * correctly classify it as "no real mutation" and skip both
   * reconciliation and invalidation.
   */
  private _updateTintFromCss(): void {
    const style = this.element.style;
    const hasOurOverride =
      style.getPropertyPriority("background-color") === "important" ||
      style.getPropertyPriority("background") === "important";

    let bgCol: string;
    if (hasOurOverride) {
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

  getEffectiveZ(): number {
    return this.options.stackingIndex ?? 0;
  }

  _activate(): void {
    this._triggerInit();
  }

  private _triggerInit(): void {
    if (this._initCalled) return;
    this._initCalled = true;
    if (this.options.on && this.options.on.init) {
      this.options.on.init(this);
    }
  }

  destroy(): void {
    this._sizeObs?.disconnect();
    this._attrObserver?.disconnect();
    this._attrObserver = null;
    this._contentObserver?.disconnect();
    this._contentObserver = null;
    this._contentCapture = null;
    this._activeStyleAnimations = 0;
    if (this._styleAnimationRaf !== null) {
      cancelAnimationFrame(this._styleAnimationRaf);
      this._styleAnimationRaf = null;
    }
    if (this._boundStartStyleAnimation) {
      this.element.removeEventListener(
        "transitionrun",
        this._boundStartStyleAnimation,
      );
      this.element.removeEventListener(
        "animationstart",
        this._boundStartStyleAnimation,
      );
    }
    if (this._boundStopStyleAnimation) {
      this.element.removeEventListener(
        "transitionend",
        this._boundStopStyleAnimation,
      );
      this.element.removeEventListener(
        "transitioncancel",
        this._boundStopStyleAnimation,
      );
      this.element.removeEventListener(
        "animationend",
        this._boundStopStyleAnimation,
      );
      this.element.removeEventListener(
        "animationcancel",
        this._boundStopStyleAnimation,
      );
    }

    if (this._origAnimate) {
      this.element.animate = this._origAnimate;
      this._origAnimate = null;
    }

    this.publicCanvas.remove();
    this.element.removeAttribute(LENS_DOM_ATTR);
    this.element.style.removeProperty("backdrop-filter");
    this.element.style.removeProperty("-webkit-backdrop-filter");
    this.element.style.removeProperty("background-image");
    this.element.style.removeProperty("box-shadow");
    if (this._stackingZApplied) {
      if (this._savedZIndexInline === "") {
        this.element.style.removeProperty("z-index");
      } else {
        this.element.style.zIndex = this._savedZIndexInline;
      }
      this._stackingZApplied = false;
      this._savedZIndexInline = "";
    }
    if (this._isolationApplied) {
      this.element.style.removeProperty("isolation");
      this._isolationApplied = false;
    }

    // Tear down our `transparent !important` override and restore
    // whatever non-important inline value the user originally had — so
    // the surrounding React/HTML keeps owning the bg colour after we
    // detach from the element.
    const style = this.element.style;
    if (style.getPropertyPriority("background-color") === "important") {
      style.removeProperty("background-color");
    }
    if (style.getPropertyPriority("background") === "important") {
      style.removeProperty("background");
    }
    if (this._userBgColor) {
      style.setProperty("background-color", this._userBgColor);
    }
    if (this._userBg) {
      style.setProperty("background", this._userBg);
    }

    this.renderer.removeLens(this);
  }
}
