import type { AqualensRenderer } from "./renderer";
import type { AqualensLens } from "./lens";
import { createFBO } from "./gl-utils";

const MAX_BLUR_LEVELS = 7;

export function ensureBlurPyramid(renderer: AqualensRenderer): void {
  if (renderer._blurLevelCount === 0) return;
  if (
    !renderer.texture ||
    renderer.textureWidth === 0 ||
    renderer.textureHeight === 0
  )
    return;

  const baseW = renderer.textureWidth;
  const baseH = renderer.textureHeight;
  const levels = renderer._blurLevelCount;

  if (
    renderer._blurPyramid.length === levels &&
    renderer._blurPyramid.length > 0 &&
    renderer._blurPyramid[0].w === Math.max(1, baseW >> 1) &&
    renderer._blurPyramid[0].h === Math.max(1, baseH >> 1)
  ) {
    return;
  }

  destroyBlurPyramid(renderer);

  let w = baseW;
  let h = baseH;
  for (let i = 0; i < levels; i++) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    const { fbo, tex } = createFBO(renderer.gl, w, h);
    renderer._blurPyramid.push({ fbo, tex, w, h });
  }

  renderer._blurResultTex = renderer._blurPyramid[0].tex;
}

export function destroyBlurPyramid(renderer: AqualensRenderer): void {
  const gl = renderer.gl;
  for (const level of renderer._blurPyramid) {
    gl.deleteFramebuffer(level.fbo);
    gl.deleteTexture(level.tex);
  }
  renderer._blurPyramid = [];
  renderer._blurResultTex = null;
  renderer._blurredForTextureVersion = -1;
}

export function updateBlurConfig(renderer: AqualensRenderer): void {
  let maxRadius = 0;
  for (const lens of renderer.lenses) {
    if (lens.options.blurRadius > maxRadius)
      maxRadius = lens.options.blurRadius;
  }
  maxRadius = Math.min(200, Math.max(0, Math.round(maxRadius)));
  if (maxRadius !== renderer._currentBlurRadius) {
    renderer._currentBlurRadius = maxRadius;
    if (maxRadius === 0) {
      destroyBlurPyramid(renderer);
      renderer._blurLevelCount = 0;
    } else {
      renderer._blurLevelCount = Math.min(
        MAX_BLUR_LEVELS,
        Math.max(1, Math.ceil(Math.log2(Math.max(maxRadius, 1)))),
      );
    }
  }
}

export function runKawaseBlur(
  renderer: AqualensRenderer,
  sourceTexture?: WebGLTexture,
): void {
  if (!renderer.texture || renderer._blurPyramid.length === 0) return;

  const gl = renderer.gl;
  const pyramid = renderer._blurPyramid;
  const source = sourceTexture || renderer.texture;

  gl.bindVertexArray(renderer._vao);

  gl.useProgram(renderer._kawaseDownProgram);

  let inputTex = source;
  let inputW = renderer.textureWidth;
  let inputH = renderer.textureHeight;

  for (let i = 0; i < pyramid.length; i++) {
    const level = pyramid[i];
    gl.bindFramebuffer(gl.FRAMEBUFFER, level.fbo);
    gl.viewport(0, 0, level.w, level.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(renderer._kawaseDownU.tex, 0);
    gl.uniform2f(renderer._kawaseDownU.halfPixel, 0.5 / inputW, 0.5 / inputH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    inputTex = level.tex;
    inputW = level.w;
    inputH = level.h;
  }

  gl.useProgram(renderer._kawaseUpProgram);

  for (let i = pyramid.length - 1; i > 0; i--) {
    const srcLevel = pyramid[i];
    const dstLevel = pyramid[i - 1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstLevel.fbo);
    gl.viewport(0, 0, dstLevel.w, dstLevel.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcLevel.tex);
    gl.uniform1i(renderer._kawaseUpU.tex, 0);
    gl.uniform2f(
      renderer._kawaseUpU.halfPixel,
      0.5 / srcLevel.w,
      0.5 / srcLevel.h,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
}

export function ensureComposeFbo(renderer: AqualensRenderer): void {
  const width = renderer.textureWidth;
  const height = renderer.textureHeight;
  if (width === 0 || height === 0) return;
  if (
    renderer._composeFbo &&
    renderer._composeFboW === width &&
    renderer._composeFboH === height
  )
    return;

  destroyComposeFbo(renderer);

  const { fbo, tex } = createFBO(renderer.gl, width, height);
  renderer._composeFbo = fbo;
  renderer._composeTex = tex;
  renderer._composeFboW = width;
  renderer._composeFboH = height;
}

export function destroyComposeFbo(renderer: AqualensRenderer): void {
  const gl = renderer.gl;
  if (renderer._composeFbo) gl.deleteFramebuffer(renderer._composeFbo);
  if (renderer._composeTex) gl.deleteTexture(renderer._composeTex);
  if (renderer._srcReadFbo) gl.deleteFramebuffer(renderer._srcReadFbo);
  if (renderer._canvasCopyTex) gl.deleteTexture(renderer._canvasCopyTex);
  renderer._composeFbo = renderer._composeTex = null;
  renderer._srcReadFbo = renderer._canvasCopyTex = null;
  renderer._composeFboW = renderer._composeFboH = 0;
  renderer._canvasCopyTexW = renderer._canvasCopyTexH = 0;
}

export function copyToCompose(renderer: AqualensRenderer): void {
  const gl = renderer.gl;
  if (!renderer._composeFbo || !renderer.texture) return;

  if (!renderer._srcReadFbo) renderer._srcReadFbo = gl.createFramebuffer()!;

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, renderer._srcReadFbo);
  gl.framebufferTexture2D(
    gl.READ_FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    renderer.texture,
    0,
  );
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, renderer._composeFbo);

  gl.blitFramebuffer(
    0,
    0,
    renderer.textureWidth,
    renderer.textureHeight,
    0,
    0,
    renderer.textureWidth,
    renderer.textureHeight,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

function ensureCanvasCopyTex(
  renderer: AqualensRenderer,
  width: number,
  height: number,
): void {
  const gl = renderer.gl;
  if (!renderer._canvasCopyTex) {
    renderer._canvasCopyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, renderer._canvasCopyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  if (width > renderer._canvasCopyTexW || height > renderer._canvasCopyTexH) {
    const newWidth = Math.max(width, renderer._canvasCopyTexW);
    const newHeight = Math.max(height, renderer._canvasCopyTexH);
    gl.bindTexture(gl.TEXTURE_2D, renderer._canvasCopyTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      newWidth,
      newHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    renderer._canvasCopyTexW = newWidth;
    renderer._canvasCopyTexH = newHeight;
  }
}

/**
 * Copy the just-rendered canvas region for a group of lenses into the
 * compose FBO at the matching document-space position. This is a
 * cascade-mode helper: a higher-z group then samples the compose FBO and
 * thus refracts the glass effect of the lower-z group as part of its
 * own background.
 */
export function flattenGroupToCompose(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  dpr: number,
): void {
  const gl = renderer.gl;
  if (!renderer._composeFbo || !renderer._composeTex) return;
  if (lenses.length === 0) return;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const lens of lenses) {
    const rect = lens.rectPx;
    if (!rect) continue;
    const shadowPad = lens.computeShadowPad();
    const MERGE_RADIUS_CSS = 30;
    const mergeExtra = lenses.length > 1 ? MERGE_RADIUS_CSS + 10 : 0;
    const padding = Math.max(mergeExtra, shadowPad);

    left = Math.min(left, rect.left - padding);
    top = Math.min(top, rect.top - padding);
    right = Math.max(right, rect.left + rect.width + padding);
    bottom = Math.max(bottom, rect.top + rect.height + padding);
  }

  if (!isFinite(left)) return;

  let overscrollX = 0;
  let overscrollY = 0;
  let viewportWidth = innerWidth;
  let viewportHeight = innerHeight;
  if (window.visualViewport) {
    overscrollX = window.visualViewport.offsetLeft;
    overscrollY = window.visualViewport.offsetTop;
    viewportWidth = window.visualViewport.width;
    viewportHeight = window.visualViewport.height;
  }

  const leftVisible = Math.max(left, 0);
  const topVisible = Math.max(top, 0);
  const rightVisible = Math.min(right, viewportWidth);
  const bottomVisible = Math.min(bottom, viewportHeight);
  const visibleWidth = Math.max(0, rightVisible - leftVisible);
  const visibleHeight = Math.max(0, bottomVisible - topVisible);

  if (visibleWidth <= 0 || visibleHeight <= 0) return;

  const canvasX = Math.max(0, Math.round((leftVisible + overscrollX) * dpr));
  const canvasY = Math.max(
    0,
    Math.round(
      renderer.canvas.height - (topVisible + overscrollY + visibleHeight) * dpr,
    ),
  );
  const canvasWidth = Math.min(
    renderer.canvas.width - canvasX,
    Math.ceil(visibleWidth * dpr),
  );
  const canvasHeight = Math.min(
    renderer.canvas.height - canvasY,
    Math.ceil(visibleHeight * dpr),
  );

  if (canvasWidth <= 0 || canvasHeight <= 0) return;

  ensureCanvasCopyTex(renderer, canvasWidth, canvasHeight);
  gl.bindTexture(gl.TEXTURE_2D, renderer._canvasCopyTex);
  gl.copyTexSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    canvasX,
    canvasY,
    canvasWidth,
    canvasHeight,
  );

  const snapshotRect = renderer.snapshotTarget.getBoundingClientRect();
  const docCoordX = leftVisible - snapshotRect.left;
  const docCoordY = topVisible - snapshotRect.top;
  const texCoordX = Math.max(0, Math.round(docCoordX * renderer.scaleFactor));
  const texCoordY = Math.max(0, Math.round(docCoordY * renderer.scaleFactor));
  const texWidth = Math.min(
    renderer.textureWidth - texCoordX,
    Math.ceil(visibleWidth * renderer.scaleFactor),
  );
  const texHeight = Math.min(
    renderer.textureHeight - texCoordY,
    Math.ceil(visibleHeight * renderer.scaleFactor),
  );

  if (texWidth <= 0 || texHeight <= 0) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, renderer._composeFbo);
  gl.viewport(texCoordX, texCoordY, texWidth, texHeight);

  gl.useProgram(renderer._compositeProgram);
  gl.bindVertexArray(renderer._vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, renderer._canvasCopyTex);
  gl.uniform1i(renderer._compositeU.src, 0);
  gl.uniform2f(
    renderer._compositeU.srcRegion,
    canvasWidth / renderer._canvasCopyTexW,
    canvasHeight / renderer._canvasCopyTexH,
  );

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
}

function ensureLensContentTex(
  renderer: AqualensRenderer,
  width: number,
  height: number,
): void {
  const gl = renderer.gl;
  if (!renderer._lensContentTex) {
    renderer._lensContentTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, renderer._lensContentTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  if (width > renderer._lensContentTexW || height > renderer._lensContentTexH) {
    const newW = Math.max(width, renderer._lensContentTexW);
    const newH = Math.max(height, renderer._lensContentTexH);
    gl.bindTexture(gl.TEXTURE_2D, renderer._lensContentTex);
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
    renderer._lensContentTexW = newW;
    renderer._lensContentTexH = newH;
  }
}

/**
 * After flattening a group's glass effect into the compose FBO, paint each
 * lens's cached html2canvas DOM-content snapshot on top so that higher
 * stacking groups can refract / blur the lens contents through their own
 * glass effect. This is what gives the user-visible behaviour: a lens at
 * stackingIndex N refracts both the glass AND the DOM content of every
 * lens with stackingIndex < N that overlaps with it.
 */
export function compositeLensContentToCompose(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  snapRect: DOMRect,
): void {
  const gl = renderer.gl;
  if (!renderer._composeFbo || !renderer._composeTex) return;
  if (lenses.length === 0) return;

  let anyDrawn = false;
  let programBound = false;

  for (const lens of lenses) {
    if (!lens._contentCapture) continue;
    const rect = lens.rectPx;
    if (!rect) continue;

    const texX = Math.round((rect.left - snapRect.left) * renderer.scaleFactor);
    const texY = Math.round((rect.top - snapRect.top) * renderer.scaleFactor);
    const texW = Math.round(rect.width * renderer.scaleFactor);
    const texH = Math.round(rect.height * renderer.scaleFactor);

    if (texW <= 0 || texH <= 0) continue;
    if (texX + texW <= 0 || texY + texH <= 0) continue;
    if (texX >= renderer.textureWidth || texY >= renderer.textureHeight)
      continue;

    const captureW = lens._contentCapture.width;
    const captureH = lens._contentCapture.height;
    if (captureW <= 0 || captureH <= 0) continue;

    ensureLensContentTex(renderer, captureW, captureH);

    gl.bindTexture(gl.TEXTURE_2D, renderer._lensContentTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      lens._contentCapture,
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
    gl.bindTexture(gl.TEXTURE_2D, renderer._lensContentTex);
    gl.uniform1i(renderer._compositeU.src, 0);
    gl.uniform2f(
      renderer._compositeU.srcRegion,
      captureW / renderer._lensContentTexW,
      captureH / renderer._lensContentTexH,
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    anyDrawn = true;
  }

  if (anyDrawn) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }
}

/** Visual-viewport overscroll offset shared by both copy paths. */
function getOverscroll(): { x: number; y: number } {
  if (window.visualViewport) {
    return {
      x: window.visualViewport.offsetLeft,
      y: window.visualViewport.offsetTop,
    };
  }
  return { x: 0, y: 0 };
}

/**
 * Single-lens copy: source rect on the private canvas is `lens.rectPx`
 * (CSS pixels) plus shadow padding on every side, scaled to device
 * pixels. Destination on the public canvas matches the canvas's full
 * backing-store dimensions.
 */
function copySingleLensRegionToPublicCanvas(
  renderer: AqualensRenderer,
  lens: AqualensLens,
  dpr: number,
  overscrollX: number,
  overscrollY: number,
): void {
  const rect = lens.rectPx;
  if (!rect || rect.width <= 0 || rect.height <= 0) return;

  lens._syncPublicCanvasSize();
  const target = lens.publicCanvas;
  const ctx = lens.publicCtx;
  if (target.width === 0 || target.height === 0) return;

  const shadowPad = lens.computeShadowPad();
  const cssLeft = rect.left - shadowPad + overscrollX;
  const cssTop = rect.top - shadowPad + overscrollY;
  const cssWidth = rect.width + 2 * shadowPad;
  const cssHeight = rect.height + 2 * shadowPad;

  // Source coordinates on the WebGL canvas. drawImage uses top-left
  // origin for both source and destination, so we don't need to deal
  // with the GL bottom-left convention here — the WebGL backing store
  // is sampled top-down.
  const sx = Math.round(cssLeft * dpr);
  const sy = Math.round(cssTop * dpr);
  const sw = Math.max(1, Math.round(cssWidth * dpr));
  const sh = Math.max(1, Math.round(cssHeight * dpr));

  ctx.clearRect(0, 0, target.width, target.height);

  // Clip the source rect to the WebGL canvas; offset destination
  // accordingly so the pixels land at the right spot inside the public
  // canvas (which mirrors the full lens+shadowPad area).
  const srcX = Math.max(0, sx);
  const srcY = Math.max(0, sy);
  const srcRight = Math.min(renderer.canvas.width, sx + sw);
  const srcBottom = Math.min(renderer.canvas.height, sy + sh);
  const srcW = srcRight - srcX;
  const srcH = srcBottom - srcY;
  if (srcW <= 0 || srcH <= 0) return;

  const dstX = srcX - sx;
  const dstY = srcY - sy;

  try {
    ctx.drawImage(
      renderer.canvas,
      srcX,
      srcY,
      srcW,
      srcH,
      dstX,
      dstY,
      srcW,
      srcH,
    );
    lens._disableStartupFallback();
  } catch {
    // Source/destination canvas was zero-sized or otherwise invalid —
    // skip silently and let the next frame retry.
  }
}

/** Merge-bbox padding mirror of `flattenGroupToCompose` / `computeMergedGroupLayout`. */
const MERGE_BBOX_EXTRA_CSS = 30 + 10;

/**
 * Merged-group copy: every lens in the group receives an identical
 * canvas sized to the group's padded union bbox, painted with the full
 * merged-blob render. We then clear the document-space rectangle of
 * every lens that precedes this one in DOM order, so the upper lens's
 * canvas is transparent over those areas and never paints over the
 * lower lens's children (text, badges, etc.) inside its stacking
 * context.
 *
 * Bridge pixels (between two non-overlapping rects) live inside the
 * union bbox but outside any single lens rect, so they are never
 * cleared and remain visible on whichever canvas is on top — the merged
 * shape now reads as one continuous blob across all member lenses.
 */
function copyMergedGroupToPublicCanvases(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  dpr: number,
  overscrollX: number,
  overscrollY: number,
): void {
  // Compute the padded union bbox in viewport CSS coords. Mirrors the
  // padding rules used by `renderMergedGroup` / `flattenGroupToCompose`
  // so the canvas covers exactly the rendered shape.
  let unionLeft = Infinity;
  let unionTop = Infinity;
  let unionRight = -Infinity;
  let unionBottom = -Infinity;
  let maxShadowPad = 0;
  for (const lens of lenses) {
    const rect = lens.rectPx;
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    if (rect.left < unionLeft) unionLeft = rect.left;
    if (rect.top < unionTop) unionTop = rect.top;
    if (rect.left + rect.width > unionRight)
      unionRight = rect.left + rect.width;
    if (rect.top + rect.height > unionBottom)
      unionBottom = rect.top + rect.height;
    const sp = lens.computeShadowPad();
    if (sp > maxShadowPad) maxShadowPad = sp;
  }
  if (!isFinite(unionLeft)) return;

  const padding = Math.max(MERGE_BBOX_EXTRA_CSS, maxShadowPad);
  unionLeft -= padding;
  unionTop -= padding;
  unionRight += padding;
  unionBottom += padding;
  const unionWidth = unionRight - unionLeft;
  const unionHeight = unionBottom - unionTop;

  // Sort by DOM order so we know which lenses paint underneath this
  // one and need to be cleared from the upper canvas. Items earlier in
  // the sorted array paint first.
  const sortedByDom = lenses.slice().sort((a, b) => {
    const cmp = a.element.compareDocumentPosition(b.element);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  // Source-rect clamp on the WebGL canvas, computed once per group.
  const sx = Math.round((unionLeft + overscrollX) * dpr);
  const sy = Math.round((unionTop + overscrollY) * dpr);
  const sw = Math.max(1, Math.round(unionWidth * dpr));
  const sh = Math.max(1, Math.round(unionHeight * dpr));
  const srcX = Math.max(0, sx);
  const srcY = Math.max(0, sy);
  const srcRight = Math.min(renderer.canvas.width, sx + sw);
  const srcBottom = Math.min(renderer.canvas.height, sy + sh);
  const srcW = srcRight - srcX;
  const srcH = srcBottom - srcY;
  const hasSourcePixels = srcW > 0 && srcH > 0;
  const dstX = srcX - sx;
  const dstY = srcY - sy;

  for (let i = 0; i < sortedByDom.length; i++) {
    const lens = sortedByDom[i];
    const rect = lens.rectPx;
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;

    lens._syncPublicCanvasForRegion(
      unionLeft,
      unionTop,
      unionWidth,
      unionHeight,
    );
    const target = lens.publicCanvas;
    const ctx = lens.publicCtx;
    if (target.width === 0 || target.height === 0) continue;

    ctx.clearRect(0, 0, target.width, target.height);

    if (hasSourcePixels) {
      try {
        ctx.drawImage(
          renderer.canvas,
          srcX,
          srcY,
          srcW,
          srcH,
          dstX,
          dstY,
          srcW,
          srcH,
        );
        lens._disableStartupFallback();
      } catch {
        // Source canvas momentarily invalid — let the next frame retry.
      }
    }

    // Erase rectangles of lenses that precede this one in DOM order.
    // Without this step the upper lens's canvas would paint the merged
    // blob (and shadow) on top of every prior lens's stacking context,
    // hiding their children. Clearing makes those areas fully
    // transparent on the upper canvas so the prior lens's own canvas
    // and DOM content show through naturally.
    for (let j = 0; j < i; j++) {
      const prior = sortedByDom[j];
      const priorRect = prior.rectPx;
      if (!priorRect || priorRect.width <= 0 || priorRect.height <= 0) continue;
      const cx = (priorRect.left - unionLeft) * dpr;
      const cy = (priorRect.top - unionTop) * dpr;
      const cw = priorRect.width * dpr;
      const ch = priorRect.height * dpr;
      ctx.clearRect(cx, cy, cw, ch);
    }
  }
}

/**
 * For every lens in a freshly-rendered group, copy the relevant region
 * of the private WebGL canvas into the lens's `publicCanvas` (a 2D
 * canvas sitting inside the lens DOM). After this call returns, the
 * user sees the new pixels.
 *
 * Single-lens groups use the lens's own rect + shadowPad as the canvas
 * region. Multi-lens (merged) groups share the same padded union bbox
 * across all lenses' canvases, plus a per-canvas clear-pass that
 * subtracts the rectangles of DOM-earlier siblings so the upper lens
 * never overpaints lower lenses' children inside their stacking
 * contexts.
 */
export function copyLensRegionsToPublicCanvases(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  dpr: number,
): void {
  if (lenses.length === 0) return;

  // Make sure GPU-side rendering is flushed so subsequent `drawImage` of
  // the WebGL canvas sees the new pixels (some browsers otherwise read
  // stale contents).
  renderer.gl.flush();

  const overscroll = getOverscroll();

  if (lenses.length === 1) {
    copySingleLensRegionToPublicCanvas(
      renderer,
      lenses[0],
      dpr,
      overscroll.x,
      overscroll.y,
    );
    return;
  }

  copyMergedGroupToPublicCanvases(
    renderer,
    lenses,
    dpr,
    overscroll.x,
    overscroll.y,
  );
}
