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
   * The public `<canvas>` element decorating this lens. WebGL renders
   * into the renderer's offscreen private canvas and the relevant region
   * is then copied here via `drawImage`.
   *
   * **Crucial layout detail** — this canvas does NOT live inside
   * `lens.element`. Instead it sits in a per-stackingIndex host container
   * (`<div data-aqualens-host>`) that is `position: fixed; inset: 0` on
   * `document.body`. The canvas itself uses `position: absolute` with
   * top/left/width/height in **viewport CSS pixels**, fully independent
   * of the lens host element's own positioning, transform or CSS
   * animations.
   *
   * This decoupling fixes a class of merge-mode artifacts ("seams" /
   * "doubled silhouettes") that occurred whenever lenses in the same
   * merged group were animated/positioned independently between render
   * frames: when the canvas was a child of the lens, parent transforms
   * (scroll-driven animations, `transform: translate(-50%, -50%)` etc.)
   * would shift the canvas relative to the rendered blob, while sibling
   * canvases remained in place. Hosting in a fixed container makes
   * canvas screen position depend only on what we explicitly set during
   * `_syncPublicCanvasForRegion`.
   *
   * Stacking semantics (so lens DOM children still paint above the glass
   * effect): each host is itself at body level with `z-index =
   * stackingIndex`, and each lens host element gets the same
   * `stackingIndex` (via `_syncStackingZIndex`). At equal z-index, tree
   * order resolves the layering — and we deliberately keep the host
   * appended BEFORE lens elements through `addLens` ordering guarantees,
   * which puts the host (and its canvases) below the lens stacking
   * context. For implicit (no stackingIndex) lenses both the host and
   * the lens stay at default z-index, so they participate in the
   * surrounding flow stacking via tree order alone.
   */
  publicCanvas: HTMLCanvasElement;
  publicCtx: CanvasRenderingContext2D;
  /** Stacking key this canvas was last attached to (used to migrate hosts). */
  private _canvasHostStackingIndex: number | undefined;
  /**
   * Whether we installed `isolation: isolate` on the lens host element.
   * The canvas itself no longer needs it (it lives in the renderer's
   * fixed-position host container, see `publicCanvas` above), but the
   * startup-fallback DOM does: the fallback glare uses an extreme
   * `z-index` to stay above all lens content, which would otherwise leak
   * past the lens and overlay neighbouring stacking contexts.
   */
  private _isolationApplied = false;
  /** Public canvas backing-store dimensions, in device pixels. */
  publicCanvasW = 0;
  publicCanvasH = 0;
  /**
   * CSS-pixel viewport-space top-left of the public canvas. Drives the
   * canvas's inline `left` / `top` styles directly: because the host
   * container is a `position: fixed; inset: 0` div, an `absolute`
   * positioned canvas inside it places its origin at the host's
   * top-left, which equals the visual viewport's top-left.
   */
  publicCanvasViewportLeft = 0;
  publicCanvasViewportTop = 0;
  /** CSS-pixel size the canvas currently occupies. */
  publicCanvasCssWidth = 0;
  publicCanvasCssHeight = 0;
  /** Whether we overrode element `z-index` from `stackingIndex`. */
  private _stackingZApplied = false;
  /** Original inline z-index before we started syncing to stackingIndex. */
  private _savedZIndexInline = "";
  /**
   * Cached value of `element.style.zIndex` we last wrote, so the per-frame
   * `_syncStackingZIndex` call doesn't keep poking the inline style on
   * every render (which forces extra style recalcs during scroll-heavy
   * sequences). `null` means "no override currently applied".
   */
  private _appliedZIndex: string | null = null;

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
  _startupFallbackActive = false;
  _startupFallbackTint: HTMLDivElement | null = null;
  _startupFallbackGlare: HTMLDivElement | null = null;
  _startupPrevCanvasVisibility = "";

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

    // Build the per-lens public canvas. The canvas is `position: absolute`
    // inside a viewport-fixed host container (see `publicCanvas` doc
    // comment for the rationale): top/left/width/height in inline style
    // are interpreted in CSS pixels of the visual viewport.
    //
    // Stacking-context handling: with the canvas no longer inside the
    // lens DOM, the lens itself doesn't need `isolation: isolate` for
    // canvas-vs-content layering — that's handled at body level via
    // matching `z-index` between host and lens (see `_syncStackingZIndex`).
    this.publicCanvas = document.createElement("canvas");
    this.publicCanvas.setAttribute("data-aqualens-canvas", "");
    this.publicCanvas.setAttribute("data-liquid-ignore", "");
    this.publicCanvas.style.cssText =
      "position:absolute;pointer-events:none;left:0;top:0;width:0;height:0;";
    const ctx = this.publicCanvas.getContext("2d");
    if (!ctx) {
      throw new Error("Aqualens: 2D canvas context unavailable");
    }
    this.publicCtx = ctx;
    this._canvasHostStackingIndex = this.options.stackingIndex;
    const host = this.renderer._acquireCanvasHost(
      this._canvasHostStackingIndex,
    );
    host.appendChild(this.publicCanvas);

    // Sync host z-index AFTER the canvas DOM node exists: the migration
    // path inside `_syncStackingZIndex` may try to re-parent the canvas,
    // which would throw on an undefined publicCanvas if called earlier
    // in the constructor.
    this._syncStackingZIndex();

    // Force a stacking context on the lens DOM so the startup-fallback
    // glare's `z-index: 2147483647` can't escape to ancestor stacking and
    // overlay neighbouring lenses. The public canvas itself doesn't need
    // this any more (it's hosted outside the lens DOM), but the fallback
    // overlay nodes are still children of `lens.element`.
    if (!this.element.style.isolation) {
      this.element.style.isolation = "isolate";
      this._isolationApplied = true;
    }

    this.updateMetrics();
    this._syncPublicCanvasSize();
    this._enableStartupFallback();

    if (typeof ResizeObserver !== "undefined") {
      this._sizeObs = new ResizeObserver(() => {
        // Just invalidate metrics and ask for a frame. We deliberately
        // do NOT sync the public canvas here: when this lens is part
        // of a merged group its canvas is sized to the group's union
        // bbox (larger than the lens itself), and `_syncPublicCanvasSize`
        // would clamp it back to the single-lens region, clearing the
        // backing buffer. Because the actual render is scheduled on the
        // next animation frame while the browser paints right after
        // the observer callback, that intermediate "shrunken + empty"
        // state is visible as a one-frame flicker. Letting the renderer
        // pick up the new rect during its own pass keeps the canvas at
        // its previous (still-mostly-correct) dimensions until the
        // proper region has been applied AND the new pixels drawn.
        this.invalidateStyleMetrics();
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
   * Resize and reposition the public canvas to match a given viewport
   * region (in CSS pixels relative to the visual viewport's top-left).
   * Because the canvas lives in a `position: fixed; inset: 0` host
   * container and is itself `position: absolute`, the region's
   * `left/top` map directly to the canvas's inline `left/top` styles —
   * no parent-relative offset arithmetic is needed.
   *
   * Callers:
   *  - single-lens path: lens rect ± shadowPad (see {@link _syncPublicCanvasSize});
   *  - merged-group path: the group's padded union bbox is applied to
   *    one "primary" lens canvas; all secondary lenses in the group are
   *    zeroed out via this same method (region 0,0,0,0).
   */
  _syncPublicCanvasForRegion(
    regionLeft: number,
    regionTop: number,
    regionWidth: number,
    regionHeight: number,
  ): void {
    const rect = this.rectPx;
    if (
      !rect ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      regionWidth <= 0 ||
      regionHeight <= 0
    ) {
      if (this.publicCanvasW !== 0 || this.publicCanvasH !== 0) {
        this.publicCanvas.width = 0;
        this.publicCanvas.height = 0;
        this.publicCanvasW = 0;
        this.publicCanvasH = 0;
      }
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const backingWidth = Math.max(1, Math.ceil(regionWidth * dpr));
    const backingHeight = Math.max(1, Math.ceil(regionHeight * dpr));

    if (regionLeft !== this.publicCanvasViewportLeft) {
      this.publicCanvas.style.left = `${regionLeft}px`;
      this.publicCanvasViewportLeft = regionLeft;
    }
    if (regionTop !== this.publicCanvasViewportTop) {
      this.publicCanvas.style.top = `${regionTop}px`;
      this.publicCanvasViewportTop = regionTop;
    }
    if (regionWidth !== this.publicCanvasCssWidth) {
      this.publicCanvas.style.width = `${regionWidth}px`;
      this.publicCanvasCssWidth = regionWidth;
    }
    if (regionHeight !== this.publicCanvasCssHeight) {
      this.publicCanvas.style.height = `${regionHeight}px`;
      this.publicCanvasCssHeight = regionHeight;
    }
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

  /**
   * Single-lens convenience: size the canvas to lens rect + shadowPad on
   * every side. Used when the lens is rendered alone (no merged group).
   */
  _syncPublicCanvasSize(): void {
    const rect = this.rectPx;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      this._syncPublicCanvasForRegion(0, 0, 0, 0);
      return;
    }
    const shadowPad = this.computeShadowPad();
    this._syncPublicCanvasForRegion(
      rect.left - shadowPad,
      rect.top - shadowPad,
      rect.width + 2 * shadowPad,
      rect.height + 2 * shadowPad,
    );
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
   * Keep three things in sync with the lens's current `stackingIndex`:
   *
   *   1. The lens DOM element's CSS `z-index` (so cascade ordering with
   *      surrounding non-lens DOM works).
   *   2. The CSS `z-index` of the lens's host container (so canvases of
   *      different stacking groups layer correctly at body level).
   *   3. The host parent the canvas lives under (the renderer maintains
   *      one host per unique stacking key — see
   *      `_acquireCanvasHost`/`_releaseCanvasHost`). When stackingIndex
   *      changes (e.g. a `mergeLens` toggle in the demo), we migrate the
   *      canvas to the host of the new key and release the old host's
   *      refcount so it can be torn down if no canvases reference it.
   */
  private _syncStackingZIndex(): void {
    const si = this.options.stackingIndex;
    if (si !== undefined) {
      if (!this._stackingZApplied) {
        this._savedZIndexInline = this.element.style.zIndex;
        this._stackingZApplied = true;
      }
      // Host uses `si * 2`, lens DOM uses `si * 2 + 1` so lens content
      // always paints above glass canvas for the same stacking group.
      const desired = String(si * 2 + 1);
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

    // Migrate the canvas to the host that matches the current stacking
    // key. This is the second half of stackingIndex syncing — without it
    // a lens that switches groups (e.g. `mergeLens` toggled at runtime)
    // would keep its old host's z-index and either lose cascade ordering
    // or remain merged with the wrong group.
    if (si !== this._canvasHostStackingIndex) {
      const previousIndex = this._canvasHostStackingIndex;
      const nextHost = this.renderer._acquireCanvasHost(si);
      // Move the existing canvas DOM node to the new host before
      // releasing the old host's refcount: that way we never end up in
      // a transient state where the canvas is detached, which would
      // make `drawImage` paths see a 0×0 backing buffer.
      nextHost.appendChild(this.publicCanvas);
      this._canvasHostStackingIndex = si;
      this.renderer._releaseCanvasHost(previousIndex);
    }
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

  _enableStartupFallback(): void {
    if (this._startupFallbackActive) return;
    this._startupFallbackActive = true;
    this._startupPrevCanvasVisibility = this.publicCanvas.style.visibility;
    this.publicCanvas.style.visibility = "hidden";

    const CSS_BLUR_SCALE = 1 / 6;
    const parts: string[] = [];
    if (this.options.blurRadius > 0) {
      parts.push(`blur(${(this.options.blurRadius * CSS_BLUR_SCALE).toFixed(1)}px)`);
    }
    parts.push("saturate(1.2)", "brightness(1.05)");
    const backdropFilter = parts.join(" ");
    this.element.style.setProperty("backdrop-filter", backdropFilter, "important");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.element.style as any).setProperty(
      "-webkit-backdrop-filter",
      backdropFilter,
      "important",
    );

    const tint = document.createElement("div");
    tint.setAttribute("data-liquid-startup-fallback", "");
    tint.style.cssText =
      "position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;";
    const tintColor = this.options.tint;
    tint.style.background =
      tintColor.a > 0
        ? `rgba(${tintColor.r},${tintColor.g},${tintColor.b},${tintColor.a})`
        : "transparent";
    this.element.appendChild(tint);
    this._startupFallbackTint = tint;

    const glare = document.createElement("div");
    glare.setAttribute("data-liquid-startup-fallback", "");
    glare.style.cssText =
      "position:absolute;inset:0;z-index:2147483647;pointer-events:none;border-radius:inherit;overflow:hidden;";
    const glareOptions = this.options.glare;
    const factor = glareOptions.factor / 100;
    const oppFactor = glareOptions.oppositeFactor / 100;
    const hardness = glareOptions.hardness / 100;
    const convergence = glareOptions.convergence / 100;
    const edgeWidth = Math.max(2, 8 * (1 - convergence));
    const primaryAlpha = Math.min(0.35, factor * 0.35);
    const oppositeAlpha = Math.min(0.2, oppFactor * primaryAlpha);
    const fadeEnd = Math.min(20, edgeWidth + 6 * (1 - hardness));
    glare.style.background = [
      `linear-gradient(${glareOptions.angle}deg,`,
      `rgba(255,255,255,${primaryAlpha.toFixed(3)}) 0%,`,
      `rgba(255,255,255,0) ${fadeEnd.toFixed(1)}%,`,
      `transparent 30%,`,
      `transparent 70%,`,
      `rgba(255,255,255,0) ${(100 - fadeEnd).toFixed(1)}%,`,
      `rgba(255,255,255,${oppositeAlpha.toFixed(3)}) 100%)`,
    ].join("");
    glare.style.mixBlendMode = "overlay";
    this.element.appendChild(glare);
    this._startupFallbackGlare = glare;
  }

  _disableStartupFallback(): void {
    if (!this._startupFallbackActive) return;
    this._startupFallbackActive = false;
    this._startupFallbackTint?.remove();
    this._startupFallbackGlare?.remove();
    this._startupFallbackTint = null;
    this._startupFallbackGlare = null;
    this.publicCanvas.style.visibility = this._startupPrevCanvasVisibility;
    this.element.style.setProperty("backdrop-filter", "none", "important");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.element.style as any).setProperty(
      "-webkit-backdrop-filter",
      "none",
      "important",
    );
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
    this._disableStartupFallback();
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
    this.renderer._releaseCanvasHost(this._canvasHostStackingIndex);
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
