import html2canvas from "html2canvas-pro";
import type { AqualensRenderer } from "./renderer";
import { ensureBlurPyramid } from "./renderer-fbo";
import { discoverAndAddFixedElements } from "./renderer-dynamic";
import { discoverReveals, triggerRevealCaptures } from "./renderer-reveal";
import { LENS_DOM_ATTR } from "./lens";

/**
 * The private WebGL canvas always matches the visual viewport so that the
 * coordinate maths in `renderer-draw` keeps using `canvas.height` for the
 * GL Y-flip without changes. The canvas is offscreen (not in the DOM)
 * and the user only ever sees per-lens public canvases.
 */
export function resizeCanvas(renderer: AqualensRenderer): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.canvas.width = innerWidth * dpr;
  renderer.canvas.height = innerHeight * dpr;
  renderer.gl.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
}

export function doResizeCapture(renderer: AqualensRenderer): void {
  if (renderer._destroyed) return;

  renderer._dynamicNodes.forEach((node) => {
    const meta = renderer._dynMeta.get(node.element);
    if (meta) {
      meta.needsRecapture = true;
      meta.prevDrawRect = null;
      meta.lastCapture = null;
    }
  });

  resizeCanvas(renderer);
  renderer.lenses.forEach((lens) => {
    lens.updateMetrics();
    lens._syncPublicCanvasSize();
  });

  const generation = renderer._resizeGeneration;
  renderer.captureSnapshot().then(() => {
    if (renderer._destroyed) return;
    if (generation !== renderer._resizeGeneration || renderer._resizePending) {
      renderer._resizePending = false;
      doResizeCapture(renderer);
      return;
    }
    renderer.requestRender();
    requestAnimationFrame(() => {
      disableResizeFallback(renderer);
    });
  });
}

/**
 * While the page is mid-resize and the renderer hasn't yet recaptured the
 * snapshot, our existing WebGL pixels would render the old snapshot
 * stretched into the new lens rect — a visually obvious "ghost".
 * To avoid that we:
 *  - hide every lens's `publicCanvas` (visibility:hidden) so the WebGL
 *    layer is invisible during the resize;
 *  - apply a native CSS `backdrop-filter` (blur + saturate + brightness)
 *    on the lens DOM element as a low-fidelity fallback so the lens
 *    still looks glassy;
 *  - add tint and glare DOM overlays inside the lens to mimic the WebGL
 *    output.
 *
 * `disableResizeFallback` reverses everything when the new snapshot is
 * ready and a fresh frame has been rendered.
 */
export function enableResizeFallback(renderer: AqualensRenderer): void {
  if (renderer._resizeFallbackActive) return;
  renderer._resizeFallbackActive = true;
  renderer._resizeGeneration++;

  const CSS_BLUR_SCALE = 1 / 6;

  for (const lens of renderer.lenses) {
    const element = lens.element;
    const options = lens.options;

    // Hide the WebGL output for this lens.
    const prevVisibility = lens.publicCanvas.style.visibility;
    lens.publicCanvas.style.visibility = "hidden";

    const parts: string[] = [];
    if (options.blurRadius > 0) {
      parts.push(`blur(${(options.blurRadius * CSS_BLUR_SCALE).toFixed(1)}px)`);
    }
    parts.push("saturate(1.2)", "brightness(1.05)");
    const backdropFilter = parts.join(" ");
    element.style.setProperty("backdrop-filter", backdropFilter, "important");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (element.style as any).setProperty(
      "-webkit-backdrop-filter",
      backdropFilter,
      "important",
    );
    element.style.isolation = "isolate";

    const tint = document.createElement("div");
    tint.setAttribute("data-liquid-resize-fallback", "");
    tint.style.cssText =
      "position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:inherit;";
    const tintColor = options.tint;
    tint.style.background =
      tintColor.a > 0
        ? `rgba(${tintColor.r},${tintColor.g},${tintColor.b},${tintColor.a})`
        : "transparent";
    element.appendChild(tint);

    const glare = document.createElement("div");
    glare.setAttribute("data-liquid-resize-fallback", "");
    glare.style.cssText =
      "position:absolute;inset:0;z-index:2147483647;pointer-events:none;border-radius:inherit;overflow:hidden;";

    const glareOptions = options.glare;
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

    const refraction = options.refraction;
    const fresnelFactor = refraction.fresnelFactor / 100;
    const fresnelRange = refraction.fresnelRange;
    if (fresnelFactor > 0 && fresnelRange > 0) {
      const boxShadowBlur = Math.max(1, fresnelRange * 0.5);
      const spread = Math.max(0, fresnelRange * 0.15);
      const alpha = Math.min(0.6, fresnelFactor * 0.4);
      glare.style.boxShadow =
        `inset 0 0 ${boxShadowBlur.toFixed(1)}px ${spread.toFixed(1)}px rgba(255,255,255,${alpha.toFixed(3)}),` +
        `inset 0 1px 0 0 rgba(255,255,255,${Math.min(0.3, alpha * 0.6).toFixed(3)})`;
    }

    element.appendChild(glare);

    renderer._resizeFallbackCleanups.push(() => {
      element.style.setProperty("backdrop-filter", "none", "important");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (element.style as any).setProperty(
        "-webkit-backdrop-filter",
        "none",
        "important",
      );
      element.style.isolation = "";
      tint.remove();
      glare.remove();
      lens.publicCanvas.style.visibility = prevVisibility;
    });
  }
}

export function disableResizeFallback(renderer: AqualensRenderer): void {
  if (!renderer._resizeFallbackActive) return;
  renderer._resizeFallbackActive = false;
  for (const cleanup of renderer._resizeFallbackCleanups) cleanup();
  renderer._resizeFallbackCleanups.length = 0;
}

export async function captureSnapshotImpl(
  renderer: AqualensRenderer,
): Promise<boolean> {
  if (renderer._capturing) return false;
  renderer._capturing = true;

  const attemptCapture = async (
    attempt = 1,
    maxAttempts = 3,
    delayMs = 500,
  ): Promise<boolean> => {
    try {
      const fullWidth = renderer.snapshotTarget.scrollWidth;
      const fullHeight = renderer.snapshotTarget.scrollHeight;
      const maxTextureSize =
        renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE) || 8192;
      const MAX_MOBILE_DIM = 4096;
      const isMobileSafari = /iPad|iPhone|iPod/.test(navigator.userAgent);

      let scale = Math.min(
        renderer._snapshotResolution,
        maxTextureSize / fullWidth,
        maxTextureSize / fullHeight,
      );

      if (isMobileSafari) {
        const over = (Math.max(fullWidth, fullHeight) * scale) / MAX_MOBILE_DIM;
        if (over > 1) scale = scale / over;
      }
      renderer.scaleFactor = Math.max(0.1, scale);

      const ignoreElementsFunc = (element: Element): boolean => {
        if (!element || !("hasAttribute" in element)) return false;
        const el = element as HTMLElement;
        // The lens marker covers both the lens root and any descendant
        // (its DOM content / overlays / public canvas). Refraction must
        // sample what's BEHIND the lens, so the lens and its content
        // must not appear in the source texture.
        if (
          typeof el.closest === "function" &&
          el.closest(`[${LENS_DOM_ATTR}]`)
        ) {
          return true;
        }
        const style = window.getComputedStyle(el);
        if (style.position === "fixed") {
          return true;
        }
        return !!(
          el.hasAttribute("data-liquid-ignore") ||
          (typeof el.closest === "function" &&
            el.closest("[data-liquid-ignore]"))
        );
      };

      const snapCanvas = await html2canvas(renderer.snapshotTarget, {
        allowTaint: false,
        useCORS: true,
        backgroundColor: null,
        removeContainer: true,
        width: fullWidth,
        height: fullHeight,
        scrollX: 0,
        scrollY: 0,
        scale: scale,
        ignoreElements: ignoreElementsFunc,
      });

      uploadTexture(renderer, snapCanvas);
      return true;
    } catch (error) {
      console.error("aqualens snapshot failed on attempt " + attempt, error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await attemptCapture(attempt + 1, maxAttempts, delayMs);
      } else {
        console.error("aqualens: All snapshot attempts failed.", error);
        return false;
      }
    } finally {
      renderer._capturing = false;
    }
  };

  return await attemptCapture();
}

function uploadTexture(
  renderer: AqualensRenderer,
  srcCanvas: HTMLCanvasElement,
): void {
  if (!srcCanvas) return;
  if (srcCanvas.width === 0 || srcCanvas.height === 0) return;
  renderer.staticSnapshotCanvas = srcCanvas;
  const gl = renderer.gl;
  if (!renderer.texture) renderer.texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    srcCanvas,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  renderer.textureWidth = srcCanvas.width;
  renderer.textureHeight = srcCanvas.height;
  renderer._textureVersion++;

  ensureBlurPyramid(renderer);
  if (!renderer._fixedElementsDiscovered) {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => discoverAndAddFixedElements(renderer), {
        timeout: 100,
      });
    } else {
      setTimeout(() => discoverAndAddFixedElements(renderer), 0);
    }
  }

  discoverReveals(renderer);
  for (const reveal of renderer._revealNodes) {
    reveal.needsRecapture = true;
    reveal.capture = null;
  }
  triggerRevealCaptures(renderer);

  renderer.render();

  if (renderer._pendingActivation.length) {
    renderer._pendingActivation.forEach((lens) => lens._activate());
    renderer._pendingActivation.length = 0;
  }
}
