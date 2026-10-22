/**
 * GARGANTUA — shared GLSL fragments (GLSL ES 1.00, three.js ShaderMaterial).
 * Hashes, value noise / fBm, Planckian blackbody, small colour helpers.
 */

export const GLSL_COMMON = /* glsl */`
#ifndef GARGANTUA_COMMON
#define GARGANTUA_COMMON

#define PI      3.141592653589793
#define TAU     6.283185307179586
#define INV_PI  0.3183098861837907

float saturate(float x){ return clamp(x, 0.0, 1.0); }
vec3  saturate(vec3  x){ return clamp(x, 0.0, 1.0); }
float luminance(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float pow5(float x){ float x2 = x*x; return x2*x2*x; }

/* ── hashing (Dave Hoskins style, cheap and well distributed) ─────────── */
float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/* ── 3D value noise (cheap, used for grain/star placement) ────────────── */
float vnoise(vec3 x){
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(p + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(p + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(p + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(p + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(p + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(p + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(p + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(p + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

/* ── 3D simplex noise (Ashima / Gustavson, MIT) ───────────────────────────
   Used for every large-scale structure.  Value noise on an axis-aligned grid
   is unusable here: the gravitational lensing smears the sky azimuthally and
   a cubic grid turns into concentric interference rings.               */
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/* Rotation matrix for a 2D (disk-plane) sample point. */
vec2 rot2(vec2 p, float a){
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

/* ── simplex fBm, fixed octave counts (ES 1.00 needs constant bounds) ─── */
float sfbm2(vec3 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 2; i++){ s += a * snoise(p); n += a; p = p * 2.03 + vec3(1.7, 9.2, 3.3); a *= 0.5; }
  return s / n;
}
float sfbm3(vec3 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 3; i++){ s += a * snoise(p); n += a; p = p * 2.03 + vec3(1.7, 9.2, 3.3); a *= 0.5; }
  return s / n;
}
float sfbm4(vec3 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 4; i++){ s += a * snoise(p); n += a; p = p * 2.02 + vec3(5.2, 1.3, 7.7); a *= 0.5; }
  return s / n;
}
/* ridged simplex — galactic dust lanes */
float sridged(vec3 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 3; i++){
    float v = 1.0 - abs(snoise(p));
    s += a * v * v; n += a;
    p = p * 2.11 + vec3(3.9, 1.1, 6.2); a *= 0.5;
  }
  return s / n;
}

/* ── Planckian locus → linear sRGB (Helland fit, normalised to unit peak) ─
   Returns chromaticity only; radiometric weight is applied by the caller
   through the T^4 emissivity term.                                     */
vec3 blackbody(float kelvin){
  float t = clamp(kelvin, 900.0, 40000.0) * 0.01;
  float r, g, b;
  if (t <= 66.0){
    r = 255.0;
    g = 99.4708025861 * log(max(t, 1.0)) - 161.1195681661;
  } else {
    r = 329.698727446 * pow(max(t - 60.0, 1e-3), -0.1332047592);
    g = 288.1221695283 * pow(max(t - 60.0, 1e-3), -0.0755148492);
  }
  if (t >= 66.0)      b = 255.0;
  else if (t <= 19.0) b = 0.0;
  else                b = 138.5177312231 * log(max(t - 10.0, 1e-3)) - 305.0447927307;
  vec3 c = saturate(vec3(r, g, b) / 255.0);
  c = pow(c, vec3(2.2));                        // sRGB → linear
  return c / max(1e-4, max(c.r, max(c.g, c.b))); // unit peak, hue preserved
}

/* Compact false-colour ramp for the debug views (turbo-ish, linear light). */
vec3 heatmap(float x){
  x = saturate(x);
  vec3 c = vec3(0.0);
  c.r = smoothstep(0.28, 1.00, x);
  c.g = smoothstep(0.10, 0.62, x) * (1.0 - 0.55 * smoothstep(0.72, 1.0, x));
  c.b = smoothstep(0.00, 0.28, x) * (1.0 - smoothstep(0.30, 0.66, x));
  c += vec3(0.35, 0.05, 0.45) * smoothstep(0.85, 1.0, x);
  return c * (0.25 + 1.5 * x);
}

vec3 spectralRamp(float x){
  x = saturate(x);
  vec3 c;
  c.r = saturate(1.6 * x - 0.15);
  c.g = saturate(1.7 * x * (1.0 - 0.55 * x * x));
  c.b = saturate(1.4 * (1.0 - x) * pow(x, 0.55) * 1.8);
  return c;
}

#endif
`;

/* ── post-processing helpers (bloom / tonemap maths) ───────────────────── */
export const GLSL_TONEMAP = /* glsl */`
// ACES filmic — Stephen Hill's fit (RRT + ODT sRGB), matrices in linear sRGB.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);
vec3 rrtOdtFit(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 color){
  color = ACES_IN * max(color, vec3(0.0));
  color = rrtOdtFit(color);
  color = ACES_OUT * color;
  return saturate(color);
}
vec3 linearToSRGB(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;
