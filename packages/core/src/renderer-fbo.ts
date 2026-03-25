import type { AqualensRenderer } from "./renderer";
import type { AqualensLens } from "./lens";
import { computeGaussianKernel, createFBO } from "./gl-utils";

const BLUR_MAX_SHADER_RADIUS = 50;

export function ensureBlurFBOs(renderer: AqualensRenderer): void {
  if (renderer._currentBlurRadius === 0) return;
  if (!renderer.texture || renderer.textureWidth === 0 || renderer.textureHeight === 0) return;

  const downsample = renderer._blurDownsample;
  const width = Math.max(1, Math.ceil(renderer.textureWidth / downsample));
  const height = Math.max(1, Math.ceil(renderer.textureHeight / downsample));

  if (renderer._fboA && renderer._blurFboW === width && renderer._blurFboH === height) return;

  destroyBlurFBOs(renderer);

  const fboA = createFBO(renderer.gl, width, height);
  const fboB = createFBO(renderer.gl, width, height);
  renderer._fboA = fboA.fbo;
  renderer._fboATexture = fboA.tex;
  renderer._fboB = fboB.fbo;
  renderer._fboBTexture = fboB.tex;
  renderer._blurFboW = width;
  renderer._blurFboH = height;
}

export function destroyBlurFBOs(renderer: AqualensRenderer): void {
  const gl = renderer.gl;
  if (renderer._fboA) gl.deleteFramebuffer(renderer._fboA);
  if (renderer._fboATexture) gl.deleteTexture(renderer._fboATexture);
  if (renderer._fboB) gl.deleteFramebuffer(renderer._fboB);
  if (renderer._fboBTexture) gl.deleteTexture(renderer._fboBTexture);
  renderer._fboA = renderer._fboATexture = null;
  renderer._fboB = renderer._fboBTexture = null;
  renderer._blurredForTextureVersion = -1;
  renderer._blurFboW = renderer._blurFboH = 0;
}

export function updateBlurKernel(renderer: AqualensRenderer): void {
  let maxRadius = 0;
  for (const lens of renderer.lenses) {
    if (lens.options.blurRadius > maxRadius)
      maxRadius = lens.options.blurRadius;
  }
  maxRadius = Math.min(200, Math.max(0, Math.round(maxRadius)));
  if (maxRadius !== renderer._currentBlurRadius) {
    renderer._currentBlurRadius = maxRadius;
    if (maxRadius === 0) {
      destroyBlurFBOs(renderer);
      renderer._blurDownsample = 1;
      renderer._blurScaledRadius = 0;
    } else {
      const MAX_R = BLUR_MAX_SHADER_RADIUS;
      let downsample = 1;
      if (maxRadius > MAX_R * 2) downsample = 4;
      else if (maxRadius > MAX_R) downsample = 2;
      renderer._blurDownsample = downsample;
      renderer._blurScaledRadius = Math.min(MAX_R, Math.ceil(maxRadius / downsample));
      renderer._blurWeights = computeGaussianKernel(renderer._blurScaledRadius);
    }
  }
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

export function runBlurPasses(
  renderer: AqualensRenderer,
  sourceTexture?: WebGLTexture,
): void {
  if (
    !renderer.texture ||
    !renderer._fboA ||
    !renderer._fboB ||
    !renderer._fboATexture ||
    !renderer._fboBTexture
  )
    return;

  const gl = renderer.gl;
  const blurWidth = renderer._blurFboW;
  const blurHeight = renderer._blurFboH;

  gl.bindVertexArray(renderer._vao);

  gl.bindFramebuffer(gl.FRAMEBUFFER, renderer._fboA);
  gl.viewport(0, 0, blurWidth, blurHeight);
  gl.useProgram(renderer._hblurProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sourceTexture || renderer.texture);
  gl.uniform1i(renderer._hblurU.inputTex, 0);
  gl.uniform2f(renderer._hblurU.texSize, blurWidth, blurHeight);
  gl.uniform1i(renderer._hblurU.blurRadius, renderer._blurScaledRadius);
  gl.uniform1fv(renderer._hblurU.blurWeights, renderer._blurWeights);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.bindFramebuffer(gl.FRAMEBUFFER, renderer._fboB);
  gl.useProgram(renderer._vblurProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, renderer._fboATexture);
  gl.uniform1i(renderer._vblurU.inputTex, 0);
  gl.uniform2f(renderer._vblurU.texSize, blurWidth, blurHeight);
  gl.uniform1i(renderer._vblurU.blurRadius, renderer._blurScaledRadius);
  gl.uniform1fv(renderer._vblurU.blurWeights, renderer._blurWeights);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
}
