import type { AqualensRenderer } from "./renderer";
import type { AqualensLens } from "./lens";

export const MAX_SHAPES = 8;

function setMainViewportAndBounds(
  renderer: AqualensRenderer,
  viewportX: number,
  viewportY: number,
  viewportWidth: number,
  viewportHeight: number,
  left: number,
  top: number,
  width: number,
  height: number,
  snapRect: DOMRect,
): void {
  const gl = renderer.gl;
  gl.viewport(viewportX, viewportY, viewportWidth, viewportHeight);
  gl.useProgram(renderer._mainProgram);
  gl.bindVertexArray(renderer._vao);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, renderer._activeSourceTex || renderer.texture);
  gl.uniform1i(renderer._mainU.tex, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(
    gl.TEXTURE_2D,
    renderer._currentBlurRadius > 0 && renderer._blurResultTex
      ? renderer._blurResultTex
      : renderer._activeSourceTex || renderer.texture,
  );
  gl.uniform1i(renderer._mainU.blurredTex, 1);

  gl.uniform2f(renderer._mainU.resolution, viewportWidth, viewportHeight);
  const docX = left - snapRect.left;
  const docY = top - snapRect.top;
  const leftUV = (docX * renderer.scaleFactor) / renderer.textureWidth;
  const topUV = (docY * renderer.scaleFactor) / renderer.textureHeight;
  const widthUV = (width * renderer.scaleFactor) / renderer.textureWidth;
  const heightUV = (height * renderer.scaleFactor) / renderer.textureHeight;
  gl.uniform4f(renderer._mainU.bounds, leftUV, topUV, widthUV, heightUV);
  if (renderer._mainU.texSize) {
    gl.uniform2f(
      renderer._mainU.texSize,
      renderer.textureWidth,
      renderer.textureHeight,
    );
  }
}

function setMaterialUniforms(
  renderer: AqualensRenderer,
  lens: AqualensLens,
): void {
  const gl = renderer.gl;
  const options = lens.options;
  const refraction = options.refraction;
  const glare = options.glare;
  gl.uniform1f(renderer._mainU.refThickness, refraction.thickness);
  gl.uniform1f(renderer._mainU.refFactor, refraction.factor);
  gl.uniform1f(renderer._mainU.refDispersion, refraction.dispersion);
  gl.uniform1f(renderer._mainU.refFresnelRange, refraction.fresnelRange);
  gl.uniform1f(
    renderer._mainU.refFresnelHardness,
    refraction.fresnelHardness / 100,
  );
  gl.uniform1f(
    renderer._mainU.refFresnelFactor,
    refraction.fresnelFactor / 100,
  );
  gl.uniform1f(renderer._mainU.glareRange, glare.range);
  gl.uniform1f(renderer._mainU.glareHardness, glare.hardness / 100);
  gl.uniform1f(renderer._mainU.glareFactor, glare.factor / 100);
  gl.uniform1f(renderer._mainU.glareConvergence, glare.convergence / 100);
  gl.uniform1f(renderer._mainU.glareOppositeFactor, glare.oppositeFactor / 100);
  gl.uniform1f(renderer._mainU.glareAngle, (glare.angle * Math.PI) / 180);
  gl.uniform1i(renderer._mainU.blurEdge, options.blurEdge ? 1 : 0);
  gl.uniform4f(
    renderer._mainU.tint,
    options.tint.r / 255,
    options.tint.g / 255,
    options.tint.b / 255,
    options.tint.a,
  );
  const blurAmount =
    renderer._currentBlurRadius > 0
      ? Math.min(1, options.blurRadius / renderer._currentBlurRadius)
      : 0;
  gl.uniform1f(renderer._mainU.blurAmount, blurAmount);
}

function setShapeMaterialUniforms(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
): void {
  const data = renderer._scratchMaterialData;
  data.fill(0);
  const maxBlur = renderer._currentBlurRadius;

  for (let index = 0; index < Math.min(lenses.length, MAX_SHAPES); index++) {
    const options = lenses[index].options;
    const base = index * 16;
    const refraction = options.refraction;
    const glare = options.glare;

    data[base] = options.tint.r / 255;
    data[base + 1] = options.tint.g / 255;
    data[base + 2] = options.tint.b / 255;
    data[base + 3] = options.tint.a;

    data[base + 4] =
      maxBlur > 0 ? Math.min(1, options.blurRadius / maxBlur) : 0;
    data[base + 5] = options.blurEdge ? 1.0 : 0.0;
    data[base + 6] = refraction.thickness;
    data[base + 7] = refraction.factor;

    data[base + 8] = refraction.dispersion;
    data[base + 9] = refraction.fresnelRange;
    data[base + 10] = refraction.fresnelHardness / 100;
    data[base + 11] = refraction.fresnelFactor / 100;

    data[base + 12] = glare.range;
    data[base + 13] = glare.hardness / 100;
    data[base + 14] = glare.factor / 100;
    data[base + 15] = glare.convergence / 100;
  }

  renderer.gl.uniform4fv(renderer._mainU.shapeMaterials, data);
}

function setShadowShapeUniforms(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  dpr: number,
): void {
  const data = renderer._scratchShadowShapes;
  data.fill(0);
  for (let index = 0; index < Math.min(lenses.length, MAX_SHAPES); index++) {
    const shadowParams = lenses[index].shadowParams;
    if (!shadowParams || shadowParams.color.a <= 0) continue;
    const base = index * 8;
    data[base] = shadowParams.color.r / 255;
    data[base + 1] = shadowParams.color.g / 255;
    data[base + 2] = shadowParams.color.b / 255;
    data[base + 3] = shadowParams.color.a;
    data[base + 4] = shadowParams.offsetX * dpr;
    data[base + 5] = -shadowParams.offsetY * dpr;
    data[base + 6] = shadowParams.blur * dpr;
    data[base + 7] = shadowParams.spread * dpr;
  }
  renderer.gl.uniform4fv(renderer._mainU.shadowShapes, data);
}

export function renderLens(
  renderer: AqualensRenderer,
  lens: AqualensLens,
  dpr: number,
  snapRect: DOMRect,
  overscrollX: number,
  overscrollY: number,
): void {
  const gl = renderer.gl;
  const rect = lens.rectPx;
  if (!rect) return;

  const shadow = lens.shadowParams;
  const hasShadow = shadow != null && shadow.color.a > 0;
  const shadowPad = hasShadow
    ? Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) +
      shadow.blur +
      Math.abs(shadow.spread) +
      5
    : 0;

  const viewportLeft = rect.left - shadowPad;
  const viewportTop = rect.top - shadowPad;
  const viewportWidthPx = rect.width + 2 * shadowPad;
  const viewportHeightPx = rect.height + 2 * shadowPad;

  const viewportX = Math.round((viewportLeft + overscrollX) * dpr);
  const viewportY = Math.round(
    renderer.canvas.height -
      (viewportTop + overscrollY + viewportHeightPx) * dpr,
  );
  const viewportWidth = Math.ceil(viewportWidthPx * dpr);
  const viewportHeight = Math.ceil(viewportHeightPx * dpr);
  if (viewportWidth < 2 || viewportHeight < 2) return;

  setMainViewportAndBounds(
    renderer,
    viewportX,
    viewportY,
    viewportWidth,
    viewportHeight,
    viewportLeft,
    viewportTop,
    viewportWidthPx,
    viewportHeightPx,
    snapRect,
  );
  gl.uniform1f(renderer._mainU.dpr, dpr);

  if (hasShadow) {
    const shapeData = renderer._scratchShapeData;
    shapeData[0] = (shadowPad + rect.width / 2) * dpr;
    shapeData[1] = (shadowPad + rect.height / 2) * dpr;
    shapeData[2] = (rect.width / 2) * dpr;
    shapeData[3] = (rect.height / 2) * dpr;
    shapeData[4] = lens.radiusGlCorners.tl;
    shapeData[5] = lens.radiusGlCorners.tr;
    shapeData[6] = lens.radiusGlCorners.br;
    shapeData[7] = lens.radiusGlCorners.bl;
    gl.uniform4fv(renderer._mainU.shapes, shapeData);
    gl.uniform1i(renderer._mainU.shapeCount, 1);
    gl.uniform1f(renderer._mainU.mergeK, 0);
    gl.uniform1f(renderer._mainU.radius, 0);
    if (renderer._mainU.radiusCorners) {
      gl.uniform4f(renderer._mainU.radiusCorners, 0, 0, 0, 0);
    }
  } else {
    gl.uniform1f(renderer._mainU.radius, lens.radiusGl);
    if (renderer._mainU.radiusCorners) {
      gl.uniform4f(
        renderer._mainU.radiusCorners,
        lens.radiusGlCorners.tl,
        lens.radiusGlCorners.tr,
        lens.radiusGlCorners.br,
        lens.radiusGlCorners.bl,
      );
    }
    gl.uniform1i(renderer._mainU.shapeCount, 0);
  }

  setMaterialUniforms(renderer, lens);
  setShadowShapeUniforms(renderer, [lens], dpr);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

function setMaskViewport(
  renderer: AqualensRenderer,
  viewportX: number,
  viewportY: number,
  viewportWidth: number,
  viewportHeight: number,
  dpr: number,
): void {
  const gl = renderer.gl;
  gl.viewport(viewportX, viewportY, viewportWidth, viewportHeight);
  gl.useProgram(renderer._maskProgram);
  gl.bindVertexArray(renderer._vao);
  gl.uniform2f(renderer._maskU.resolution, viewportWidth, viewportHeight);
  gl.uniform1f(renderer._maskU.dpr, dpr);
}

/**
 * Draw alpha mask for the lens group (SDF shape only). Caller sets blend for erase.
 */
export function renderGroupMask(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  dpr: number,
  _snapRect: DOMRect,
  overscrollX: number,
  overscrollY: number,
): void {
  const gl = renderer.gl;
  if (lenses.length === 0) return;

  if (lenses.length > MAX_SHAPES) {
    renderGroupMask(
      renderer,
      lenses.slice(0, MAX_SHAPES),
      dpr,
      _snapRect,
      overscrollX,
      overscrollY,
    );
    for (let index = MAX_SHAPES; index < lenses.length; index++) {
      renderGroupMask(
        renderer,
        [lenses[index]!],
        dpr,
        _snapRect,
        overscrollX,
        overscrollY,
      );
    }
    return;
  }

  if (lenses.length === 1) {
    const lens = lenses[0]!;
    const rect = lens.rectPx;
    if (!rect) return;

    const shadow = lens.shadowParams;
    const hasShadow = shadow != null && shadow.color.a > 0;
    const shadowPad = hasShadow
      ? Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) +
        shadow.blur +
        Math.abs(shadow.spread) +
        5
      : 0;

    const viewportLeft = rect.left - shadowPad;
    const viewportTop = rect.top - shadowPad;
    const viewportWidthPx = rect.width + 2 * shadowPad;
    const viewportHeightPx = rect.height + 2 * shadowPad;

    const viewportX = Math.round((viewportLeft + overscrollX) * dpr);
    const viewportY = Math.round(
      renderer.canvas.height -
        (viewportTop + overscrollY + viewportHeightPx) * dpr,
    );
    const viewportWidth = Math.ceil(viewportWidthPx * dpr);
    const viewportHeight = Math.ceil(viewportHeightPx * dpr);
    if (viewportWidth < 2 || viewportHeight < 2) return;

    setMaskViewport(
      renderer,
      viewportX,
      viewportY,
      viewportWidth,
      viewportHeight,
      dpr,
    );

    if (hasShadow) {
      const shapeData = renderer._scratchShapeData;
      shapeData[0] = (shadowPad + rect.width / 2) * dpr;
      shapeData[1] = (shadowPad + rect.height / 2) * dpr;
      shapeData[2] = (rect.width / 2) * dpr;
      shapeData[3] = (rect.height / 2) * dpr;
      shapeData[4] = lens.radiusGlCorners.tl;
      shapeData[5] = lens.radiusGlCorners.tr;
      shapeData[6] = lens.radiusGlCorners.br;
      shapeData[7] = lens.radiusGlCorners.bl;
      gl.uniform4fv(renderer._maskU.shapes, shapeData);
      gl.uniform1i(renderer._maskU.shapeCount, 1);
      gl.uniform1f(renderer._maskU.mergeK, 0);
      gl.uniform1f(renderer._maskU.radius, 0);
      if (renderer._maskU.radiusCorners) {
        gl.uniform4f(renderer._maskU.radiusCorners, 0, 0, 0, 0);
      }
    } else {
      gl.uniform1f(renderer._maskU.radius, lens.radiusGl);
      if (renderer._maskU.radiusCorners) {
        gl.uniform4f(
          renderer._maskU.radiusCorners,
          lens.radiusGlCorners.tl,
          lens.radiusGlCorners.tr,
          lens.radiusGlCorners.br,
          lens.radiusGlCorners.bl,
        );
      }
      gl.uniform1i(renderer._maskU.shapeCount, 0);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    return;
  }

  let unionLeft = Infinity;
  let unionTop = Infinity;
  let unionRight = -Infinity;
  let unionBottom = -Infinity;
  for (const lens of lenses) {
    const rect = lens.rectPx;
    if (!rect || rect.width < 2 || rect.height < 2) continue;
    unionLeft = Math.min(unionLeft, rect.left);
    unionTop = Math.min(unionTop, rect.top);
    unionRight = Math.max(unionRight, rect.left + rect.width);
    unionBottom = Math.max(unionBottom, rect.top + rect.height);
  }
  if (!isFinite(unionLeft)) return;

  let maxShadowPad = 0;
  for (const lens of lenses) {
    const shadowParams = lens.shadowParams;
    if (shadowParams && shadowParams.color.a > 0) {
      const lensShadowPadding =
        Math.max(
          Math.abs(shadowParams.offsetX),
          Math.abs(shadowParams.offsetY),
        ) +
        shadowParams.blur +
        Math.abs(shadowParams.spread) +
        5;
      maxShadowPad = Math.max(maxShadowPad, lensShadowPadding);
    }
  }
  const shadowPad = maxShadowPad;

  const MERGE_RADIUS_CSS = 30;
  const padding = Math.max(MERGE_RADIUS_CSS + 10, shadowPad);
  unionLeft -= padding;
  unionTop -= padding;
  unionRight += padding;
  unionBottom += padding;

  const unionWidth = unionRight - unionLeft;
  const unionHeight = unionBottom - unionTop;

  const viewportX = Math.round((unionLeft + overscrollX) * dpr);
  const viewportY = Math.round(
    renderer.canvas.height - (unionTop + overscrollY + unionHeight) * dpr,
  );
  const viewportWidth = Math.ceil(unionWidth * dpr);
  const viewportHeight = Math.ceil(unionHeight * dpr);
  if (viewportWidth < 2 || viewportHeight < 2) return;

  setMaskViewport(
    renderer,
    viewportX,
    viewportY,
    viewportWidth,
    viewportHeight,
    dpr,
  );

  const shapeData = renderer._scratchShapeData;
  for (let index = 0; index < lenses.length; index++) {
    const lens = lenses[index]!;
    const rect = lens.rectPx!;
    const base = index * 8;
    shapeData[base] = (rect.left - unionLeft + rect.width / 2) * dpr;
    shapeData[base + 1] = (unionBottom - (rect.top + rect.height / 2)) * dpr;
    shapeData[base + 2] = (rect.width / 2) * dpr;
    shapeData[base + 3] = (rect.height / 2) * dpr;
    const radiusCorners = lens.radiusGlCorners;
    shapeData[base + 4] = radiusCorners.tl;
    shapeData[base + 5] = radiusCorners.tr;
    shapeData[base + 6] = radiusCorners.br;
    shapeData[base + 7] = radiusCorners.bl;
  }
  gl.uniform4fv(renderer._maskU.shapes, shapeData);

  const mergeSmoothness = MERGE_RADIUS_CSS / unionHeight;
  gl.uniform1i(renderer._maskU.shapeCount, lenses.length);
  gl.uniform1f(renderer._maskU.mergeK, mergeSmoothness);

  gl.uniform1f(renderer._maskU.radius, 0);
  if (renderer._maskU.radiusCorners) {
    gl.uniform4f(renderer._maskU.radiusCorners, 0, 0, 0, 0);
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

export function renderMergedGroup(
  renderer: AqualensRenderer,
  lenses: AqualensLens[],
  dpr: number,
  snapRect: DOMRect,
  overscrollX: number,
  overscrollY: number,
): void {
  const gl = renderer.gl;

  if (lenses.length > MAX_SHAPES) {
    renderMergedGroup(
      renderer,
      lenses.slice(0, MAX_SHAPES),
      dpr,
      snapRect,
      overscrollX,
      overscrollY,
    );
    for (let index = MAX_SHAPES; index < lenses.length; index++) {
      renderLens(
        renderer,
        lenses[index],
        dpr,
        snapRect,
        overscrollX,
        overscrollY,
      );
    }
    return;
  }

  let unionLeft = Infinity;
  let unionTop = Infinity;
  let unionRight = -Infinity;
  let unionBottom = -Infinity;
  for (const lens of lenses) {
    const rect = lens.rectPx;
    if (!rect || rect.width < 2 || rect.height < 2) continue;
    unionLeft = Math.min(unionLeft, rect.left);
    unionTop = Math.min(unionTop, rect.top);
    unionRight = Math.max(unionRight, rect.left + rect.width);
    unionBottom = Math.max(unionBottom, rect.top + rect.height);
  }
  if (!isFinite(unionLeft)) return;

  let maxShadowPad = 0;
  for (const lens of lenses) {
    const shadowParams = lens.shadowParams;
    if (shadowParams && shadowParams.color.a > 0) {
      const lensShadowPadding =
        Math.max(
          Math.abs(shadowParams.offsetX),
          Math.abs(shadowParams.offsetY),
        ) +
        shadowParams.blur +
        Math.abs(shadowParams.spread) +
        5;
      maxShadowPad = Math.max(maxShadowPad, lensShadowPadding);
    }
  }
  const shadowPad = maxShadowPad;

  const MERGE_RADIUS_CSS = 30;
  const padding = Math.max(MERGE_RADIUS_CSS + 10, shadowPad);
  unionLeft -= padding;
  unionTop -= padding;
  unionRight += padding;
  unionBottom += padding;

  const unionWidth = unionRight - unionLeft;
  const unionHeight = unionBottom - unionTop;

  const viewportX = Math.round((unionLeft + overscrollX) * dpr);
  const viewportY = Math.round(
    renderer.canvas.height - (unionTop + overscrollY + unionHeight) * dpr,
  );
  const viewportWidth = Math.ceil(unionWidth * dpr);
  const viewportHeight = Math.ceil(unionHeight * dpr);
  if (viewportWidth < 2 || viewportHeight < 2) return;

  setMainViewportAndBounds(
    renderer,
    viewportX,
    viewportY,
    viewportWidth,
    viewportHeight,
    unionLeft,
    unionTop,
    unionWidth,
    unionHeight,
    snapRect,
  );
  gl.uniform1f(renderer._mainU.dpr, dpr);

  const shapeData = renderer._scratchShapeData;
  for (let index = 0; index < lenses.length; index++) {
    const lens = lenses[index];
    const rect = lens.rectPx!;
    const base = index * 8;
    shapeData[base] = (rect.left - unionLeft + rect.width / 2) * dpr;
    shapeData[base + 1] = (unionBottom - (rect.top + rect.height / 2)) * dpr;
    shapeData[base + 2] = (rect.width / 2) * dpr;
    shapeData[base + 3] = (rect.height / 2) * dpr;
    const radiusCorners = lens.radiusGlCorners;
    shapeData[base + 4] = radiusCorners.tl;
    shapeData[base + 5] = radiusCorners.tr;
    shapeData[base + 6] = radiusCorners.br;
    shapeData[base + 7] = radiusCorners.bl;
  }
  gl.uniform4fv(renderer._mainU.shapes, shapeData);

  const mergeSmoothness = MERGE_RADIUS_CSS / unionHeight;
  gl.uniform1i(renderer._mainU.shapeCount, lenses.length);
  gl.uniform1f(renderer._mainU.mergeK, mergeSmoothness);

  gl.uniform1f(renderer._mainU.radius, 0);
  if (renderer._mainU.radiusCorners) {
    gl.uniform4f(renderer._mainU.radiusCorners, 0, 0, 0, 0);
  }

  setMaterialUniforms(renderer, lenses[0]);
  setShapeMaterialUniforms(renderer, lenses);
  setShadowShapeUniforms(renderer, lenses, dpr);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}
