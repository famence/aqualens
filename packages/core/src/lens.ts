import {
  parseBgColorToRgba,
  parseBoxShadow,
  type ShadowParams,
} from "./utils";
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

  private _initCalled = false;
  private _bgColorComponents: {
    r: number;
    g: number;
    b: number;
    a: number;
  } | null = null;

  private _sizeObs: ResizeObserver | null = null;

  _rectDirty = true;

  /** When true, next updateMetrics() will re-read getComputedStyle and recalc corner radii. */
  private _styleMetricsDirty = true;
  private _lastRectW = 0;
  private _lastRectH = 0;
  private _boundInvalidateStyle?: () => void;
  private _attrObserver: MutationObserver | null = null;
  private _styleAnimationRaf: number | null = null;
  private _activeStyleAnimations = 0;
  private _boundStartStyleAnimation?: EventListener;
  private _boundStopStyleAnimation?: EventListener;

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

    const bgCol = window.getComputedStyle(this.element).backgroundColor;
    const parsed = parseBgColorToRgba(bgCol);
    if (parsed) {
      const { r, g, b, a } = parsed;
      this._bgColorComponents = { r, g, b, a };
      this.options.tint = { r, g, b, a };
    } else {
      this._bgColorComponents = null;
      this.options.tint = DEFAULT_TINT;
    }
    const boxShadow = window.getComputedStyle(this.element).boxShadow;
    this.shadowParams = parseBoxShadow(boxShadow);
    this.element.style.setProperty("box-shadow", "none", "important");

    this.element.style.setProperty(
      "background-color",
      "transparent",
      "important",
    );

    this.element.style.setProperty("backdrop-filter", "none", "important");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.element.style as any).setProperty(
      "-webkit-backdrop-filter",
      "none",
      "important",
    );
    this.element.style.setProperty("background-image", "none", "important");
    this.element.style.setProperty("background", "transparent", "important");

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
    this._boundStartStyleAnimation = () => {
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
    };
    this._boundStopStyleAnimation = () => {
      if (this._activeStyleAnimations > 0) {
        this._activeStyleAnimations -= 1;
      }
      if (this._activeStyleAnimations > 0) return;
      if (this._styleAnimationRaf !== null) {
        cancelAnimationFrame(this._styleAnimationRaf);
        this._styleAnimationRaf = null;
      }
      this._boundInvalidateStyle?.();
    };
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
        for (const mutation of mutations) {
          if (
            mutation.type === "attributes" &&
            (mutation.attributeName === "style" ||
              mutation.attributeName === "class")
          ) {
            this._boundInvalidateStyle?.();
            break;
          }
        }
      });
      this._attrObserver.observe(this.element, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
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

    this.element.style.removeProperty("backdrop-filter");
    this.element.style.removeProperty("-webkit-backdrop-filter");
    this.element.style.removeProperty("background-image");
    this.element.style.removeProperty("background");
    this.element.style.removeProperty("box-shadow");
    this.element.style.removeProperty("background-color");

    if (this._bgColorComponents) {
      const { r, g, b, a } = this._bgColorComponents;
      this.element.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    this.renderer.removeLens(this);
  }
}
