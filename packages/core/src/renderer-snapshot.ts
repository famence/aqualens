import { getHtml2Canvas } from "./html2canvas-loader";
import type { AqualensRenderer } from "./renderer";
import { ensureBlurPyramid } from "./renderer-fbo";
import { discoverAndAddFixedElements } from "./renderer-dynamic";

export function resizeCanvas(renderer: AqualensRenderer): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.canvas.width = innerWidth * dpr;
  renderer.canvas.height = innerHeight * dpr;
  renderer.canvas.style.width = `${innerWidth}px`;
  renderer.canvas.style.height = `${innerHeight}px`;
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
  renderer.lenses.forEach((lens) => lens.updateMetrics());

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

export function enableResizeFallback(renderer: AqualensRenderer): void {
  if (renderer._resizeFallbackActive) return;
  renderer._resizeFallbackActive = true;
  renderer.canvas.style.visibility = "hidden";

  const CSS_BLUR_SCALE = 1 / 6;

  for (const lens of renderer.lenses) {
    const element = lens.element;
    const options = lens.options;

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
      tintColor.a > 0 ? `rgba(${tintColor.r},${tintColor.g},${tintColor.b},${tintColor.a})` : "transparent";
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
    });
  }
}

export function disableResizeFallback(renderer: AqualensRenderer): void {
  if (!renderer._resizeFallbackActive) return;
  renderer._resizeFallbackActive = false;
  for (const cleanup of renderer._resizeFallbackCleanups) cleanup();
  renderer._resizeFallbackCleanups.length = 0;
  renderer.canvas.style.visibility = "";
}

export async function captureSnapshotImpl(
  renderer: AqualensRenderer,
): Promise<boolean> {
  if (renderer._capturing) return false;
  renderer._capturing = true;

  const undos: (() => void)[] = [];

  const attemptCapture = async (
    attempt = 1,
    maxAttempts = 3,
    delayMs = 500,
  ): Promise<boolean> => {
    try {
      const fullWidth = renderer.snapshotTarget.scrollWidth;
      const fullHeight = renderer.snapshotTarget.scrollHeight;
      const maxTextureSize = renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE) || 8192;
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

      if (renderer.canvas.style.opacity !== "1") {
        const prevVisibility = renderer.canvas.style.visibility;
        renderer.canvas.style.visibility = "hidden";
        undos.push(() => {
          renderer.canvas.style.visibility = prevVisibility;
        });
      }

      const lensElements = renderer.lenses.map((lens) => lens.element);

      const ignoreElementsFunc = (element: Element): boolean => {
        if (!element || !("hasAttribute" in element)) return false;
        if (
          element === renderer.canvas ||
          lensElements.includes(element as HTMLElement)
        ) {
          return true;
        }
        const style = window.getComputedStyle(element);
        if (style.position === "fixed") {
          return true;
        }
        return !!(
          (element as HTMLElement).hasAttribute("data-liquid-ignore") ||
          (element as HTMLElement).closest("[data-liquid-ignore]")
        );
      };

      const html2canvas = await getHtml2Canvas();
      if (!html2canvas) {
        renderer._capturing = false;
        return false;
      }

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
        onclone(clonedDoc: Document) {
          clonedDoc.documentElement.setAttribute(
            "data-liquid-snapshot",
            "true",
          );
        },
      });

      uploadTexture(renderer, snapCanvas);
      return true;
    } catch (error) {
      console.error(
        "aqualens snapshot failed on attempt " + attempt,
        error,
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await attemptCapture(attempt + 1, maxAttempts, delayMs);
      } else {
        console.error("aqualens: All snapshot attempts failed.", error);
        return false;
      }
    } finally {
      for (let index = undos.length - 1; index >= 0; index--) {
        undos[index]();
      }
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
  renderer.render();

  if (renderer._pendingActivation.length) {
    renderer._pendingActivation.forEach((lens) => lens._activate());
    renderer._pendingActivation.length = 0;
  }
}
