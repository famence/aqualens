export const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const BLUR_H_FRAGMENT = `#version 300 es
precision highp float;
#define MAX_BLUR_RADIUS 50
in vec2 v_uv;
uniform sampler2D u_inputTex;
uniform vec2 u_texSize;
uniform int u_blurRadius;
uniform float u_blurWeights[MAX_BLUR_RADIUS + 1];
out vec4 fragColor;
void main() {
  vec2 texel = 1.0 / u_texSize;
  vec4 c = texture(u_inputTex, v_uv) * u_blurWeights[0];
  for (int i = 1; i <= u_blurRadius; ++i) {
    float w = u_blurWeights[i];
    c += texture(u_inputTex, v_uv + vec2(float(i) * texel.x, 0.0)) * w;
    c += texture(u_inputTex, v_uv - vec2(float(i) * texel.x, 0.0)) * w;
  }
  fragColor = c;
}`;

export const BLUR_V_FRAGMENT = `#version 300 es
precision highp float;
#define MAX_BLUR_RADIUS 50
in vec2 v_uv;
uniform sampler2D u_inputTex;
uniform vec2 u_texSize;
uniform int u_blurRadius;
uniform float u_blurWeights[MAX_BLUR_RADIUS + 1];
out vec4 fragColor;
void main() {
  vec2 texel = 1.0 / u_texSize;
  vec4 c = texture(u_inputTex, v_uv) * u_blurWeights[0];
  for (int i = 1; i <= u_blurRadius; ++i) {
    float w = u_blurWeights[i];
    c += texture(u_inputTex, v_uv + vec2(0.0, float(i) * texel.y)) * w;
    c += texture(u_inputTex, v_uv - vec2(0.0, float(i) * texel.y)) * w;
  }
  fragColor = c;
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
  float px = u_dpr / u_resolution.y;
  float edgeWidth = max(2.0 * px, 1.0 / u_resolution.y);
  float a = 1.0 - smoothstep(-edgeWidth, edgeWidth, sdf);
  if (a <= 0.0) discard;
  fragColor = vec4(0.0, 0.0, 0.0, a);
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
#define MAT_VECS 4
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
  vec2 h = vec2(max(abs(dFdx(fc.x)), 0.0001), max(abs(dFdy(fc.y)), 0.0001));
  vec2 g = vec2(
    mainSDF(fc + vec2(h.x, 0.0)) - mainSDF(fc - vec2(h.x, 0.0)),
    mainSDF(fc + vec2(0.0, h.y)) - mainSDF(fc - vec2(0.0, h.y))
  ) / (2.0 * h);
  return g * 1414.213562;
}

// ---- LCH color space (for tinting) ----

const vec3 D65_WHITE = vec3(0.95045592705, 1.0, 1.08905775076);
const mat3 RGB_TO_XYZ_M = mat3(
  0.4124, 0.3576, 0.1805,
  0.2126, 0.7152, 0.0722,
  0.0193, 0.1192, 0.9505
);
const mat3 XYZ_TO_RGB_M = mat3(
  3.2406255, -1.537208,  -0.4986286,
  -0.9689307, 1.8757561,  0.0415175,
  0.0557101, -0.2040211,  1.0569959
);

float uncompandSRGB(float a) {
  return a > 0.04045 ? pow((a + 0.055) / 1.055, 2.4) : a / 12.92;
}
float compandRGB(float a) {
  return a <= 0.0031308 ? 12.92 * a : 1.055 * pow(a, 0.41666666666) - 0.055;
}
vec3 srgbToRgb(vec3 s) {
  return vec3(uncompandSRGB(s.x), uncompandSRGB(s.y), uncompandSRGB(s.z));
}
vec3 rgbToSrgb(vec3 r) {
  return vec3(compandRGB(r.x), compandRGB(r.y), compandRGB(r.z));
}
vec3 rgbToXyz(vec3 c) { return c * RGB_TO_XYZ_M; }
vec3 xyzToRgb(vec3 c) { return c * XYZ_TO_RGB_M; }
vec3 srgbToXyz(vec3 s) { return rgbToXyz(srgbToRgb(s)); }
vec3 xyzToSrgb(vec3 x) { return rgbToSrgb(xyzToRgb(x)); }

float xyzToLabF(float x) {
  return x > 0.00885645167 ? pow(x, 0.333333333) : 7.78703703704 * x + 0.13793103448;
}
vec3 xyzToLab(vec3 xyz) {
  vec3 s = xyz / D65_WHITE;
  s = vec3(xyzToLabF(s.x), xyzToLabF(s.y), xyzToLabF(s.z));
  return vec3(116.0 * s.y - 16.0, 500.0 * (s.x - s.y), 200.0 * (s.y - s.z));
}
vec3 labToLch(vec3 lab) {
  return vec3(lab.x, sqrt(dot(lab.yz, lab.yz)), atan(lab.z, lab.y) * 57.2957795131);
}
vec3 srgbToLch(vec3 s) { return labToLch(xyzToLab(srgbToXyz(s))); }

float labToXyzF(float x) {
  return x > 0.206897 ? x * x * x : 0.12841854934 * (x - 0.137931034);
}
vec3 labToXyz(vec3 lab) {
  float w = (lab.x + 16.0) / 116.0;
  return D65_WHITE * vec3(labToXyzF(w + lab.y / 500.0), labToXyzF(w), labToXyzF(w - lab.z / 200.0));
}
vec3 lchToLab(vec3 lch) {
  return vec3(lch.x, lch.y * cos(lch.z * 0.01745329251), lch.y * sin(lch.z * 0.01745329251));
}
vec3 lchToSrgb(vec3 lch) { return xyzToSrgb(labToXyz(lchToLab(lch))); }

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
  vec2 uvR = clampUVToBounds(uv + offs * (1.0 - (N_R - 1.0) * disp));
  vec2 uvG = clampUVToBounds(uv + offs);
  vec2 uvB = clampUVToBounds(uv + offs * (1.0 - (N_B - 1.0) * disp));

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
  Material m;
  m.tint = v0;
  m.blurAmount = v1.x;
  m.blurEdge = v1.y;
  m.refThickness = v1.z;
  m.refFactor = v1.w;
  m.refDispersion = v2.x;
  m.refFresnelRange = v2.y;
  m.refFresnelHardness = v2.z;
  m.refFresnelFactor = v2.w;
  m.glareRange = v3.x;
  m.glareHardness = v3.y;
  m.glareFactor = v3.z;
  m.glareConvergence = v3.w;
  return m;
}

Material mixMat(Material a, Material b, float t) {
  Material m;
  m.tint = mix(a.tint, b.tint, t);
  m.blurAmount = mix(a.blurAmount, b.blurAmount, t);
  m.blurEdge = mix(a.blurEdge, b.blurEdge, t);
  m.refThickness = mix(a.refThickness, b.refThickness, t);
  m.refFactor = mix(a.refFactor, b.refFactor, t);
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

Material getBlendedMaterial(vec2 fc) {
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
  float sdf = mainSDF(localCoord);
  float px = u_dpr / u_resolution.y;

  vec2 baseUV = clampUVToBounds(getTexUV(v_uv));

  Material mat = getBlendedMaterial(localCoord);

  vec4 outColor;

  if (sdf < 5.0 * px) {
    float nm = -sdf * res1x.y;

    float blurFadeZone = mat.refThickness * 2.0;
    float blurEdgeFade = smoothstep(0.0, blurFadeZone, nm);

    float xr = 1.0 - nm / mat.refThickness;
    float tI = asin(pow(clamp(xr, 0.0, 1.0), 2.0));
    float tT = asin(sin(tI) / mat.refFactor);
    float ef = -tan(tT - tI);
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

      float ff = clamp(
        pow(
          1.0 + sdf * res1x.y / 1500.0 * pow(500.0 / mat.refFresnelRange, 2.0) + mat.refFresnelHardness,
          5.0
        ), 0.0, 1.0
      );
      vec3 ftLCH = srgbToLch(mix(vec3(1.0), mat.tint.rgb, mat.tint.a * 0.5));
      ftLCH.x += 20.0 * ff * mat.refFresnelFactor;
      ftLCH.x = clamp(ftLCH.x, 0.0, 100.0);
      outColor = mix(outColor, vec4(lchToSrgb(ftLCH), 1.0), ff * mat.refFresnelFactor * 0.7 * length(n));

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

      vec3 gtLCH = srgbToLch(mix(outColor.rgb, mat.tint.rgb, mat.tint.a * 0.5));
      gtLCH.x += 150.0 * gaf * gGeo;
      gtLCH.y += 30.0 * gaf * gGeo;
      gtLCH.x = clamp(gtLCH.x, 0.0, 120.0);
      outColor = mix(outColor, vec4(lchToSrgb(gtLCH), 1.0), gaf * gGeo * length(n));
    }
  } else {
    outColor = vec4(0.0);
  }

  float edgeWidth = max(2.0 * px, 1.0 / u_resolution.y);
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
