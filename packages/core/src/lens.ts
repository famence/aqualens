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

export type TintMode = "webgl" | "css";

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
   * How the glass tint is rendered for this lens:
   * - `webgl` — tint sampled from CSS, applied via the WebGL shader. The
   *   lens element gets a `background-color: transparent !important`
   *   override (and same for `background`) so:
   *     1. snapshots taken of the page see *behind* the lens, not the
   *        lens's own bg colour (otherwise refraction would sample the
   *        lens's bg, producing garbage);
   *     2. the lens's bg never bleeds through the canvas's anti-aliased
   *        edges (where canvas alpha drops below 1).
   *   The user's intended bg-color is tracked in a shadow store
   *   (`_userBgColor`) and used both as the WebGL tint colour and to
   *   reconstruct the cascade during `getComputedStyle` peeks.
   * - `css` — the lens keeps its native CSS `background-color`; the WebGL
   *   shader uses an alpha-zero tint so it doesn't double-apply. This
   *   avoids GPU work for tint and lets CSS `background-color` transitions
   *   run naturally. The renderer picks `css` when the lens has no peer
   *   with the same `stackingIndex` and the canvas is not z-indexed above
   *   the page (i.e. cascade mode is inactive).
   */
  _tintMode: TintMode = "webgl";
  private _tintModeApplied = false;
  private _zIndexBumped = false;
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

    if (
      !this.element.style.position ||
      this.element.style.position === "static"
    ) {
      this.element.style.position = "relative";
    }

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

    // Capture the user's inline background-color *before* `_setTintMode`
    // installs our `transparent !important` override (which would erase
    // the user's value from CSSOM).
    this._captureUserInlineBg();

    // Default to WebGL tint at construction; the renderer reconciles modes
    // before the first render based on stacking-group membership.
    this._setTintMode("webgl");

    this.updateMetrics();

    if (typeof ResizeObserver !== "undefined") {
      this._sizeObs = new ResizeObserver(() => {
        this.invalidateStyleMetrics();
        this.updateMetrics();
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
      this._contentObserver = new MutationObserver(() => {
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

  /** Call when CSS (e.g. border-radius) may have changed so style metrics are recalc'd next frame. */
  invalidateStyleMetrics(): void {
    this._styleMetricsDirty = true;
    this._rectDirty = true;
  }

  /**
   * Switch how this lens applies tint. Called by the renderer when stacking
   * group membership (or cascade activation) changes. No-op when the mode is
   * already set.
   */
  _setTintMode(mode: TintMode): void {
    if (this._tintModeApplied && this._tintMode === mode) return;
    this._tintMode = mode;
    this._tintModeApplied = true;
    if (mode === "css") {
      this._enterCssTint();
    } else {
      this._enterWebglTint();
    }
  }

  /**
   * In CSS-tint mode the lens element keeps its own `background-color`, so
   * the WebGL shader must not paint tint (otherwise the lens is tinted
   * twice). We also lift the element above the WebGL canvas so the CSS
   * background is actually visible — by default the canvas is appended
   * last to `<body>` and would otherwise paint over the lens.
   *
   * To restore the user's bg-color: remove our `!important` override and
   * re-install the user's tracked inline value (if we had captured one).
   * Class-based bg colours flow through the cascade naturally once our
   * override is gone, so we don't need to touch them.
   */
  private _enterCssTint(): void {
    this._removeOverrideRestoreUserInline();
    this.options.tint = DEFAULT_TINT;
    this._bumpZIndex();
  }

  /**
   * In WebGL-tint mode we want a `transparent !important` override on the
   * lens element's `background-color` / `background` so the page snapshot
   * (used as the refraction source) sees *behind* the lens, and so the
   * lens's own bg never bleeds through the WebGL canvas's anti-aliased
   * edges where alpha drops below 1.
   *
   * The override would normally clobber the user's React inline
   * `style={{ backgroundColor }}` in CSSOM (one declaration per property),
   * so before installing it we make sure the user's intended value is
   * captured in `_userBgColor`. Subsequent React re-renders or
   * `Animation.commitStyles()` writes that re-introduce a non-important
   * inline value are caught by `MutationObserver` → `_reconcileBgOverride`,
   * which keeps the shadow up to date and re-applies our override.
   *
   * `background-image: none !important` is applied unconditionally (in the
   * constructor) to suppress gradients — we only honour solid
   * background-colours for tint.
   */
  private _enterWebglTint(): void {
    this._restoreZIndex();
    this._captureUserInlineBg();
    this._applyOverride();
    this._updateTintFromCss();
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
   * Remove our `!important` override and restore whatever non-important
   * inline value the user had (tracked in `_userBgColor` / `_userBg`).
   * If the user never had an inline value, the cascade flows naturally
   * (e.g. the Tailwind class wins).
   */
  private _removeOverrideRestoreUserInline(): void {
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
    if (this._tintMode !== "webgl") return;
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
   * Lift the lens above the WebGL canvas via inline `z-index: 1`. We only do
   * this when computed `z-index` is `auto` (otherwise the user has chosen a
   * stacking order on purpose and we honour it; documented behaviour is that
   * an explicit z-index < 1 may hide the CSS tint behind the canvas).
   */
  private _bumpZIndex(): void {
    if (this._zIndexBumped) return;
    const computedZ = window.getComputedStyle(this.element).zIndex;
    if (computedZ !== "auto") return;
    this._savedZIndexInline = this.element.style.zIndex;
    this.element.style.zIndex = "1";
    this._zIndexBumped = true;
  }

  private _restoreZIndex(): void {
    if (!this._zIndexBumped) return;
    if (this._savedZIndexInline === "") {
      this.element.style.removeProperty("z-index");
    } else {
      this.element.style.zIndex = this._savedZIndexInline;
    }
    this._zIndexBumped = false;
    this._savedZIndexInline = "";
  }

  /**
   * Re-read the lens's "intended" `background-color` from the cascade and
   * sync it into `options.tint`. In webgl mode the lens element carries a
   * `transparent !important` override (see `_enterWebglTint`), which would
   * make `getComputedStyle` always return `transparent`. To reach the
   * underlying cascade we do a **strip-and-restore peek**:
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
   *
   * In `css` tint mode this is a no-op that keeps the shader tint
   * transparent — the lens element's own CSS `background-color` provides
   * the tint visually, so the WebGL shader must not double-apply.
   */
  private _updateTintFromCss(): void {
    if (this._tintMode === "css") {
      this.options.tint = DEFAULT_TINT;
      return;
    }

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
    this.renderer.canvas.style.opacity = "1";
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

    this._restoreZIndex();
    this.element.style.removeProperty("backdrop-filter");
    this.element.style.removeProperty("-webkit-backdrop-filter");
    this.element.style.removeProperty("background-image");
    this.element.style.removeProperty("box-shadow");

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
