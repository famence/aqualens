import type { AqualensRenderer } from "./renderer";
import type { AqualensLens } from "./lens";
import { createFBO, type BlurPyramidLevel } from "./gl-utils";

const MAX_BLUR_LEVELS = 7;

export function ensureBlurPyramid(renderer: AqualensRenderer): void {
  if (renderer._blurLevelCount === 0) return;
  if (!renderer.texture || renderer.textureWidth === 0 || renderer.textureHeight === 0) return;

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
  if (
    !renderer.texture ||
    renderer._blurPyramid.length === 0
  ) return;

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
    gl.uniform2f(renderer._kawaseUpU.halfPixel, 0.5 / srcLevel.w, 0.5 / srcLevel.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
}

export function ensureComposeFbo(renderer: AqualensRenderer): void {
  const width = renderer.textureWidth;
  const height = renderer.textureHeight;
  if (width === 0 || height === 0) return;
  if (renderer._composeFbo && renderer._composeFboW === width && renderer._composeFboH === height) return;

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

export function flattenGroupToCompose(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  dpr: number,
): void {
  const gl = renderer.gl;
  if (!renderer._composeFbo || !renderer._composeTex) return;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const lens of lenses) {
    const rect = lens.rectPx;
    if (!rect) continue;
    const shadowParams = lens.shadowParams;
    const hasShadow = shadowParams != null && shadowParams.color.a > 0;
    const shadowPad = hasShadow
      ? Math.max(Math.abs(shadowParams!.offsetX), Math.abs(shadowParams!.offsetY)) +
        shadowParams!.blur +
        Math.abs(shadowParams!.spread) +
        5
      : 0;
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
    Math.round(renderer.canvas.height - (topVisible + overscrollY + visibleHeight) * dpr),
  );
  const canvasWidth = Math.min(renderer.canvas.width - canvasX, Math.ceil(visibleWidth * dpr));
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
