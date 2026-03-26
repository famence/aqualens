import { getHtml2Canvas } from "./html2canvas-loader";
import { effectiveZ, parseTransform } from "./utils";
import type { AqualensRenderer } from "./renderer";
import type { DynMeta } from "./gl-utils";

const MAX_CONCURRENT_DYN_RECAPTURE = 2;

export function isIgnored(element: HTMLElement): boolean {
  return !!(
    element &&
    typeof element.closest === "function" &&
    element.closest("[data-liquid-ignore]")
  );
}

function getMaxLensZ(renderer: AqualensRenderer): number {
  let maxZ = 0;
  for (const lens of renderer.lenses) {
    const z = lens.getEffectiveZ();
    if (z > maxZ) maxZ = z;
  }
  return maxZ;
}

function createRoundedRectPath(
  canvasContext: CanvasRenderingContext2D,
  width: number,
  height: number,
  radii: { tl: number; tr: number; br: number; bl: number },
): void {
  canvasContext.beginPath();
  canvasContext.moveTo(radii.tl, 0);
  canvasContext.lineTo(width - radii.tr, 0);
  canvasContext.arcTo(width, 0, width, radii.tr, radii.tr);
  canvasContext.lineTo(width, height - radii.br);
  canvasContext.arcTo(width, height, width - radii.br, height, radii.br);
  canvasContext.lineTo(radii.bl, height);
  canvasContext.arcTo(0, height, 0, height - radii.bl, radii.bl);
  canvasContext.lineTo(0, radii.tl);
  canvasContext.arcTo(0, 0, radii.tl, 0, radii.tl);
  canvasContext.closePath();
}

function drawVideoWithObjectFit(
  canvasContext: CanvasRenderingContext2D,
  videoElement: HTMLVideoElement,
  drawWidth: number,
  drawHeight: number,
): void {
  const style = window.getComputedStyle(videoElement);
  const objectFit = style.objectFit;
  const videoWidth = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;

  if (
    objectFit === "cover" &&
    videoWidth > 0 &&
    videoHeight > 0 &&
    drawWidth > 0 &&
    drawHeight > 0
  ) {
    const containerAspect = drawWidth / drawHeight;
    const videoAspect = videoWidth / videoHeight;
    let sourceX: number,
      sourceY: number,
      sourceWidth: number,
      sourceHeight: number;

    if (videoAspect > containerAspect) {
      sourceHeight = videoHeight;
      sourceWidth = videoHeight * containerAspect;
      sourceX = (videoWidth - sourceWidth) * 0.5;
      sourceY = 0;
    } else {
      sourceWidth = videoWidth;
      sourceHeight = videoWidth / containerAspect;
      sourceX = 0;
      sourceY = (videoHeight - sourceHeight) * 0.5;
    }

    const objPos = style.objectPosition || "50% 50%";
    const parts = objPos.split(/\s+/);
    const posX = parts[0]?.endsWith("%") ? parseFloat(parts[0]) / 100 : 0.5;
    const posY = parts[1]?.endsWith("%") ? parseFloat(parts[1]) / 100 : 0.5;

    if (videoAspect > containerAspect) {
      sourceX = (videoWidth - sourceWidth) * posX;
    } else {
      sourceY = (videoHeight - sourceHeight) * posY;
    }

    canvasContext.drawImage(
      videoElement,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      drawWidth,
      drawHeight,
    );
  } else if (
    objectFit === "contain" &&
    videoWidth > 0 &&
    videoHeight > 0 &&
    drawWidth > 0 &&
    drawHeight > 0
  ) {
    const containerAspect = drawWidth / drawHeight;
    const videoAspect = videoWidth / videoHeight;
    let destX: number, destY: number, destWidth: number, destHeight: number;

    if (videoAspect > containerAspect) {
      destWidth = drawWidth;
      destHeight = drawWidth / videoAspect;
      destX = 0;
      destY = (drawHeight - destHeight) * 0.5;
    } else {
      destHeight = drawHeight;
      destWidth = drawHeight * videoAspect;
      destY = 0;
      destX = (drawWidth - destWidth) * 0.5;
    }
    canvasContext.drawImage(
      videoElement,
      0,
      0,
      videoWidth,
      videoHeight,
      destX,
      destY,
      destWidth,
      destHeight,
    );
  } else {
    canvasContext.drawImage(videoElement, 0, 0, drawWidth, drawHeight);
  }
}

function prepareObjectFitPatch(root: Element): {
  onclone: (clonedDoc: Document) => void;
  cleanup: () => void;
} {
  const uid = Math.random().toString(36).substr(2, 6);
  const objectFitAttribute = `data-lqgl-ofit-${uid}`;
  const entries: {
    id: string;
    fit: string;
    objectPosition: string;
    src: string;
    width: string;
    height: string;
    display: string;
    borderRadius: string;
    cssPosition: string;
    top: string;
    right: string;
    bottom: string;
    left: string;
    margin: string;
    zIndex: string;
  }[] = [];

  const imgs = root.querySelectorAll("img");
  imgs.forEach((img, index) => {
    const computedStyle = window.getComputedStyle(img);
    const fit = computedStyle.objectFit;
    if (!fit || fit === "fill") return;

    const src =
      (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src;
    if (!src) return;

    const id = String(index);
    img.setAttribute(objectFitAttribute, id);
    entries.push({
      id,
      fit,
      objectPosition: computedStyle.objectPosition || "50% 50%",
      src,
      width: computedStyle.width,
      height: computedStyle.height,
      display: computedStyle.display,
      borderRadius: computedStyle.borderRadius,
      cssPosition: computedStyle.position,
      top: computedStyle.top,
      right: computedStyle.right,
      bottom: computedStyle.bottom,
      left: computedStyle.left,
      margin: computedStyle.margin,
      zIndex: computedStyle.zIndex,
    });
  });

  return {
    onclone: (clonedDoc: Document) => {
      entries.forEach((imageEntry) => {
        const clonedElement = clonedDoc.querySelector(
          `[${objectFitAttribute}="${imageEntry.id}"]`,
        );
        if (!clonedElement || !clonedElement.parentNode) return;

        const div = clonedDoc.createElement("div");
        div.style.width = imageEntry.width;
        div.style.height = imageEntry.height;
        div.style.display =
          imageEntry.display === "inline" ? "inline-block" : imageEntry.display;
        div.style.backgroundImage = `url("${imageEntry.src}")`;
        div.style.backgroundSize =
          imageEntry.fit === "contain"
            ? "contain"
            : imageEntry.fit === "none"
              ? "auto"
              : "cover";
        div.style.backgroundPosition = imageEntry.objectPosition;
        div.style.backgroundRepeat = "no-repeat";
        div.style.borderRadius = imageEntry.borderRadius;
        div.style.overflow = "hidden";
        div.style.boxSizing = "border-box";

        div.style.position = imageEntry.cssPosition;
        div.style.top = imageEntry.top;
        div.style.right = imageEntry.right;
        div.style.bottom = imageEntry.bottom;
        div.style.left = imageEntry.left;
        div.style.margin = imageEntry.margin;
        if (imageEntry.zIndex !== "auto") div.style.zIndex = imageEntry.zIndex;

        clonedElement.parentNode!.replaceChild(div, clonedElement);
      });
    },
    cleanup: () => {
      imgs.forEach((img) => img.removeAttribute(objectFitAttribute));
    },
  };
}

export function updateDynamicVideos(renderer: AqualensRenderer): void {
  if (renderer._isScrolling && renderer._scrollUpdateCounter % 2 !== 0) return;
  if (
    !renderer.texture ||
    !renderer.staticSnapshotCanvas ||
    !renderer._videoNodes.length
  )
    return;
  const gl = renderer.gl;
  const snapRect = renderer.snapshotTarget.getBoundingClientRect();
  const maxLensZ = getMaxLensZ(renderer);

  const lensRects = renderer.lenses
    .filter((lens) => lens.element.isConnected)
    .map((lens) => lens.rectPx)
    .filter(Boolean) as { left: number; top: number; width: number; height: number }[];

  renderer._videoNodes.forEach((videoElement) => {
    if (effectiveZ(videoElement) >= maxLensZ) return;
    if (isIgnored(videoElement) || videoElement.readyState < 2) return;

    const rect = videoElement.getBoundingClientRect();

    const intersectsAnyLens = lensRects.some(
      (lr) =>
        rect.left < lr.left + lr.width &&
        rect.left + rect.width > lr.left &&
        rect.top < lr.top + lr.height &&
        rect.top + rect.height > lr.top,
    );
    if (!intersectsAnyLens) return;
    const texCoordX = (rect.left - snapRect.left) * renderer.scaleFactor;
    const texCoordY = (rect.top - snapRect.top) * renderer.scaleFactor;
    const texWidth = rect.width * renderer.scaleFactor;
    const texHeight = rect.height * renderer.scaleFactor;

    const drawWidth = Math.round(texWidth);
    const drawHeight = Math.round(texHeight);
    if (drawWidth <= 0 || drawHeight <= 0) return;

    if (
      renderer._tmpCanvas.width !== drawWidth ||
      renderer._tmpCanvas.height !== drawHeight
    ) {
      renderer._tmpCanvas.width = drawWidth;
      renderer._tmpCanvas.height = drawHeight;
    }

    try {
      renderer._tmpCtx.save();
      renderer._tmpCtx.clearRect(0, 0, drawWidth, drawHeight);

      const style = window.getComputedStyle(videoElement);

      const parseRadius = (value: string, refSize: number) => {
        let pixels = 0;
        if (value.startsWith("calc")) {
          const calcContent = value.match(/calc\((.*)\)/)?.[1] || "";
          const matches = calcContent.match(/[+-]?\s*\d+(?:\.\d+)?(?:%|px)?/g);
          if (matches) {
            pixels = matches.reduce((sum, match) => {
              const cleanMatch = match.replace(/\s+/g, "");
              const sign = cleanMatch.startsWith("-") ? -1 : 1;
              const valueStr = cleanMatch.replace(/^[+-]/, "");
              let parsedValue: number;
              if (valueStr.endsWith("%")) {
                parsedValue = (refSize * parseFloat(valueStr)) / 100;
              } else {
                parsedValue = parseFloat(valueStr) || 0;
              }
              return sum + sign * parsedValue;
            }, 0);
          }
        } else if (value.endsWith("%")) {
          pixels = (refSize * parseFloat(value)) / 100;
        } else {
          pixels = parseFloat(value) || 0;
        }
        return isNaN(pixels) ? 0 : pixels;
      };

      const refSize = Math.min(drawWidth, drawHeight) / renderer.scaleFactor;

      const scaledRadii = {
        tl:
          parseRadius(style.borderTopLeftRadius, refSize) *
          renderer.scaleFactor,
        tr:
          parseRadius(style.borderTopRightRadius, refSize) *
          renderer.scaleFactor,
        br:
          parseRadius(style.borderBottomRightRadius, refSize) *
          renderer.scaleFactor,
        bl:
          parseRadius(style.borderBottomLeftRadius, refSize) *
          renderer.scaleFactor,
      };

      if (Object.values(scaledRadii).some((radiusValue) => radiusValue > 0)) {
        createRoundedRectPath(
          renderer._tmpCtx,
          drawWidth,
          drawHeight,
          scaledRadii,
        );
        renderer._tmpCtx.clip();
      }

      renderer._tmpCtx.drawImage(
        renderer.staticSnapshotCanvas!,
        texCoordX,
        texCoordY,
        texWidth,
        texHeight,
        0,
        0,
        drawWidth,
        drawHeight,
      );
      drawVideoWithObjectFit(
        renderer._tmpCtx,
        videoElement,
        drawWidth,
        drawHeight,
      );
      renderer._tmpCtx.restore();
    } catch {
      return;
    }

    const drawX = Math.round(texCoordX);
    const drawY = Math.round(texCoordY);
    if (drawWidth <= 0 || drawHeight <= 0) return;

    const maxTextureWidth = renderer.textureWidth;
    const maxTextureHeight = renderer.textureHeight;
    let destX = drawX;
    let destY = drawY;
    let updateWidth = drawWidth;
    let updateHeight = drawHeight;

    if (destX < 0) {
      updateWidth += destX;
      destX = 0;
    }
    if (destY < 0) {
      updateHeight += destY;
      destY = 0;
    }
    if (destX + updateWidth > maxTextureWidth)
      updateWidth = maxTextureWidth - destX;
    if (destY + updateHeight > maxTextureHeight)
      updateHeight = maxTextureHeight - destY;
    if (updateWidth <= 0 || updateHeight <= 0) return;

    gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      destX,
      destY,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      renderer._tmpCanvas,
    );
    renderer._textureVersion++;
  });
}

export function discoverAndAddFixedElements(
  renderer: AqualensRenderer,
): void {
  if (renderer._fixedElementsDiscovered) return;
  renderer._fixedElementsDiscovered = true;

  const lensElements = new Set(renderer.lenses.map((lens) => lens.element));
  const iter = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
  );
  let element: Element | null;
  while ((element = iter.nextNode() as Element | null)) {
    if (element === renderer.canvas || lensElements.has(element as HTMLElement))
      continue;
    if ((element as HTMLElement).closest?.("[data-liquid-ignore]")) continue;
    const style = window.getComputedStyle(element);
    if (style.position === "fixed") {
      addDynamicElementImpl(renderer, element as HTMLElement, {
        isFixed: true,
      });
    }
  }
}

export function updateDynamicNodes(renderer: AqualensRenderer): void {
  const gl = renderer.gl;
  if (!renderer.texture || !renderer._dynMeta) return;
  const snapRect = renderer.snapshotTarget.getBoundingClientRect();
  const maxLensZ = getMaxLensZ(renderer);
  const lensRects = renderer.lenses
    .filter((lens) => lens.element.isConnected)
    .map((lens) => lens.rectPx)
    .filter(Boolean);

  const rectsIntersect = (
    a: DOMRect,
    b: { left: number; top: number; width: number; height: number },
  ) =>
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top;

  if (!renderer._compositeCtx) {
    renderer._compositeCtx = document.createElement("canvas").getContext("2d")!;
  }

  const compositeVideos = (
    compositeCtx: CanvasRenderingContext2D,
    dynamicElRect: DOMRect,
  ) => {
    renderer._videoNodes.forEach((videoElement) => {
      if (effectiveZ(videoElement) >= maxLensZ) return;
      const videoRect = videoElement.getBoundingClientRect();

      if (
        dynamicElRect.left < videoRect.right &&
        dynamicElRect.right > videoRect.left &&
        dynamicElRect.top < videoRect.bottom &&
        dynamicElRect.bottom > videoRect.top
      ) {
        const xInComposite =
          (videoRect.left - dynamicElRect.left) * renderer.scaleFactor;
        const yInComposite =
          (videoRect.top - dynamicElRect.top) * renderer.scaleFactor;
        const widthInComposite = videoRect.width * renderer.scaleFactor;
        const heightInComposite = videoRect.height * renderer.scaleFactor;
        compositeCtx.drawImage(
          videoElement,
          xInComposite,
          yInComposite,
          widthInComposite,
          heightInComposite,
        );
      }
    });
  };

  renderer._dynamicNodes.forEach((node) => {
    const element = node.element;
    const meta = renderer._dynMeta.get(element);
    if (!meta) return;
    if (
      renderer._isScrolling &&
      renderer._scrollUpdateCounter % 2 !== 0 &&
      !meta._isFixed
    ) {
      return;
    }

    if (meta.needsRecapture && !meta._capturing && !renderer._isScrolling) {
      if (renderer._dynRecaptureInFlight >= MAX_CONCURRENT_DYN_RECAPTURE)
        return;
      meta._capturing = true;
      renderer._dynRecaptureInFlight += 1;

      const objectFitPatch = prepareObjectFitPatch(element);

      getHtml2Canvas()
        .then((html2canvas) => {
          if (!html2canvas) {
            meta._capturing = false;
            renderer._dynRecaptureInFlight = Math.max(
              0,
              renderer._dynRecaptureInFlight - 1,
            );
            objectFitPatch.cleanup();
            return;
          }
          return html2canvas(element, {
            backgroundColor: null,
            scale: renderer.scaleFactor,
            useCORS: true,
            removeContainer: true,
            logging: false,
            ignoreElements: (ignoredElement: Element) =>
              ignoredElement.tagName === "CANVAS" ||
              (ignoredElement as HTMLElement).hasAttribute("data-liquid-ignore"),
            onclone: objectFitPatch.onclone,
          })
            .then((capturedCanvas) => {
              if (capturedCanvas.width > 0 && capturedCanvas.height > 0) {
                meta.lastCapture = capturedCanvas;
                meta.needsRecapture = false;
              }
            })
            .catch(() => {})
            .finally(() => {
              meta._capturing = false;
              renderer._dynRecaptureInFlight = Math.max(
                0,
                renderer._dynRecaptureInFlight - 1,
              );
              objectFitPatch.cleanup();
            });
        });
    }

    if (meta.lastCapture) {
      if (meta.prevDrawRect && !(renderer._workerEnabled && meta._heavyAnim)) {
        const { x, y, w, h } = meta.prevDrawRect;
        if (w > 0 && h > 0) {
          const eraseCanvas = renderer._compositeCtx!.canvas;
          if (eraseCanvas.width !== w || eraseCanvas.height !== h) {
            eraseCanvas.width = w;
            eraseCanvas.height = h;
          }
          renderer._compositeCtx!.drawImage(
            renderer.staticSnapshotCanvas!,
            x,
            y,
            w,
            h,
            0,
            0,
            w,
            h,
          );
          gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            x,
            y,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            eraseCanvas,
          );
          renderer._textureVersion++;
        }
      }

      const rect = element.getBoundingClientRect();
      if (
        effectiveZ(element) >= maxLensZ ||
        !document.contains(element) ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        meta.prevDrawRect = null;
        return;
      }

      if (!lensRects.some((lensRect) => rectsIntersect(rect, lensRect!))) {
        meta.prevDrawRect = null;
        return;
      }

      const texCoordX = (rect.left - snapRect.left) * renderer.scaleFactor;
      const texCoordY = (rect.top - snapRect.top) * renderer.scaleFactor;
      const drawWidth = Math.round(rect.width * renderer.scaleFactor);
      const drawHeight = Math.round(rect.height * renderer.scaleFactor);
      const drawX = Math.round(texCoordX);
      const drawY = Math.round(texCoordY);
      if (drawWidth <= 0 || drawHeight <= 0) return;

      const maxTextureWidth = renderer.textureWidth;
      const maxTextureHeight = renderer.textureHeight;
      let destX = drawX;
      let destY = drawY;
      let updateWidth = drawWidth;
      let updateHeight = drawHeight;

      if (destX < 0) {
        updateWidth += destX;
        destX = 0;
      }
      if (destY < 0) {
        updateHeight += destY;
        destY = 0;
      }
      if (destX + updateWidth > maxTextureWidth)
        updateWidth = maxTextureWidth - destX;
      if (destY + updateHeight > maxTextureHeight)
        updateHeight = maxTextureHeight - destY;
      if (updateWidth <= 0 || updateHeight <= 0) return;

      const compositeCanvas = renderer._compositeCtx!.canvas;
      if (
        compositeCanvas.width !== drawWidth ||
        compositeCanvas.height !== drawHeight
      ) {
        compositeCanvas.width = drawWidth;
        compositeCanvas.height = drawHeight;
      }
      renderer._compositeCtx!.clearRect(0, 0, drawWidth, drawHeight);

      renderer._compositeCtx!.drawImage(
        renderer.staticSnapshotCanvas!,
        texCoordX,
        texCoordY,
        rect.width * renderer.scaleFactor,
        rect.height * renderer.scaleFactor,
        0,
        0,
        drawWidth,
        drawHeight,
      );
      compositeVideos(renderer._compositeCtx!, rect);

      const style = window.getComputedStyle(element);
      renderer._compositeCtx!.save();
      renderer._compositeCtx!.translate(drawWidth / 2, drawHeight / 2);
      if (style.transform !== "none") {
        renderer._compositeCtx!.transform(...parseTransform(style.transform));
      }
      renderer._compositeCtx!.translate(-drawWidth / 2, -drawHeight / 2);
      renderer._compositeCtx!.globalAlpha = parseFloat(style.opacity) || 1.0;
      renderer._compositeCtx!.drawImage(
        meta.lastCapture,
        0,
        0,
        drawWidth,
        drawHeight,
      );
      renderer._compositeCtx!.restore();

      gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        destX,
        destY,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        compositeCanvas,
      );
      renderer._textureVersion++;

      if (renderer._workerEnabled && meta._heavyAnim) {
        const jobId = `${Date.now()}_${Math.random()}`;
        renderer._dynJobs!.set(jobId, {
          x: destX,
          y: destY,
          w: updateWidth,
          h: updateHeight,
        });

        Promise.all([
          createImageBitmap(
            renderer.staticSnapshotCanvas!,
            destX,
            destY,
            updateWidth,
            updateHeight,
          ),
          createImageBitmap(meta.lastCapture),
        ]).then(([snapBmp, dynBmp]) => {
          renderer._dynWorker!.postMessage(
            {
              id: jobId,
              width: updateWidth,
              height: updateHeight,
              snap: snapBmp,
              dyn: dynBmp,
            },
            [snapBmp, dynBmp],
          );
        });
        meta.prevDrawRect = {
          x: destX,
          y: destY,
          w: updateWidth,
          h: updateHeight,
        };
        return;
      }

      meta.prevDrawRect = {
        x: destX,
        y: destY,
        w: updateWidth,
        h: updateHeight,
      };
    }
  });
}

export function addDynamicElementImpl(
  renderer: AqualensRenderer,
  elementOrSelector: HTMLElement | HTMLElement[] | NodeList | string,
  options?: { isFixed?: boolean },
): void {
  if (!elementOrSelector) return;
  if (typeof elementOrSelector === "string") {
    renderer.snapshotTarget
      .querySelectorAll(elementOrSelector)
      .forEach((node) =>
        addDynamicElementImpl(renderer, node as HTMLElement, options),
      );
    return;
  }
  if (
    NodeList.prototype.isPrototypeOf(elementOrSelector) ||
    Array.isArray(elementOrSelector)
  ) {
    Array.from(elementOrSelector as ArrayLike<HTMLElement>).forEach((node) =>
      addDynamicElementImpl(renderer, node, options),
    );
    return;
  }

  const element = elementOrSelector as HTMLElement;
  if (!element.getBoundingClientRect) return;
  if (element.closest && element.closest("[data-liquid-ignore]")) return;
  if (renderer._dynamicNodes.some((node) => node.element === element)) return;

  renderer._dynamicNodes = renderer._dynamicNodes.filter(
    (node) => !element.contains(node.element),
  );

  const meta: DynMeta = {
    _capturing: false,
    prevDrawRect: null,
    lastCapture: null,
    needsRecapture: true,
    hoverClassName: null,
    _animating: false,
    _rafId: null,
    _lastCaptureTs: 0,
    _heavyAnim: false,
    _isFixed: options?.isFixed ?? false,
  };
  renderer._dynMeta.set(element, meta);

  const setDirty = () => {
    const dynamicMeta = renderer._dynMeta.get(element);
    if (dynamicMeta && !dynamicMeta.needsRecapture) {
      dynamicMeta.needsRecapture = true;
      renderer.requestRender();
    }
  };

  const findAppliedHoverStyles = (targetElement: HTMLElement): string => {
    let cssText = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (
            !(rule instanceof CSSStyleRule) ||
            !rule.selectorText.includes(":hover")
          )
            continue;
          const baseSelector = rule.selectorText.split(":hover")[0];
          if (targetElement.matches(baseSelector)) {
            cssText += rule.style.cssText;
          }
        }
      } catch {
        // cross-origin stylesheet
      }
    }
    return cssText;
  };

  const handleLeave = () => {
    const dynamicMeta = renderer._dynMeta.get(element);
    if (!dynamicMeta || !dynamicMeta.hoverClassName) return;

    element.classList.remove(dynamicMeta.hoverClassName);
    if (renderer._dynamicStyleSheet) {
      for (
        let index = renderer._dynamicStyleSheet.cssRules.length - 1;
        index >= 0;
        index--
      ) {
        const rule = renderer._dynamicStyleSheet.cssRules[index];
        if (
          (rule as CSSStyleRule).selectorText ===
          `.${dynamicMeta!.hoverClassName}`
        ) {
          renderer._dynamicStyleSheet.deleteRule(index);
          break;
        }
      }
    }
    dynamicMeta.hoverClassName = null;
    setDirty();
  };

  const cleanupRemoved = () => {
    handleLeave();
    renderer._dynamicNodes = renderer._dynamicNodes.filter(
      (node) => node.element !== element,
    );
    renderer._dynMeta.delete(element);
    if (
      renderer._dynamicNodes.length === 0 &&
      renderer._dynamicRemovalObserver
    ) {
      renderer._dynamicRemovalObserver.disconnect();
      renderer._dynamicRemovalObserver = null;
    }
  };

  element.addEventListener(
    "mouseenter",
    () => {
      const dynamicMeta = renderer._dynMeta.get(element);
      if (!dynamicMeta) return;
      const hoverCss = findAppliedHoverStyles(element);
      if (hoverCss && renderer._dynamicStyleSheet) {
        const className = `lqgl-h-${Math.random().toString(36).substr(2, 9)}`;
        const rule = `.${className} { ${hoverCss} }`;
        try {
          renderer._dynamicStyleSheet.insertRule(
            rule,
            renderer._dynamicStyleSheet.cssRules.length,
          );
          dynamicMeta.hoverClassName = className;
          element.classList.add(className);
        } catch {
          // rule insertion failed
        }
      }
      setDirty();
    },
    { passive: true },
  );

  element.addEventListener("mouseleave", handleLeave, { passive: true });
  element.addEventListener("transitionend", setDirty, { passive: true });

  const startRealtime = () => {
    const dynamicMeta = renderer._dynMeta.get(element);
    if (!dynamicMeta || dynamicMeta._animating) return;
    dynamicMeta._animating = true;
    dynamicMeta._heavyAnim = false;

    const step = (timestamp: number) => {
      const currentMeta = renderer._dynMeta.get(element);
      if (!currentMeta || !currentMeta._animating) return;
      if (
        currentMeta._heavyAnim &&
        !currentMeta._capturing &&
        timestamp - currentMeta._lastCaptureTs > 33
      ) {
        currentMeta._lastCaptureTs = timestamp;
        currentMeta.needsRecapture = true;
      }
      if (currentMeta._heavyAnim) {
        currentMeta._rafId = requestAnimationFrame(step);
      } else {
        currentMeta._rafId = null;
      }
    };
    dynamicMeta._rafId = requestAnimationFrame(step);
  };

  const trackProperty = (propertyName: string) => {
    const dynamicMeta = renderer._dynMeta.get(element);
    if (!dynamicMeta) return;
    const lowerProperty = (propertyName || "").toLowerCase();
    if (
      !(
        lowerProperty.includes("transform") || lowerProperty.includes("opacity")
      )
    ) {
      const wasHeavy = dynamicMeta._heavyAnim;
      dynamicMeta._heavyAnim = true;
      if (dynamicMeta._animating && !wasHeavy && !dynamicMeta._rafId) {
        dynamicMeta._animating = false;
        startRealtime();
      }
    }
  };

  const transitionRunHandler = (event: TransitionEvent) => {
    trackProperty(event.propertyName);
    startRealtime();
  };

  element.addEventListener(
    "transitionrun",
    transitionRunHandler as EventListener,
    { passive: true },
  );
  element.addEventListener(
    "transitionstart",
    transitionRunHandler as EventListener,
    { passive: true },
  );
  element.addEventListener(
    "animationstart",
    () => {
      const dynamicMeta = renderer._dynMeta.get(element);
      if (dynamicMeta) dynamicMeta._heavyAnim = true;
      startRealtime();
    },
    { passive: true },
  );
  element.addEventListener(
    "animationiteration",
    () => {
      const dynamicMeta = renderer._dynMeta.get(element);
      if (dynamicMeta) {
        dynamicMeta._heavyAnim = true;
        if (!dynamicMeta._animating) startRealtime();
      }
    },
    { passive: true },
  );

  const stopRealtime = () => {
    const dynamicMeta = renderer._dynMeta.get(element);
    if (!dynamicMeta || !dynamicMeta._animating) return;
    dynamicMeta._animating = false;
    if (dynamicMeta._rafId) {
      cancelAnimationFrame(dynamicMeta._rafId);
      dynamicMeta._rafId = null;
    }
    dynamicMeta._heavyAnim = false;
    setDirty();
  };

  element.addEventListener("transitionend", stopRealtime, {
    passive: true,
  });
  element.addEventListener("transitioncancel", stopRealtime, {
    passive: true,
  });
  element.addEventListener("animationend", stopRealtime, {
    passive: true,
  });
  element.addEventListener("animationcancel", stopRealtime, {
    passive: true,
  });

  ensureDynamicRemovalObserver(renderer);
  renderer._dynamicNodes.push({ element: element, _cleanup: cleanupRemoved });
}

function ensureDynamicRemovalObserver(
  renderer: AqualensRenderer,
): void {
  if (
    renderer._dynamicRemovalObserver ||
    typeof MutationObserver === "undefined"
  )
    return;
  renderer._dynamicRemovalObserver = new MutationObserver(() => {
    if (renderer._dynamicRemovalRaf !== null) return;
    renderer._dynamicRemovalRaf = requestAnimationFrame(() => {
      renderer._dynamicRemovalRaf = null;
      const nodes = renderer._dynamicNodes.slice();
      for (const node of nodes) {
        if (!document.contains(node.element)) node._cleanup();
      }
    });
  });
  renderer._dynamicRemovalObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}
