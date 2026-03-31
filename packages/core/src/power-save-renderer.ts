import { parseBgColorToRgba } from "./utils";
import {
  DEFAULT_TINT,
  type AqualensConfig,
  type AqualensLensInstance,
  type DOMRectLike,
  type TintColor,
} from "./types";

const POWER_SAVE_CSS_BLUR_SCALE = 1 / 6;

export class PowerSaveRenderer {
  private _lenses: PowerSaveLens[] = [];
  private _destroyed = false;

  addLens(element: HTMLElement, options: AqualensConfig): PowerSaveLens {
    const lens = new PowerSaveLens(element, options);
    this._lenses.push(lens);
    return lens;
  }

  removeLens(lens: PowerSaveLens): void {
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
  }
}

export class PowerSaveLens implements AqualensLensInstance {
  element: HTMLElement;
  options: AqualensConfig;
  rectPx: DOMRectLike | null = null;
  radiusGl = 0;
  radiusCss = 0;
  radiusGlCorners = { tl: 0, tr: 0, br: 0, bl: 0 };
  radiusCssCorners = { tl: 0, tr: 0, br: 0, bl: 0 };

  private _glareElement: HTMLDivElement | null = null;
  private _tintElement: HTMLDivElement | null = null;
  private _bgColorComponents: TintColor | null = null;
  private _origBackdropFilter: string;
  private _origWebkitBackdropFilter: string;
  private _origIsolation: string;
  private _origOverflow: string;
  private _destroyed = false;

  constructor(element: HTMLElement, options: AqualensConfig) {
    this.element = element;

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

    this._origBackdropFilter = element.style.backdropFilter || "";
    this._origWebkitBackdropFilter =
      (element.style as any).webkitBackdropFilter || "";
    this._origIsolation = element.style.isolation || "";
    this._origOverflow = element.style.overflow || "";

    element.style.setProperty("background-color", "transparent", "important");
    element.style.setProperty("background-image", "none", "important");
    element.style.setProperty("background", "transparent", "important");

    this._applyElementStyles();
    this._buildOverlays();
    this._fireInit();
  }

  getEffectiveZ(): number {
    return this.options.stackingIndex ?? 0;
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
    this._applyElementStyles();
    this._applyTint();
    this._applyGlare();
    this._applyFresnel();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._tintElement?.remove();
    this._glareElement?.remove();
    this.element.style.backdropFilter = this._origBackdropFilter;
    (this.element.style as any).webkitBackdropFilter =
      this._origWebkitBackdropFilter;
    this.element.style.isolation = this._origIsolation;
    this.element.style.overflow = this._origOverflow;

    this.element.style.removeProperty("background-image");
    this.element.style.removeProperty("background");
    this.element.style.removeProperty("background-color");

    if (this._bgColorComponents) {
      const { r, g, b, a } = this._bgColorComponents;
      this.element.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
    }
  }

  // ---- Element backdrop ----

  private _applyElementStyles(): void {
    const options = this.options;
    const parts: string[] = [];

    if (options.blurRadius > 0) {
      const cssBlurPx = options.blurRadius * POWER_SAVE_CSS_BLUR_SCALE;
      parts.push(`blur(${cssBlurPx}px)`);
    }
    parts.push("saturate(1.2)", "brightness(1.05)");

    const backdropFilter = parts.join(" ");
    this.element.style.backdropFilter = backdropFilter;
    (this.element.style as any).webkitBackdropFilter = backdropFilter;
    this.element.style.isolation = "isolate";
    if (options.blurEdge) this.element.style.overflow = "hidden";
  }

  // ---- Overlays ----

  private _buildOverlays(): void {
    const tint = document.createElement("div");
    tint.setAttribute("data-lps-tint", "");
    tint.style.cssText =
      "position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;";
    this._applyTintTo(tint);
    this.element.appendChild(tint);
    this._tintElement = tint;

    const glare = document.createElement("div");
    glare.setAttribute("data-lps-glare", "");
    glare.style.cssText =
      "position:absolute;inset:0;z-index:2147483647;pointer-events:none;border-radius:inherit;overflow:hidden;";
    this._applyGlareTo(glare);
    this._applyFresnelTo(glare);
    this.element.appendChild(glare);
    this._glareElement = glare;
  }

  // ---- Tint ----

  private _applyTint(): void {
    if (this._tintElement) this._applyTintTo(this._tintElement);
  }

  private _applyTintTo(targetElement: HTMLDivElement): void {
    const { r, g, b, a } = this.options.tint;
    targetElement.style.background =
      a > 0 ? `rgba(${r},${g},${b},${a})` : "transparent";
  }

  // ---- Glare ----

  private _applyGlare(): void {
    if (this._glareElement) this._applyGlareTo(this._glareElement);
  }

  private _applyGlareTo(targetElement: HTMLDivElement): void {
    const glareOptions = this.options.glare;
    const angle = glareOptions.angle;
    const factor = glareOptions.factor / 100;
    const oppFactor = glareOptions.oppositeFactor / 100;
    const hardness = glareOptions.hardness / 100;
    const convergence = glareOptions.convergence / 100;

    const edgeWidth = Math.max(2, 8 * (1 - convergence));
    const primaryAlpha = Math.min(0.35, factor * 0.35);
    const oppositeAlpha = Math.min(0.2, oppFactor * primaryAlpha);

    const fadeEnd = Math.min(20, edgeWidth + 6 * (1 - hardness));

    targetElement.style.background = [
      `linear-gradient(${angle}deg,`,
      `rgba(255,255,255,${primaryAlpha.toFixed(3)}) 0%,`,
      `rgba(255,255,255,0) ${fadeEnd.toFixed(1)}%,`,
      `transparent 30%,`,
      `transparent 70%,`,
      `rgba(255,255,255,0) ${(100 - fadeEnd).toFixed(1)}%,`,
      `rgba(255,255,255,${oppositeAlpha.toFixed(3)}) 100%)`,
    ].join("");
    targetElement.style.mixBlendMode = "overlay";
  }

  // ---- Fresnel edge glow ----

  private _applyFresnel(): void {
    if (this._glareElement) this._applyFresnelTo(this._glareElement);
  }

  private _applyFresnelTo(targetElement: HTMLDivElement): void {
    const refraction = this.options.refraction;
    const fresnelFactor = refraction.fresnelFactor / 100;
    const fresnelRange = refraction.fresnelRange;
    if (fresnelFactor > 0 && fresnelRange > 0) {
      const boxShadowBlur = Math.max(1, fresnelRange * 0.5);
      const spread = Math.max(0, fresnelRange * 0.15);
      const alpha = Math.min(0.6, fresnelFactor * 0.4);
      targetElement.style.boxShadow = `inset 0 0 ${boxShadowBlur.toFixed(1)}px ${spread.toFixed(1)}px rgba(255,255,255,${alpha.toFixed(3)}),inset 0 1px 0 0 rgba(255,255,255,${Math.min(0.3, alpha * 0.6).toFixed(3)})`;
    } else {
      targetElement.style.boxShadow = "none";
    }
  }

  // ---- Reveal & init callback ----

  private _fireInit(): void {
    this.options.on?.init?.(this);
  }
}

// ---- Singleton ----

let psInstance: PowerSaveRenderer | null = null;

export function getSharedPowerSaveRenderer(): PowerSaveRenderer {
  if (!psInstance) psInstance = new PowerSaveRenderer();
  return psInstance;
}
