import html2canvas from "html2canvas-pro";
import type { AqualensRenderer } from "./renderer";
import type { AqualensLens } from "./lens";

/**
 * Reveal compositing mode.
 *
 * - `under-lens` (default): the reveal content is painted into the lens's
 *   source texture BEFORE the glass effect samples it, so the reveal is
 *   distorted, tinted and blurred by the lens like any other pixel of the
 *   scene. This is the "X-ray through the glass" behavior.
 *
 * - `on-lens`: the reveal content is painted AFTER the glass is rendered,
 *   clipped by the lens's SDF shape, so it appears on top of the glass tint
 *   and blur. Useful when the lens has a strong/opaque tint (e.g. an Apple
 *   Music-style active-tab indicator) and you want the reveal to stay
 *   legible "inside" the lens.
 */
export type RevealMode = "under-lens" | "on-lens";

/**
 * Metadata tracked for each element carrying a `data-liquid-reveal-index`
 * attribute. The attribute value is a number that gates which lenses are
 * allowed to reveal the element: a lens reveals it only when its
 * `stackingIndex` is greater than or equal to `revealValue`.
 */
export interface RevealMeta {
  element: HTMLElement;
  revealValue: number;
  mode: RevealMode;
  capture: HTMLCanvasElement | null;
  needsRecapture: boolean;
  _capturing: boolean;
}

const MAX_CONCURRENT_REVEAL_CAPTURE = 2;

/** Attribute that gates a reveal by stacking-index (numeric). */
const REVEAL_INDEX_ATTR = "data-liquid-reveal-index";
/** Attribute that picks the compositing mode (`under-lens` | `on-lens`). */
const REVEAL_MODE_ATTR = "data-liquid-reveal-mode";
/** Shared selector: any element with a numeric reveal-index attribute. */
const REVEAL_SELECTOR = `[${REVEAL_INDEX_ATTR}]`;

/** Attribute names observed for mutations / used in the onclone style override. */
export const REVEAL_OBSERVED_ATTRS: readonly string[] = [
  REVEAL_INDEX_ATTR,
  REVEAL_MODE_ATTR,
];

/** CSS selector used to match reveal elements on the page. */
export const REVEAL_CSS_SELECTOR = REVEAL_SELECTOR;

function parseRevealValue(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRevealMode(raw: string | null): RevealMode {
  return raw === "on-lens" ? "on-lens" : "under-lens";
}

/**
 * Scan the snapshot target for reveal elements and reconcile them with the
 * renderer's tracked list. Newly discovered elements get a pending capture;
 * elements that were removed from the DOM are dropped. Changes to either the
 * index or the mode attribute trigger a recapture.
 */
export function discoverReveals(renderer: AqualensRenderer): void {
  const nodes =
    renderer.snapshotTarget.querySelectorAll<HTMLElement>(REVEAL_SELECTOR);

  const seen = new Set<HTMLElement>();
  for (const element of Array.from(nodes)) {
    if (element.closest("[data-liquid-ignore]")) continue;
    const value = parseRevealValue(element.getAttribute(REVEAL_INDEX_ATTR));
    if (value === null) continue;
    const mode = parseRevealMode(element.getAttribute(REVEAL_MODE_ATTR));
    seen.add(element);

    const existing = renderer._revealNodes.find((r) => r.element === element);
    if (existing) {
      if (existing.revealValue !== value) {
        existing.revealValue = value;
        existing.needsRecapture = true;
      }
      if (existing.mode !== mode) {
        existing.mode = mode;
        existing.needsRecapture = true;
      }
    } else {
      renderer._revealNodes.push({
        element,
        revealValue: value,
        mode,
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
    if (renderer._revealCaptureInFlight >= MAX_CONCURRENT_REVEAL_CAPTURE)
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
        override.textContent = `html ${REVEAL_SELECTOR}{opacity:1 !important;pointer-events:auto !important;display:revert !important;}`;
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
 * Blit an `under-lens` reveal element's captured pixels onto the compose FBO
 * at the element's document-space position so the glass effect samples it.
 * Returns true when at least one reveal was drawn.
 *
 * `on-lens` reveals are skipped here; they are painted later, after the lens
 * is rendered, by {@link compositeRevealsOnLensForGroup}.
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
    if (reveal.mode !== "under-lens") continue;
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
 * Geometry for a single lens shape inside the current render viewport.
 *
 * `center` / `halfSize` are expressed in canvas pixels (i.e. the same space
 * as `gl_FragCoord`, and the space already used by the main/mask shaders'
 * `u_shapes` uniform). Corners are ordered TL, TR, BR, BL — matching the
 * convention in {@link AqualensLens.radiusGlCorners}.
 */
export interface RevealLensShape {
  center: { x: number; y: number };
  halfSize: { x: number; y: number };
  corners: { tl: number; tr: number; br: number; bl: number };
}

/**
 * Refraction parameters sampled from a lens's material, used to drive the
 * reveal shader's refraction offset so the reveal distorts the same way the
 * background does through the glass. For merged groups we pass the first
 * lens's params — per-shape material blending is not supported in the reveal
 * shader today (it would add a lot of uniform pressure for what is, in
 * practice, a rare case of merging lenses with materially different
 * refraction settings).
 */
export interface RevealRefraction {
  thickness: number;
  factor: number;
  dispersion: number;
}

/**
 * Paint all `on-lens` reveals eligible for this stacking group on top of the
 * default framebuffer (where the glass has just been rendered), clipped by
 * the provided lens SDF shapes. Any number of shapes can be merged — they
 * use the same `smin` as the main/mask shaders.
 *
 * `viewport*` describe the render viewport in canvas pixels; `viewportLeft`
 * and `viewportTop` are the CSS-pixel coordinates of its top-left corner
 * (used to map reveal-element rects into the shader's local-pixel space).
 */
export function compositeRevealsOnLensForGroup(
  renderer: AqualensRenderer,
  stackingIndex: number,
  shapes: RevealLensShape[],
  mergeK: number,
  refraction: RevealRefraction,
  viewportX: number,
  viewportY: number,
  viewportWidth: number,
  viewportHeight: number,
  viewportLeft: number,
  viewportTop: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
  dpr: number,
): void {
  if (shapes.length === 0) return;
  if (viewportWidth < 2 || viewportHeight < 2) return;

  const gl = renderer.gl;

  // Filter to reveals that are (a) tagged on-lens, (b) eligible for this
  // stacking group, (c) have a capture, and (d) actually overlap the viewport.
  const candidates: RevealMeta[] = [];
  for (const reveal of renderer._revealNodes) {
    if (reveal.mode !== "on-lens") continue;
    if (reveal.revealValue > stackingIndex) continue;
    if (!reveal.capture) continue;
    if (!reveal.element.isConnected) continue;
    const rect = reveal.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right < viewportLeft) continue;
    if (rect.left > viewportLeft + viewportWidthPx) continue;
    if (rect.bottom < viewportTop) continue;
    if (rect.top > viewportTop + viewportHeightPx) continue;
    candidates.push(reveal);
  }
  if (candidates.length === 0) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(viewportX, viewportY, viewportWidth, viewportHeight);
  gl.useProgram(renderer._revealMaskedProgram);
  gl.bindVertexArray(renderer._vao);
  gl.activeTexture(gl.TEXTURE0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // Shape uniforms (shared across all reveals drawn in this group).
  const uniforms = renderer._revealMaskedU;
  gl.uniform2f(uniforms.resolution, viewportWidth, viewportHeight);
  gl.uniform1f(uniforms.dpr, dpr);
  gl.uniform1f(uniforms.radius, 0);
  gl.uniform4f(uniforms.radiusCorners, 0, 0, 0, 0);
  gl.uniform1i(uniforms.shapeCount, shapes.length);
  gl.uniform1f(uniforms.mergeK, shapes.length > 1 ? mergeK : 0);
  gl.uniform1f(uniforms.refThickness, refraction.thickness);
  gl.uniform1f(uniforms.refFactor, refraction.factor);
  gl.uniform1f(uniforms.refDispersion, refraction.dispersion);

  // Pack shapes into the same [center.xy, halfSize.xy][corners.tl,tr,br,bl]
  // 8-float layout as `u_shapes` in the mask/main shaders.
  const shapeData = renderer._scratchShapeData;
  shapeData.fill(0);
  for (let index = 0; index < Math.min(shapes.length, 8); index++) {
    const shape = shapes[index];
    const base = index * 8;
    shapeData[base] = shape.center.x;
    shapeData[base + 1] = shape.center.y;
    shapeData[base + 2] = shape.halfSize.x;
    shapeData[base + 3] = shape.halfSize.y;
    shapeData[base + 4] = shape.corners.tl;
    shapeData[base + 5] = shape.corners.tr;
    shapeData[base + 6] = shape.corners.br;
    shapeData[base + 7] = shape.corners.bl;
  }
  gl.uniform4fv(uniforms.shapes, shapeData);

  for (const reveal of candidates) {
    const rect = reveal.element.getBoundingClientRect();
    const captureW = reveal.capture!.width;
    const captureH = reveal.capture!.height;
    if (captureW <= 0 || captureH <= 0) continue;

    ensureRevealUploadTex(renderer, captureW, captureH);
    gl.bindTexture(gl.TEXTURE_2D, renderer._revealUploadTex);
    // NOTE: no UNPACK_FLIP_Y — we flip y inside the shader so the same
    // upload orientation works for both compose-FBO and default-FB use.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      reveal.capture!,
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    // Reveal rect in the shader's local-pixel space (origin bottom-left of
    // the viewport, y increasing upward — same as `u_shapes`).
    const localLeft = (rect.left - viewportLeft) * dpr;
    const localBottom =
      (viewportHeightPx - (rect.top - viewportTop) - rect.height) * dpr;
    const localW = rect.width * dpr;
    const localH = rect.height * dpr;

    gl.uniform4f(uniforms.revealRect, localLeft, localBottom, localW, localH);
    gl.uniform2f(
      uniforms.revealRegion,
      captureW / renderer._revealUploadTexW,
      captureH / renderer._revealUploadTexH,
    );
    gl.uniform1i(uniforms.reveal, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  gl.bindVertexArray(null);
}

/** Build the shape descriptors for a single-lens viewport (matches renderLens). */
export function buildSingleLensShape(
  lens: AqualensLens,
  dpr: number,
  shadowPad: number,
): RevealLensShape | null {
  const rect = lens.rectPx;
  if (!rect) return null;
  return {
    center: {
      x: (shadowPad + rect.width / 2) * dpr,
      y: (shadowPad + rect.height / 2) * dpr,
    },
    halfSize: {
      x: (rect.width / 2) * dpr,
      y: (rect.height / 2) * dpr,
    },
    corners: { ...lens.radiusGlCorners },
  };
}

/** Build the shape descriptors for a merged-group viewport (matches renderMergedGroup). */
export function buildMergedGroupShapes(
  lenses: AqualensLens[],
  dpr: number,
  unionLeft: number,
  unionBottom: number,
): RevealLensShape[] {
  const shapes: RevealLensShape[] = [];
  for (const lens of lenses) {
    const rect = lens.rectPx;
    if (!rect) continue;
    shapes.push({
      center: {
        x: (rect.left - unionLeft + rect.width / 2) * dpr,
        y: (unionBottom - (rect.top + rect.height / 2)) * dpr,
      },
      halfSize: {
        x: (rect.width / 2) * dpr,
        y: (rect.height / 2) * dpr,
      },
      corners: { ...lens.radiusGlCorners },
    });
  }
  return shapes;
}

/**
 * Returns true when at least one reveal element should be considered active
 * this frame — i.e. there is any lens whose `stackingIndex` is high enough to
 * unhide some reveal element.
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

/**
 * Returns true when there is at least one `under-lens` reveal eligible for
 * the current frame. This is the subset that needs to be composited into the
 * compose FBO before the glass is rendered (and therefore requires an
 * up-to-date compose texture).
 */
export function hasEligibleUnderLensReveals(
  renderer: AqualensRenderer,
): boolean {
  if (renderer._revealNodes.length === 0) return false;

  let maxStackingIndex = -Infinity;
  for (const lens of renderer.lenses) {
    const si = lens.options.stackingIndex;
    if (si !== undefined && si > maxStackingIndex) maxStackingIndex = si;
  }
  if (!Number.isFinite(maxStackingIndex)) return false;

  for (const reveal of renderer._revealNodes) {
    if (reveal.mode !== "under-lens") continue;
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
