import { parseBgColorToRgba } from "./utils";
import { parseCornerRadius, normalizeCornerRadii, type CornerRadii } from "./css-parser";
import { generateDisplacementMap } from "./svg-displacement";
import {
  DEFAULT_TINT,
  type AqualensConfig,
  type AqualensLensInstance,
  type DOMRectLike,
  type TintColor,
} from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_CSS_BLUR_SCALE = 1 / 4;

let nextFilterId = 0;

export class SvgRenderer {
  private _lenses: SvgLens[] = [];
  private _svgDefs: SVGDefsElement | null = null;
  private _svgRoot: SVGSVGElement | null = null;
  private _destroyed = false;

  constructor() {
    this._ensureSvgDefs();
  }

  private _ensureSvgDefs(): void {
    if (this._svgRoot) return;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
    svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(defs);
    document.body.appendChild(svg);
    this._svgRoot = svg;
    this._svgDefs = defs;
  }

  get svgDefs(): SVGDefsElement | null {
    return this._svgDefs;
  }

  addLens(element: HTMLElement, options: AqualensConfig): SvgLens {
    this._ensureSvgDefs();
    const lens = new SvgLens(element, options, this);
    this._lenses.push(lens);
    return lens;
  }

  removeLens(lens: SvgLens): void {
    const index = this._lenses.indexOf(lens);
    if (index !== -1) this._lenses.splice(index, 1);
  }

  requestRender(): void {
    for (const lens of this._lenses) lens._syncStyles();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const lens of this._lenses) lens.destroy();
    this._lenses.length = 0;
    this._svgRoot?.remove();
    this._svgRoot = null;
    this._svgDefs = null;
  }
}

export class SvgLens implements AqualensLensInstance {
  element: HTMLElement;
  options: AqualensConfig;
  rectPx: DOMRectLike | null = null;
  radiusGl = 0;
  radiusCss = 0;
  radiusGlCorners = { tl: 0, tr: 0, br: 0, bl: 0 };
  radiusCssCorners = { tl: 0, tr: 0, br: 0, bl: 0 };

  private _renderer: SvgRenderer;
  private _filterId: string;
  private _filterElement: SVGFilterElement | null = null;
  private _refractionLayer: HTMLDivElement | null = null;
  private _tintElement: HTMLDivElement | null = null;
  private _glareElement: HTMLDivElement | null = null;
  private _chromaticElement: HTMLDivElement | null = null;
  private _specularElement: HTMLDivElement | null = null;
  private _bgColorComponents: TintColor | null = null;
  private _origIsolation: string;
  private _origOverflow: string;
  private _origPosition: string;
  private _resizeObserver: ResizeObserver | null = null;
  private _lastWidth = 0;
  private _lastHeight = 0;
  private _destroyed = false;

  constructor(element: HTMLElement, options: AqualensConfig, renderer: SvgRenderer) {
    this.element = element;
    this._renderer = renderer;
    this._filterId = `aqualens-svg-${nextFilterId++}`;

    const bgCol = window.getComputedStyle(element).backgroundColor;
    const parsed = parseBgColorToRgba(bgCol);
    if (parsed) {
      const { r, g, b, a } = parsed;
      this._bgColorComponents = { r, g, b, a };
      this.options = { ...options, tint: { r, g, b, a } };
    } else {
      this._bgColorComponents = null;
      this.options = { ...options, tint: DEFAULT_TINT };
    }

    this._origIsolation = element.style.isolation || "";
    this._origOverflow = element.style.overflow || "";
    this._origPosition = element.style.position || "";

    element.style.setProperty("background-color", "transparent", "important");
    element.style.setProperty("background-image", "none", "important");
    element.style.setProperty("background", "transparent", "important");

    const computed = window.getComputedStyle(element);
    if (computed.position === "static") {
      element.style.position = "relative";
    }
    element.style.isolation = "isolate";
    if (options.blurEdge) element.style.overflow = "hidden";

    this._buildSvgFilter();
    this._buildOverlays();
    this._setupResizeObserver();
    this._fireInit();
  }

  updateMetrics(): void {
    const rect = this.element.getBoundingClientRect();
    this.rectPx = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  _syncStyles(): void {
    if (this._destroyed) return;
    this._applyRefractionStyles();
    this._applyTint();
    this._applyGlare();
    this._applyFresnel();
    this._applyChromatic();
    this._applySpecular();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    this._resizeObserver?.disconnect();
    this._resizeObserver = null;

    this._refractionLayer?.remove();
    this._tintElement?.remove();
    this._glareElement?.remove();
    this._chromaticElement?.remove();
    this._specularElement?.remove();
    this._filterElement?.remove();

    this.element.style.isolation = this._origIsolation;
    this.element.style.overflow = this._origOverflow;
    this.element.style.position = this._origPosition;

    this.element.style.removeProperty("background-image");
    this.element.style.removeProperty("background");
    this.element.style.removeProperty("background-color");

    if (this._bgColorComponents) {
      const { r, g, b, a } = this._bgColorComponents;
      this.element.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    this._renderer.removeLens(this);
  }

  private _getCornerRadii(): CornerRadii {
    const style = window.getComputedStyle(this.element);
    const rect = this.element.getBoundingClientRect();
    const emBase = parseFloat(style.fontSize) || 16;

    const radii: CornerRadii = {
      tl: parseCornerRadius(style.borderTopLeftRadius, rect as DOMRect, emBase),
      tr: parseCornerRadius(style.borderTopRightRadius, rect as DOMRect, emBase),
      br: parseCornerRadius(style.borderBottomRightRadius, rect as DOMRect, emBase),
      bl: parseCornerRadius(style.borderBottomLeftRadius, rect as DOMRect, emBase),
    };

    return normalizeCornerRadii(radii, rect.width, rect.height);
  }

  /**
   * Build SVG filter with displacement map + blur + saturation in one pipeline.
   * When used as `backdrop-filter: url(#id)`, the entire chain processes the
   * backdrop content: first displaces, then blurs, then adjusts color.
   */
  private _buildSvgFilter(): void {
    const rect = this.element.getBoundingClientRect();
    const width = Math.round(rect.width) || 1;
    const height = Math.round(rect.height) || 1;
    this._lastWidth = width;
    this._lastHeight = height;

    const cornerRadii = this._getCornerRadii();
    const bezelWidth = this.options.refraction.thickness;
    const factor = this.options.refraction.factor;

    const { dataUrl, maxDisplacement } = generateDisplacementMap(
      width,
      height,
      cornerRadii,
      bezelWidth,
      factor,
    );

    const defs = this._renderer.svgDefs;
    if (!defs) return;

    this._filterElement?.remove();

    const filter = document.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", this._filterId);
    filter.setAttribute("x", "0");
    filter.setAttribute("y", "0");
    filter.setAttribute("width", "100%");
    filter.setAttribute("height", "100%");
    filter.setAttribute("color-interpolation-filters", "sRGB");

    const feImage = document.createElementNS(SVG_NS, "feImage");
    feImage.setAttribute("href", dataUrl);
    feImage.setAttribute("x", "0");
    feImage.setAttribute("y", "0");
    feImage.setAttribute("width", String(width));
    feImage.setAttribute("height", String(height));
    feImage.setAttribute("result", "dispmap");
    filter.appendChild(feImage);

    const scale = Math.max(1, Math.round(maxDisplacement));
    const feDisp = document.createElementNS(SVG_NS, "feDisplacementMap");
    feDisp.setAttribute("in", "SourceGraphic");
    feDisp.setAttribute("in2", "dispmap");
    feDisp.setAttribute("scale", String(scale));
    feDisp.setAttribute("xChannelSelector", "R");
    feDisp.setAttribute("yChannelSelector", "G");
    feDisp.setAttribute("result", "displaced");
    filter.appendChild(feDisp);

    if (this.options.blurRadius > 0) {
      const blurPx = this.options.blurRadius * SVG_CSS_BLUR_SCALE;
      const feBlur = document.createElementNS(SVG_NS, "feGaussianBlur");
      feBlur.setAttribute("in", "displaced");
      feBlur.setAttribute("stdDeviation", String(blurPx));
      feBlur.setAttribute("result", "blurred");
      filter.appendChild(feBlur);

      const feSat = document.createElementNS(SVG_NS, "feColorMatrix");
      feSat.setAttribute("in", "blurred");
      feSat.setAttribute("type", "saturate");
      feSat.setAttribute("values", "1.4");
      filter.appendChild(feSat);
    } else {
      const feSat = document.createElementNS(SVG_NS, "feColorMatrix");
      feSat.setAttribute("in", "displaced");
      feSat.setAttribute("type", "saturate");
      feSat.setAttribute("values", "1.4");
      filter.appendChild(feSat);
    }

    defs.appendChild(filter);
    this._filterElement = filter;
  }

  private _rebuildFilter(): void {
    const rect = this.element.getBoundingClientRect();
    const width = Math.round(rect.width) || 1;
    const height = Math.round(rect.height) || 1;

    if (width === this._lastWidth && height === this._lastHeight) return;

    this._buildSvgFilter();
    this._applyRefractionStyles();
  }

  private _setupResizeObserver(): void {
    if (typeof ResizeObserver === "undefined") return;
    this._resizeObserver = new ResizeObserver(() => {
      if (this._destroyed) return;
      this._rebuildFilter();
    });
    this._resizeObserver.observe(this.element);
  }

  private _applyRefractionStyles(): void {
    if (!this._refractionLayer) return;
    const filterUrl = `url(#${this._filterId})`;
    this._refractionLayer.style.backdropFilter = filterUrl;
    (this._refractionLayer.style as any).webkitBackdropFilter = filterUrl;
  }

  private _buildOverlays(): void {
    const refLayer = document.createElement("div");
    refLayer.setAttribute("data-lsvg-refraction", "");
    refLayer.style.cssText =
      "position:absolute;inset:0;z-index:-2;pointer-events:none;border-radius:inherit;";
    this._applyRefractionStylesTo(refLayer);
    this.element.insertBefore(refLayer, this.element.firstChild);
    this._refractionLayer = refLayer;

    const tint = document.createElement("div");
    tint.setAttribute("data-lsvg-tint", "");
    tint.style.cssText =
      "position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;";
    this._applyTintTo(tint);
    this.element.insertBefore(tint, refLayer.nextSibling);
    this._tintElement = tint;

    const chromatic = document.createElement("div");
    chromatic.setAttribute("data-lsvg-chromatic", "");
    chromatic.style.cssText =
      "position:absolute;inset:0;z-index:2147483645;pointer-events:none;border-radius:inherit;";
    this._applyChromaticTo(chromatic);
    this.element.appendChild(chromatic);
    this._chromaticElement = chromatic;

    const specular = document.createElement("div");
    specular.setAttribute("data-lsvg-specular", "");
    specular.style.cssText =
      "position:absolute;inset:0;z-index:2147483646;pointer-events:none;border-radius:inherit;overflow:hidden;";
    this._applySpecularTo(specular);
    this.element.appendChild(specular);
    this._specularElement = specular;

    const glare = document.createElement("div");
    glare.setAttribute("data-lsvg-glare", "");
    glare.style.cssText =
      "position:absolute;inset:0;z-index:2147483647;pointer-events:none;border-radius:inherit;overflow:hidden;";
    this._applyGlareTo(glare);
    this._applyFresnelTo(glare);
    this.element.appendChild(glare);
    this._glareElement = glare;
  }

  private _applyRefractionStylesTo(el: HTMLDivElement): void {
    const filterUrl = `url(#${this._filterId})`;
    el.style.backdropFilter = filterUrl;
    (el.style as any).webkitBackdropFilter = filterUrl;
  }

  private _applyTint(): void {
    if (this._tintElement) this._applyTintTo(this._tintElement);
  }

  private _applyTintTo(el: HTMLDivElement): void {
    const { r, g, b, a } = this.options.tint;
    el.style.background = a > 0 ? `rgba(${r},${g},${b},${a})` : "transparent";
  }

  private _applyGlare(): void {
    if (this._glareElement) this._applyGlareTo(this._glareElement);
  }

  private _applyGlareTo(el: HTMLDivElement): void {
    const g = this.options.glare;
    const factor = g.factor / 100;
    const oppFactor = g.oppositeFactor / 100;
    const hardness = g.hardness / 100;
    const convergence = g.convergence / 100;

    const edgeWidth = Math.max(2, 8 * (1 - convergence));
    const primaryAlpha = Math.min(0.35, factor * 0.35);
    const oppositeAlpha = Math.min(0.2, oppFactor * primaryAlpha);
    const fadeEnd = Math.min(20, edgeWidth + 6 * (1 - hardness));

    el.style.background = [
      `linear-gradient(${g.angle}deg,`,
      `rgba(255,255,255,${primaryAlpha.toFixed(3)}) 0%,`,
      `rgba(255,255,255,0) ${fadeEnd.toFixed(1)}%,`,
      `transparent 30%, transparent 70%,`,
      `rgba(255,255,255,0) ${(100 - fadeEnd).toFixed(1)}%,`,
      `rgba(255,255,255,${oppositeAlpha.toFixed(3)}) 100%)`,
    ].join("");
    el.style.mixBlendMode = "overlay";
  }

  private _applyFresnel(): void {
    if (this._glareElement) this._applyFresnelTo(this._glareElement);
  }

  private _applyFresnelTo(el: HTMLDivElement): void {
    const r = this.options.refraction;
    const ff = r.fresnelFactor / 100;
    const fr = r.fresnelRange;
    if (ff > 0 && fr > 0) {
      const blur = Math.max(1, fr * 0.5);
      const spread = Math.max(0, fr * 0.15);
      const alpha = Math.min(0.6, ff * 0.4);
      el.style.boxShadow =
        `inset 0 0 ${blur.toFixed(1)}px ${spread.toFixed(1)}px rgba(255,255,255,${alpha.toFixed(3)}),` +
        `inset 0 1px 0 0 rgba(255,255,255,${Math.min(0.3, alpha * 0.6).toFixed(3)})`;
    } else {
      el.style.boxShadow = "none";
    }
  }

  private _applyChromatic(): void {
    if (this._chromaticElement) this._applyChromaticTo(this._chromaticElement);
  }

  private _applyChromaticTo(el: HTMLDivElement): void {
    const intensity = Math.min(1, this.options.refraction.dispersion / 20);
    if (intensity <= 0) {
      el.style.background = "none";
      el.style.boxShadow = "none";
      return;
    }

    const ba = (0.045 * intensity).toFixed(3);
    const va = (0.04 * intensity).toFixed(3);
    const pa = (0.035 * intensity).toFixed(3);
    const ga = (0.025 * intensity).toFixed(3);

    el.style.background = [
      `radial-gradient(ellipse 55% 50% at 12% 50%, rgba(0,180,255,${ba}) 0%, transparent 70%)`,
      `radial-gradient(ellipse 50% 55% at 50% 12%, rgba(120,80,255,${va}) 0%, transparent 70%)`,
      `radial-gradient(ellipse 55% 50% at 88% 50%, rgba(255,100,200,${pa}) 0%, transparent 70%)`,
      `radial-gradient(ellipse 50% 55% at 50% 88%, rgba(100,255,180,${ga}) 0%, transparent 70%)`,
    ].join(",");

    const ea = (0.07 * intensity).toFixed(3);
    const ea2 = (0.05 * intensity).toFixed(3);
    el.style.boxShadow = [
      `inset 1px 0 0 0 rgba(0,180,255,${ea})`,
      `inset -1px 0 0 0 rgba(255,100,200,${ea})`,
      `inset 0 1px 0 0 rgba(100,255,180,${ea2})`,
      `inset 0 -1px 0 0 rgba(255,200,50,${ea2})`,
    ].join(",");
  }

  private _applySpecular(): void {
    if (this._specularElement) this._applySpecularTo(this._specularElement);
  }

  private _applySpecularTo(el: HTMLDivElement): void {
    const factor = this.options.glare.factor / 100;
    if (factor <= 0) { el.style.background = "none"; return; }

    const topAlpha = Math.min(0.07, factor * 0.07).toFixed(3);
    const lineAlpha = Math.min(0.55, factor * 0.55).toFixed(3);

    el.style.background = [
      `linear-gradient(180deg, rgba(255,255,255,${topAlpha}) 0%, transparent 45%)`,
      `linear-gradient(90deg, transparent 8%, rgba(255,255,255,${lineAlpha}) 50%, transparent 92%)`,
    ].join(",");
    el.style.backgroundSize = "100% 100%, 100% 1px";
    el.style.backgroundPosition = "0 0, 0 0";
    el.style.backgroundRepeat = "no-repeat";
  }

  private _fireInit(): void {
    this.options.on?.init?.(this);
  }
}

let svgInstance: SvgRenderer | null = null;

export function getSharedSvgRenderer(): SvgRenderer {
  if (!svgInstance) svgInstance = new SvgRenderer();
  return svgInstance;
}
