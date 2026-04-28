export const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const KAWASE_DOWN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_halfPixel;
out vec4 fragColor;
void main() {
  vec4 sum = texture(u_tex, v_uv) * 4.0;
  sum += texture(u_tex, v_uv - u_halfPixel);
  sum += texture(u_tex, v_uv + u_halfPixel);
  sum += texture(u_tex, v_uv + vec2(u_halfPixel.x, -u_halfPixel.y));
  sum += texture(u_tex, v_uv - vec2(u_halfPixel.x, -u_halfPixel.y));
  fragColor = sum / 8.0;
}`;

export const KAWASE_UP_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_halfPixel;
out vec4 fragColor;
void main() {
  vec4 sum =
    texture(u_tex, v_uv + vec2(-u_halfPixel.x * 2.0, 0.0)) +
    texture(u_tex, v_uv + vec2(-u_halfPixel.x, u_halfPixel.y)) * 2.0 +
    texture(u_tex, v_uv + vec2(0.0, u_halfPixel.y * 2.0)) +
    texture(u_tex, v_uv + vec2(u_halfPixel.x, u_halfPixel.y)) * 2.0 +
    texture(u_tex, v_uv + vec2(u_halfPixel.x * 2.0, 0.0)) +
    texture(u_tex, v_uv + vec2(u_halfPixel.x, -u_halfPixel.y)) * 2.0 +
    texture(u_tex, v_uv + vec2(0.0, -u_halfPixel.y * 2.0)) +
    texture(u_tex, v_uv + vec2(-u_halfPixel.x, -u_halfPixel.y)) * 2.0;
  fragColor = sum / 12.0;
}`;

export const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_srcRegion;
out vec4 fragColor;
void main() {
  vec2 uv = vec2(v_uv.x * u_srcRegion.x, (1.0 - v_uv.y) * u_srcRegion.y);
  fragColor = texture(u_src, uv);
}`;

/** Alpha mask for opaque overlap: 1 inside lens shape(s), 0 outside (anti-aliased). */
export const MASK_FRAGMENT = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform vec2 u_resolution;
uniform float u_dpr;
uniform float u_radius;
uniform vec4 u_radiusCorners;

#define MAX_MERGE_SHAPES 8
uniform int u_shapeCount;
uniform float u_mergeK;
uniform vec4 u_shapes[MAX_MERGE_SHAPES * 2];

out vec4 fragColor;

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(a, b, h) - k * h * (1.0 - h);
}

float sdRoundBoxPerCorner(vec2 p, vec2 b, vec4 corners) {
  vec4 r = vec4(corners.y, corners.z, corners.x, corners.w);
  r.xy = (p.x > 0.0) ? r.xy : r.zw;
  float radius = (p.y > 0.0) ? r.x : r.y;
  vec2 q = abs(p) - b + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float sdfShape(vec2 fc, int idx) {
  vec4 posSize = u_shapes[idx * 2];
  vec4 corners = u_shapes[idx * 2 + 1];
  vec2 center = posSize.xy;
  vec2 halfSize = posSize.zw;
  vec2 p = (fc - center) / u_resolution.y;
  vec2 hs = halfSize / u_resolution.y;
  float maxAllowed = min(hs.x, hs.y);
  vec4 r = clamp(corners / u_resolution.y, 0.0, maxAllowed);
  return sdRoundBoxPerCorner(p, hs, r);
}

float mainSDF(vec2 fc) {
  if (u_shapeCount >= 1) {
    float d = sdfShape(fc, 0);
    for (int i = 1; i < MAX_MERGE_SHAPES; i++) {
      if (i >= u_shapeCount) break;
      d = smin(d, sdfShape(fc, i), u_mergeK);
    }
    return d;
  }
  vec2 p = fc / u_resolution.y;
  vec2 c = u_resolution.xy * 0.5 / u_resolution.y;
  vec2 hs = u_resolution.xy * 0.5 / u_resolution.y;
  vec4 corners = u_radiusCorners;
  if (dot(corners, vec4(1.0)) <= 0.0) {
    corners = vec4(u_radius);
  }
  float maxAllowed = min(hs.x, hs.y);
  vec4 r = clamp(corners / u_resolution.y, 0.0, maxAllowed);
  return sdRoundBoxPerCorner(p - c, hs, r);
}

void main() {
  vec2 localCoord = v_uv * u_resolution;
  float sdf = mainSDF(localCoord);
  // Derivative-based AA keeps the SDF edge around ~1 physical pixel wide.
  // The previous fixed width (2.0 * px) effectively became ~2 CSS px,
  // which looked overly soft on dark semi-transparent tints.
  float edgeWidth = max(fwidth(sdf), 1.0 / u_resolution.y);
  float a = 1.0 - smoothstep(-edgeWidth, edgeWidth, sdf);
  if (a <= 0.0) discard;
  fragColor = vec4(0.0, 0.0, 0.0, a);
}`;

/**
 * Samples a reveal-element capture and outputs it clipped by the lens group's
 * SDF shape. Used to paint `data-aqualens-reveal-mode="on-lens"` reveals on top
 * of the already-rendered lens so the reveal content appears INSIDE the glass.
 *
 * The shader runs in the same viewport as the lens render pass and therefore
 * shares the same SDF uniform layout. `u_revealRect` is the reveal element's
 * bounding box expressed in the same local-pixel space as the SDF (origin at
 * the bottom-left of the viewport, y increasing upward). The reveal texture
 * is uploaded without UNPACK_FLIP_Y, so we flip y when sampling.
 *
 * The refraction block mirrors MAIN_FRAGMENT so the reveal distorts at the
 * glass edges the same way the background behind the lens does — making the
 * reveal look like it lives "inside" the lens instead of being a flat decal.
 * Refraction offsets are computed in "lens-viewport fractions" (to match
 * MAIN's `offLens`) and then rescaled into reveal-rect UV fractions via the
 * viewport/reveal-rect size ratio, so the distortion magnitude is consistent
 * regardless of how large the reveal element is relative to the lens.
 */
export const REVEAL_MASKED_FRAGMENT = `#version 300 es
precision highp float;

const float N_R = 0.98;
const float N_B = 1.02;

in vec2 v_uv;

uniform vec2 u_resolution;
uniform float u_dpr;
uniform float u_radius;
uniform vec4 u_radiusCorners;

#define MAX_MERGE_SHAPES 8
uniform int u_shapeCount;
uniform float u_mergeK;
uniform vec4 u_shapes[MAX_MERGE_SHAPES * 2];

uniform sampler2D u_reveal;
uniform vec2 u_revealRegion;
uniform vec4 u_revealRect;

uniform float u_refThickness;
uniform float u_refFactor;
uniform float u_refZoom;
uniform float u_refDispersion;

out vec4 fragColor;

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(a, b, h) - k * h * (1.0 - h);
}

float sdRoundBoxPerCorner(vec2 p, vec2 b, vec4 corners) {
  vec4 r = vec4(corners.y, corners.z, corners.x, corners.w);
  r.xy = (p.x > 0.0) ? r.xy : r.zw;
  float radius = (p.y > 0.0) ? r.x : r.y;
  vec2 q = abs(p) - b + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float sdfShape(vec2 fc, int idx) {
  vec4 posSize = u_shapes[idx * 2];
  vec4 corners = u_shapes[idx * 2 + 1];
  vec2 center = posSize.xy;
  vec2 halfSize = posSize.zw;
  vec2 p = (fc - center) / u_resolution.y;
  vec2 hs = halfSize / u_resolution.y;
  float maxAllowed = min(hs.x, hs.y);
  vec4 r = clamp(corners / u_resolution.y, 0.0, maxAllowed);
  return sdRoundBoxPerCorner(p, hs, r);
}

float mainSDF(vec2 fc) {
  if (u_shapeCount >= 1) {
    float d = sdfShape(fc, 0);
    for (int i = 1; i < MAX_MERGE_SHAPES; i++) {
      if (i >= u_shapeCount) break;
      d = smin(d, sdfShape(fc, i), u_mergeK);
    }
    return d;
  }
  vec2 p = fc / u_resolution.y;
  vec2 c = u_resolution.xy * 0.5 / u_resolution.y;
  vec2 hs = u_resolution.xy * 0.5 / u_resolution.y;
  vec4 corners = u_radiusCorners;
  if (dot(corners, vec4(1.0)) <= 0.0) {
    corners = vec4(u_radius);
  }
  float maxAllowed = min(hs.x, hs.y);
  vec4 r = clamp(corners / u_resolution.y, 0.0, maxAllowed);
  return sdRoundBoxPerCorner(p - c, hs, r);
}

vec2 getNormal(vec2 fc) {
  if (u_shapeCount <= 1) {
    vec2 p, hs;
    vec4 corners;
    if (u_shapeCount == 1) {
      vec4 posSize = u_shapes[0];
      corners = u_shapes[1];
      p = (fc - posSize.xy) / u_resolution.y;
      hs = posSize.zw / u_resolution.y;
    } else {
      p = fc / u_resolution.y - u_resolution.xy * 0.5 / u_resolution.y;
      hs = u_resolution.xy * 0.5 / u_resolution.y;
      corners = u_radiusCorners;
      if (dot(corners, vec4(1.0)) <= 0.0) corners = vec4(u_radius);
    }
    float maxR = min(hs.x, hs.y);
    vec4 r4 = clamp(corners / u_resolution.y, 0.0, maxR);
    vec4 rr = vec4(r4.y, r4.z, r4.x, r4.w);
    rr.xy = (p.x > 0.0) ? rr.xy : rr.zw;
    float radius = (p.y > 0.0) ? rr.x : rr.y;
    vec2 q = abs(p) - hs + radius;
    vec2 qc = max(q, 0.0);
    float lenQ = length(qc);
    vec2 grad;
    if (lenQ > 0.0001) {
      grad = qc / lenQ;
    } else {
      grad = (q.x > q.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    }
    grad *= sign(p);
    return grad * (1414.213562 / u_resolution.y);
  }
  vec2 h = vec2(max(abs(dFdx(fc.x)), 0.0001), max(abs(dFdy(fc.y)), 0.0001));
  vec2 g = vec2(
    mainSDF(fc + vec2(h.x, 0.0)) - mainSDF(fc - vec2(h.x, 0.0)),
    mainSDF(fc + vec2(0.0, h.y)) - mainSDF(fc - vec2(0.0, h.y))
  ) / (2.0 * h);
  return g * 1414.213562;
}

/**
 * Sample the reveal capture at a given reveal-rect UV. Pixels that fall
 * outside the reveal rectangle contribute nothing (the atlas beyond the
 * capture region is cleared alpha=0 anyway, but an explicit clamp keeps
 * refracted samples from bleeding onto unrelated atlas slots if we ever
 * pack multiple captures into the same texture).
 */
vec4 sampleRevealClamped(vec2 revealUV) {
  if (revealUV.x < 0.0 || revealUV.x > 1.0 ||
      revealUV.y < 0.0 || revealUV.y > 1.0) {
    return vec4(0.0);
  }
  vec2 uv = vec2(revealUV.x * u_revealRegion.x,
                 (1.0 - revealUV.y) * u_revealRegion.y);
  return texture(u_reveal, uv);
}

void main() {
  vec2 localCoord = v_uv * u_resolution;
  float sdf = mainSDF(localCoord);
  float px = u_dpr / u_resolution.y;
  float edgeWidth = max(fwidth(sdf), 1.0 / u_resolution.y);
  float mask = 1.0 - smoothstep(-edgeWidth, edgeWidth, sdf);
  if (mask <= 0.0) discard;

  vec2 baseRevealUV = (localCoord - u_revealRect.xy) / u_revealRect.zw;

  // Refraction offset in "lens viewport fractions" — identical math to MAIN.
  vec2 offLens = vec2(0.0);
  if (u_refThickness > 0.0 && u_refFactor > 0.0 && sdf < 5.0 * px) {
    vec2 res1x = u_resolution / u_dpr;
    float nm = -sdf * res1x.y;
    float xr = 1.0 - nm / u_refThickness;
    float tI = asin(pow(clamp(xr, 0.0, 1.0), 2.0));
    float tT = asin(sin(tI) / 1.5);
    float ef = -tan(tT - tI) * u_refFactor;
    if (nm >= u_refThickness) ef = 0.0;
    if (ef > 0.0) {
      vec2 n = getNormal(localCoord);
      offLens = -n * ef * 0.05 * u_dpr
                * vec2(u_resolution.y / u_resolution.x, 1.0);
    }
  }

  // Rescale the offset from "lens viewport fractions" into "reveal-rect
  // UV fractions". Keeps the displacement magnitude tied to the physical
  // lens even when the reveal element is larger or smaller than the lens.
  vec2 revealOff = offLens * (u_resolution / u_revealRect.zw);

  vec4 color;
  if (u_refDispersion <= 0.001 || revealOff == vec2(0.0)) {
    color = sampleRevealClamped(baseRevealUV + revealOff);
  } else {
    // Chromatic dispersion: shift per-channel sample position, mirroring
    // MAIN's sampleDispersion but in reveal-rect UV space.
    vec4 sampR = sampleRevealClamped(
      baseRevealUV + revealOff * (1.0 - (N_R - 1.0) * u_refDispersion));
    vec4 sampG = sampleRevealClamped(baseRevealUV + revealOff);
    vec4 sampB = sampleRevealClamped(
      baseRevealUV + revealOff * (1.0 - (N_B - 1.0) * u_refDispersion));
    // Alpha is taken from the central sample — the per-channel alphas are
    // all within a sub-pixel of each other, so mixing them would just add
    // noise at text edges.
    color = vec4(sampR.r, sampG.g, sampB.b, sampG.a);
  }

  if (color.a <= 0.0) discard;
  fragColor = color * mask;
}`;

export const MAIN_FRAGMENT = `#version 300 es
precision highp float;

#define PI 3.14159265359

const float N_R = 0.98;
const float N_G = 1.0;
const float N_B = 1.02;

in vec2 v_uv;

uniform sampler2D u_tex;
uniform sampler2D u_blurredTex;
uniform vec2 u_resolution;
uniform float u_dpr;
uniform vec4 u_bounds;
uniform vec2 u_texSize;
uniform float u_radius;
uniform vec4 u_radiusCorners;

uniform float u_refThickness;
uniform float u_refFactor;
uniform float u_refZoom;
uniform float u_refDispersion;
uniform float u_refFresnelRange;
uniform float u_refFresnelHardness;
uniform float u_refFresnelFactor;

uniform float u_glareRange;
uniform float u_glareHardness;
uniform float u_glareFactor;
uniform float u_glareConvergence;
uniform float u_glareOppositeFactor;
uniform float u_glareAngle;

uniform int u_blurEdge;
uniform vec4 u_tint;

#define MAX_MERGE_SHAPES 8
uniform int u_shapeCount;
uniform float u_mergeK;
uniform vec4 u_shapes[MAX_MERGE_SHAPES * 2];

uniform vec4 u_shadowShapes[MAX_MERGE_SHAPES * 2];

uniform float u_blurAmount;
#define MAT_VECS 5
uniform vec4 u_shapeMaterials[MAX_MERGE_SHAPES * MAT_VECS];

out vec4 fragColor;

// ---- SDF ----

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(a, b, h) - k * h * (1.0 - h);
}

float sdRoundBoxPerCorner(vec2 p, vec2 b, vec4 corners) {
  vec4 r = vec4(corners.y, corners.z, corners.x, corners.w);
  r.xy = (p.x > 0.0) ? r.xy : r.zw;
  float radius = (p.y > 0.0) ? r.x : r.y;
  vec2 q = abs(p) - b + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float sdfShape(vec2 fc, int idx) {
  vec4 posSize = u_shapes[idx * 2];
  vec4 corners = u_shapes[idx * 2 + 1];
  vec2 center = posSize.xy;
  vec2 halfSize = posSize.zw;
  vec2 p = (fc - center) / u_resolution.y;
  vec2 hs = halfSize / u_resolution.y;
  float maxAllowed = min(hs.x, hs.y);
  vec4 r = clamp(corners / u_resolution.y, 0.0, maxAllowed);
  return sdRoundBoxPerCorner(p, hs, r);
}

float mainSDF(vec2 fc) {
  if (u_shapeCount >= 1) {
    float d = sdfShape(fc, 0);
    for (int i = 1; i < MAX_MERGE_SHAPES; i++) {
      if (i >= u_shapeCount) break;
      d = smin(d, sdfShape(fc, i), u_mergeK);
    }
    return d;
  }
  vec2 p = fc / u_resolution.y;
  vec2 c = u_resolution.xy * 0.5 / u_resolution.y;
  vec2 hs = u_resolution.xy * 0.5 / u_resolution.y;
  vec4 corners = u_radiusCorners;
  if (dot(corners, vec4(1.0)) <= 0.0) {
    corners = vec4(u_radius);
  }
  float maxAllowed = min(hs.x, hs.y);
  vec4 r = clamp(corners / u_resolution.y, 0.0, maxAllowed);
  return sdRoundBoxPerCorner(p - c, hs, r);
}

vec2 getNormal(vec2 fc) {
  if (u_shapeCount <= 1) {
    vec2 p, hs;
    vec4 corners;
    if (u_shapeCount == 1) {
      vec4 posSize = u_shapes[0];
      corners = u_shapes[1];
      p = (fc - posSize.xy) / u_resolution.y;
      hs = posSize.zw / u_resolution.y;
    } else {
      p = fc / u_resolution.y - u_resolution.xy * 0.5 / u_resolution.y;
      hs = u_resolution.xy * 0.5 / u_resolution.y;
      corners = u_radiusCorners;
      if (dot(corners, vec4(1.0)) <= 0.0) corners = vec4(u_radius);
    }
    float maxR = min(hs.x, hs.y);
    vec4 r4 = clamp(corners / u_resolution.y, 0.0, maxR);
    vec4 rr = vec4(r4.y, r4.z, r4.x, r4.w);
    rr.xy = (p.x > 0.0) ? rr.xy : rr.zw;
    float radius = (p.y > 0.0) ? rr.x : rr.y;
    vec2 q = abs(p) - hs + radius;
    vec2 qc = max(q, 0.0);
    float lenQ = length(qc);
    vec2 grad;
    if (lenQ > 0.0001) {
      grad = qc / lenQ;
    } else {
      grad = (q.x > q.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    }
    grad *= sign(p);
    return grad * (1414.213562 / u_resolution.y);
  }
  vec2 h = vec2(max(abs(dFdx(fc.x)), 0.0001), max(abs(dFdy(fc.y)), 0.0001));
  vec2 g = vec2(
    mainSDF(fc + vec2(h.x, 0.0)) - mainSDF(fc - vec2(h.x, 0.0)),
    mainSDF(fc + vec2(0.0, h.y)) - mainSDF(fc - vec2(0.0, h.y))
  ) / (2.0 * h);
  return g * 1414.213562;
}

// ---- Helpers ----

float vec2ToAngle(vec2 v) {
  float a = atan(v.y, v.x);
  return a < 0.0 ? a + 2.0 * PI : a;
}

vec2 getTexUV(vec2 uv) {
  vec2 boundsSize = u_bounds.zw;
  float viewportAspect = u_resolution.x / max(u_resolution.y, 0.001);
  float texRegionAspect = (boundsSize.x * u_texSize.x) / max(boundsSize.y * u_texSize.y, 0.001);
  vec2 effSize = boundsSize;
  vec2 off = vec2(0.0);
  if (texRegionAspect > viewportAspect) {
    effSize.y = boundsSize.x * u_texSize.x / (u_texSize.y * viewportAspect);
    off.y = (boundsSize.y - effSize.y) * 0.5;
  } else if (texRegionAspect < viewportAspect) {
    effSize.x = boundsSize.y * u_texSize.y * viewportAspect / u_texSize.x;
    off.x = (boundsSize.x - effSize.x) * 0.5;
  }
  return u_bounds.xy + off + vec2(uv.x, 1.0 - uv.y) * effSize;
}

vec2 clampUVToBounds(vec2 uv) {
  vec2 texSize = vec2(textureSize(u_tex, 0));
  vec2 safeTexSize = max(texSize, vec2(1.0));
  vec2 pad = 1.0 / safeTexSize;
  vec2 uvMin = max(u_bounds.xy + pad, vec2(0.0));
  vec2 uvMax = min(u_bounds.xy + u_bounds.zw - pad, vec2(1.0));
  return clamp(uv, uvMin, uvMax);
}

vec4 sampleDispersion(vec2 uv, vec2 offs, float blurMix, float disp) {
  if (disp <= 0.001) {
    vec2 uvC = clampUVToBounds(uv + offs);
    if (blurMix <= 0.001) return vec4(texture(u_tex, uvC).rgb, 1.0);
    return vec4(mix(texture(u_tex, uvC).rgb, texture(u_blurredTex, uvC).rgb, blurMix), 1.0);
  }
  vec2 uvR = clampUVToBounds(uv + offs * (1.0 - (N_R - 1.0) * disp));
  vec2 uvG = clampUVToBounds(uv + offs);
  vec2 uvB = clampUVToBounds(uv + offs * (1.0 - (N_B - 1.0) * disp));

  if (blurMix <= 0.001) {
    return vec4(texture(u_tex, uvR).r, texture(u_tex, uvG).g, texture(u_tex, uvB).b, 1.0);
  }
  float bgR  = texture(u_tex,        uvR).r;
  float bgG  = texture(u_tex,        uvG).g;
  float bgB  = texture(u_tex,        uvB).b;
  float blR  = texture(u_blurredTex, uvR).r;
  float blG  = texture(u_blurredTex, uvG).g;
  float blB  = texture(u_blurredTex, uvB).b;
  return vec4(mix(bgR, blR, blurMix), mix(bgG, blG, blurMix), mix(bgB, blB, blurMix), 1.0);
}

// ---- Material blending ----

struct Material {
  vec4 tint;
  float blurAmount;
  float blurEdge;
  float refThickness;
  float refFactor;
  float refZoom;
  float refDispersion;
  float refFresnelRange;
  float refFresnelHardness;
  float refFresnelFactor;
  float glareRange;
  float glareHardness;
  float glareFactor;
  float glareConvergence;
};

Material loadMaterial(int idx) {
  int b = idx * MAT_VECS;
  vec4 v0 = u_shapeMaterials[b];
  vec4 v1 = u_shapeMaterials[b + 1];
  vec4 v2 = u_shapeMaterials[b + 2];
  vec4 v3 = u_shapeMaterials[b + 3];
  vec4 v4 = u_shapeMaterials[b + 4];
  Material m;
  m.tint = v0;
  m.blurAmount = v1.x;
  m.blurEdge = v1.y;
  m.refThickness = v1.z;
  m.refFactor = v1.w;
  m.refZoom = v2.x;
  m.refDispersion = v2.y;
  m.refFresnelRange = v2.z;
  m.refFresnelHardness = v2.w;
  m.refFresnelFactor = v3.x;
  m.glareRange = v3.y;
  m.glareHardness = v3.z;
  m.glareFactor = v3.w;
  m.glareConvergence = v4.x;
  return m;
}

Material mixMat(Material a, Material b, float t) {
  Material m;
  m.tint = mix(a.tint, b.tint, t);
  m.blurAmount = mix(a.blurAmount, b.blurAmount, t);
  m.blurEdge = mix(a.blurEdge, b.blurEdge, t);
  m.refThickness = mix(a.refThickness, b.refThickness, t);
  m.refFactor = mix(a.refFactor, b.refFactor, t);
  m.refZoom = mix(a.refZoom, b.refZoom, t);
  m.refDispersion = mix(a.refDispersion, b.refDispersion, t);
  m.refFresnelRange = mix(a.refFresnelRange, b.refFresnelRange, t);
  m.refFresnelHardness = mix(a.refFresnelHardness, b.refFresnelHardness, t);
  m.refFresnelFactor = mix(a.refFresnelFactor, b.refFresnelFactor, t);
  m.glareRange = mix(a.glareRange, b.glareRange, t);
  m.glareHardness = mix(a.glareHardness, b.glareHardness, t);
  m.glareFactor = mix(a.glareFactor, b.glareFactor, t);
  m.glareConvergence = mix(a.glareConvergence, b.glareConvergence, t);
  return m;
}

Material globalMat() {
  Material m;
  m.tint = u_tint;
  m.blurAmount = u_blurAmount;
  m.blurEdge = float(u_blurEdge);
  m.refThickness = u_refThickness;
  m.refFactor = u_refFactor;
  m.refZoom = u_refZoom;
  m.refDispersion = u_refDispersion;
  m.refFresnelRange = u_refFresnelRange;
  m.refFresnelHardness = u_refFresnelHardness;
  m.refFresnelFactor = u_refFresnelFactor;
  m.glareRange = u_glareRange;
  m.glareHardness = u_glareHardness;
  m.glareFactor = u_glareFactor;
  m.glareConvergence = u_glareConvergence;
  return m;
}

Material getBlendedMaterial(vec2 fc, out float outSdf) {
  outSdf = mainSDF(fc);
  if (u_shapeCount <= 1) return globalMat();
  Material mat = loadMaterial(0);
  float d = sdfShape(fc, 0);
  for (int i = 1; i < MAX_MERGE_SHAPES; i++) {
    if (i >= u_shapeCount) break;
    float di = sdfShape(fc, i);
    float mk = max(u_mergeK, 0.001);
    float h = clamp(0.5 + 0.5 * (d - di) / mk, 0.0, 1.0);
    d = mix(d, di, h) - mk * h * (1.0 - h);
    float hMat = smoothstep(0.0, 1.0, h);
    mat = mixMat(mat, loadMaterial(i), hMat);
  }
  return mat;
}

// ---- Main ----

void main() {
  vec2 res1x = u_resolution / u_dpr;
  vec2 localCoord = v_uv * u_resolution;
  float px = u_dpr / u_resolution.y;

  vec2 baseUV = clampUVToBounds(getTexUV(v_uv));

  float sdf;
  Material mat = getBlendedMaterial(localCoord, sdf);

  vec4 outColor;

  if (sdf < 5.0 * px) {
    float nm = -sdf * res1x.y;

    float blurFadeZone = mat.refThickness * 2.0;
    float blurEdgeFade = smoothstep(0.0, blurFadeZone, nm);

    float xr = 1.0 - nm / mat.refThickness;
    float tI = asin(pow(clamp(xr, 0.0, 1.0), 2.0));
    float tT = asin(sin(tI) / 1.5);
    float ef = -tan(tT - tI) * mat.refFactor;
    if (nm >= mat.refThickness) ef = 0.0;

    float tintMix = (mat.tint.a >= 0.9999) ? 1.0 : (mat.tint.a * 0.8);
    if (ef <= 0.0) {
      float bm = mix(blurEdgeFade, 1.0, mat.blurEdge) * mat.blurAmount;
      outColor = mix(texture(u_tex, baseUV), texture(u_blurredTex, baseUV), bm);
      outColor = mix(outColor, vec4(mat.tint.rgb, 1.0), tintMix);
    } else {
      vec2 n = getNormal(localCoord);

      vec2 offLens = -n * ef * 0.05 * u_dpr
                     * vec2(u_resolution.y / u_resolution.x, 1.0);
      vec2 texOff = vec2(offLens.x * u_bounds.z, -offLens.y * u_bounds.w);

      float bm = mix(blurEdgeFade, 1.0, mat.blurEdge) * mat.blurAmount;
      outColor = sampleDispersion(baseUV, texOff, bm, mat.refDispersion);

      outColor = mix(outColor, vec4(mat.tint.rgb, 1.0), tintMix);

      if (mat.refFresnelFactor > 0.001) {
        float ff = clamp(
          pow(
            1.0 + sdf * res1x.y / 1500.0 * pow(500.0 / mat.refFresnelRange, 2.0) + mat.refFresnelHardness,
            5.0
          ), 0.0, 1.0
        );
        vec3 ftBase = mix(vec3(1.0), mat.tint.rgb, mat.tint.a * 0.5);
        vec3 ftLinear = pow(ftBase, vec3(2.2));
        ftLinear += vec3(0.2 * ff * mat.refFresnelFactor);
        vec3 ftResult = pow(clamp(ftLinear, 0.0, 1.0), vec3(0.4545));
        outColor = mix(outColor, vec4(ftResult, 1.0), ff * mat.refFresnelFactor * 0.7 * length(n));
      }

      if (mat.glareFactor > 0.001) {
        float gGeo = clamp(
          pow(
            1.0 + sdf * res1x.y / 1500.0 * pow(500.0 / mat.glareRange, 2.0) + mat.glareHardness,
            5.0
          ), 0.0, 1.0
        );
        float ga = (vec2ToAngle(normalize(n)) - PI / 4.0 + u_glareAngle) * 2.0;
        int farside = 0;
        if ((ga > PI * 1.5 && ga < PI * 3.5) || ga < PI * -0.5) farside = 1;
        float gaf = (0.5 + sin(ga) * 0.5)
                    * (farside == 1 ? 1.2 * u_glareOppositeFactor : 1.2)
                    * mat.glareFactor;
        gaf = clamp(pow(gaf, 0.1 + mat.glareConvergence * 2.0), 0.0, 1.0);

        vec3 gtBase = mix(outColor.rgb, mat.tint.rgb, mat.tint.a * 0.5);
        vec3 gtLinear = pow(gtBase, vec3(2.2));
        float glareAdd = gaf * gGeo;
        gtLinear += vec3(1.5 * glareAdd);
        gtLinear += vec3(0.3 * glareAdd) * normalize(max(gtLinear, vec3(0.001)));
        vec3 gtResult = pow(clamp(gtLinear, 0.0, 1.5), vec3(0.4545));
        outColor = mix(outColor, vec4(min(gtResult, 1.0), 1.0), glareAdd * length(n));
      }
    }
  } else {
    outColor = vec4(0.0);
  }

  float edgeWidth = max(fwidth(sdf), 1.0 / u_resolution.y);
  float glassAlpha = 1.0 - smoothstep(-edgeWidth, edgeWidth, sdf);

  float shadowAlpha = 0.0;
  vec3 shadowRgb = vec3(0.0);

  if (u_shapeCount >= 1) {
    float sd = 1e10;
    vec4 sc = vec4(0.0);
    float sBlur = 0.0;

    for (int i = 0; i < MAX_MERGE_SHAPES; i++) {
      if (i >= u_shapeCount) break;
      vec4 ci = u_shadowShapes[i * 2];
      vec4 pi = u_shadowShapes[i * 2 + 1];
      if (ci.a <= 0.001) continue;

      float di = sdfShape(localCoord - pi.xy, i) - pi.w / u_resolution.y;

      if (sd > 1e9) {
        sd = di; sc = ci; sBlur = pi.z;
      } else {
        float mk = max(u_mergeK, 0.001);
        float h = clamp(0.5 + 0.5 * (sd - di) / mk, 0.0, 1.0);
        sd = mix(sd, di, h) - mk * h * (1.0 - h);
        sc = mix(sc, ci, h);
        sBlur = mix(sBlur, pi.z, h);
      }
    }

    if (sd < 1e9) {
      float blurN = max(sBlur / u_resolution.y, px);
      shadowAlpha = (1.0 - smoothstep(-blurN, blurN, sd)) * sc.a;
      shadowRgb = sc.rgb;
    }
  }

  vec4 glassPremul = vec4(outColor.rgb * glassAlpha, glassAlpha);
  vec4 shadowPremul = vec4(shadowRgb * shadowAlpha, shadowAlpha);
  fragColor = glassPremul + shadowPremul * (1.0 - glassAlpha);

  if (fragColor.a <= 0.0) {
    discard;
  }
}`;
