import html2canvas from "html2canvas-pro";
import type { AqualensRenderer } from "./renderer";

/**
 * Metadata tracked for each element carrying a `data-liquid-reveal` attribute.
 * The attribute value is a number that gates which lenses are allowed to
 * reveal the element: a lens reveals it only when its `stackingIndex` is
 * greater than or equal to `revealValue`.
 */
export interface RevealMeta {
  element: HTMLElement;
  revealValue: number;
  capture: HTMLCanvasElement | null;
  needsRecapture: boolean;
  _capturing: boolean;
}

const MAX_CONCURRENT_REVEAL_CAPTURE = 2;

function parseRevealValue(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Scan the snapshot target for `[data-liquid-reveal]` elements and reconcile
 * them with the renderer's tracked list. Newly discovered elements get a
 * pending capture; elements that were removed from the DOM are dropped.
 */
export function discoverReveals(renderer: AqualensRenderer): void {
  const nodes = renderer.snapshotTarget.querySelectorAll<HTMLElement>(
    "[data-liquid-reveal]",
  );

  const seen = new Set<HTMLElement>();
  for (const element of Array.from(nodes)) {
    if (element.closest("[data-liquid-ignore]")) continue;
    const value = parseRevealValue(element.getAttribute("data-liquid-reveal"));
    if (value === null) continue;
    seen.add(element);

    const existing = renderer._revealNodes.find((r) => r.element === element);
    if (existing) {
      if (existing.revealValue !== value) {
        existing.revealValue = value;
        existing.needsRecapture = true;
      }
    } else {
      renderer._revealNodes.push({
        element,
        revealValue: value,
        capture: null,
        needsRecapture: true,
        _capturing: false,
      });
    }
  }

  if (renderer._revealNodes.length > 0) {
    renderer._revealNodes = renderer._revealNodes.filter(
      (reveal) => seen.has(reveal.element) && reveal.element.isConnected,
    );
  }
}

/**
 * Kick off an html2canvas capture for each reveal element that needs one.
 * The capture must temporarily override the CSS rule that hides reveals so
 * the rasterized canvas actually shows the element's content.
 */
export function triggerRevealCaptures(renderer: AqualensRenderer): void {
  for (const reveal of renderer._revealNodes) {
    if (!reveal.needsRecapture || reveal._capturing) continue;
    if (!reveal.element.isConnected) continue;
    if (
      renderer._revealCaptureInFlight >= MAX_CONCURRENT_REVEAL_CAPTURE
    )
      return;

    reveal._capturing = true;
    renderer._revealCaptureInFlight += 1;

    html2canvas(reveal.element, {
      backgroundColor: null,
      scale: renderer.scaleFactor,
      useCORS: true,
      removeContainer: true,
      logging: false,
      ignoreElements: (el: Element) =>
        el.tagName === "CANVAS" ||
        (el as HTMLElement).hasAttribute("data-liquid-ignore"),
      onclone: (clonedDoc: Document) => {
        const liquidStyles = clonedDoc.getElementById(
          "liquid-gl-dynamic-styles",
        );
        liquidStyles?.remove();
        const override = clonedDoc.createElement("style");
        override.textContent =
          "html [data-liquid-reveal]{opacity:1 !important;pointer-events:auto !important;display:revert !important;}";
        clonedDoc.head.appendChild(override);
      },
    })
      .then((canvas) => {
        if (canvas.width > 0 && canvas.height > 0) {
          reveal.capture = canvas;
          reveal.needsRecapture = false;
        }
      })
      .catch(() => {})
      .finally(() => {
        reveal._capturing = false;
        renderer._revealCaptureInFlight = Math.max(
          0,
          renderer._revealCaptureInFlight - 1,
        );
        renderer.requestRender();
      });
  }
}

function ensureRevealUploadTex(
  renderer: AqualensRenderer,
  width: number,
  height: number,
): void {
  const gl = renderer.gl;
  if (!renderer._revealUploadTex) {
    renderer._revealUploadTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, renderer._revealUploadTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  if (
    width > renderer._revealUploadTexW ||
    height > renderer._revealUploadTexH
  ) {
    const newW = Math.max(width, renderer._revealUploadTexW);
    const newH = Math.max(height, renderer._revealUploadTexH);
    gl.bindTexture(gl.TEXTURE_2D, renderer._revealUploadTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      newW,
      newH,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    renderer._revealUploadTexW = newW;
    renderer._revealUploadTexH = newH;
  }
}

/**
 * Blit a reveal element's captured pixels onto the compose FBO at the element's
 * document-space position. Returns true when at least one reveal was drawn.
 */
export function compositeRevealsForStackingIndex(
  renderer: AqualensRenderer,
  stackingIndex: number,
  snapRect: DOMRect,
): boolean {
  const gl = renderer.gl;
  if (!renderer._composeFbo || !renderer._composeTex) return false;

  let anyDrawn = false;
  let programBound = false;

  for (const reveal of renderer._revealNodes) {
    if (renderer._revealComposited.has(reveal)) continue;
    if (reveal.revealValue > stackingIndex) continue;
    if (!reveal.capture) continue;
    if (!reveal.element.isConnected) continue;

    const rect = reveal.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const texX = Math.round((rect.left - snapRect.left) * renderer.scaleFactor);
    const texY = Math.round((rect.top - snapRect.top) * renderer.scaleFactor);
    const texW = Math.round(rect.width * renderer.scaleFactor);
    const texH = Math.round(rect.height * renderer.scaleFactor);
    if (texW <= 0 || texH <= 0) continue;
    if (texX + texW <= 0 || texY + texH <= 0) continue;
    if (texX >= renderer.textureWidth || texY >= renderer.textureHeight)
      continue;

    const captureW = reveal.capture.width;
    const captureH = reveal.capture.height;
    if (captureW <= 0 || captureH <= 0) continue;

    ensureRevealUploadTex(renderer, captureW, captureH);

    gl.bindTexture(gl.TEXTURE_2D, renderer._revealUploadTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      reveal.capture,
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    if (!programBound) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer._composeFbo);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(renderer._compositeProgram);
      gl.bindVertexArray(renderer._vao);
      gl.activeTexture(gl.TEXTURE0);
      programBound = true;
    }

    gl.viewport(texX, texY, texW, texH);
    gl.bindTexture(gl.TEXTURE_2D, renderer._revealUploadTex);
    gl.uniform1i(renderer._compositeU.src, 0);
    gl.uniform2f(
      renderer._compositeU.srcRegion,
      captureW / renderer._revealUploadTexW,
      captureH / renderer._revealUploadTexH,
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    renderer._revealComposited.add(reveal);
    anyDrawn = true;
  }

  if (programBound) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  return anyDrawn;
}

/**
 * Returns true when at least one reveal element should be considered active
 * this frame — i.e. there is any lens whose `stackingIndex` is high enough to
 * unhide some `[data-liquid-reveal]` element.
 */
export function hasEligibleReveals(renderer: AqualensRenderer): boolean {
  if (renderer._revealNodes.length === 0) return false;

  let maxStackingIndex = -Infinity;
  for (const lens of renderer.lenses) {
    const si = lens.options.stackingIndex;
    if (si !== undefined && si > maxStackingIndex) maxStackingIndex = si;
  }
  if (!Number.isFinite(maxStackingIndex)) return false;

  for (const reveal of renderer._revealNodes) {
    if (reveal.revealValue <= maxStackingIndex) return true;
  }
  return false;
}

export function destroyRevealResources(renderer: AqualensRenderer): void {
  const gl = renderer.gl;
  if (renderer._revealUploadTex) {
    gl.deleteTexture(renderer._revealUploadTex);
    renderer._revealUploadTex = null;
  }
  renderer._revealUploadTexW = 0;
  renderer._revealUploadTexH = 0;
  renderer._revealNodes = [];
  renderer._revealComposited.clear();
  renderer._revealCaptureInFlight = 0;
}
