/**
 * GARGANTUA — post-processing GLSL.
 * Full-screen quad vertex shader, threshold prefilter, 13-tap downsample,
 * 9-tap tent upsample, ACES final composite.
 */

export const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* Soft-knee threshold + Karis average, downsamples 2× in one go. */
export const PREFILTER_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

void main(){
  vec3 s0 = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 s1 = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 s2 = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 s3 = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 c = (s0 + s1 + s2 + s3) * 0.25;
  c = min(c, vec3(uClamp));
  float l = max(c.r, max(c.g, c.b));
  float knee = max(uThreshold * uKnee, 1e-5);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(soft, l - uThreshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

/* Call of Duty style 13-tap downsample — stable, no fireflies. */
export const DOWN_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;

void main(){
  vec2 t = uTexel;
  vec3 a = texture2D(tDiffuse, vUv + t * vec2(-2.0, -2.0)).rgb;
  vec3 b = texture2D(tDiffuse, vUv + t * vec2( 0.0, -2.0)).rgb;
  vec3 c = texture2D(tDiffuse, vUv + t * vec2( 2.0, -2.0)).rgb;
  vec3 d = texture2D(tDiffuse, vUv + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture2D(tDiffuse, vUv).rgb;
  vec3 f = texture2D(tDiffuse, vUv + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture2D(tDiffuse, vUv + t * vec2(-2.0,  2.0)).rgb;
  vec3 h = texture2D(tDiffuse, vUv + t * vec2( 0.0,  2.0)).rgb;
  vec3 i = texture2D(tDiffuse, vUv + t * vec2( 2.0,  2.0)).rgb;
  vec3 j = texture2D(tDiffuse, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 k = texture2D(tDiffuse, vUv + t * vec2( 1.0, -1.0)).rgb;
  vec3 l = texture2D(tDiffuse, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 m = texture2D(tDiffuse, vUv + t * vec2( 1.0,  1.0)).rgb;

  vec3 o = e * 0.125
         + (a + c + g + i) * 0.03125
         + (b + d + f + h) * 0.0625
         + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(o, 1.0);
}
`;

/* 9-tap tent upsample (rendered with additive blending onto the finer mip). */
export const UP_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uRadius;
uniform float uIntensity;

void main(){
  vec2 t = uTexel * uRadius;
  vec3 a = texture2D(tDiffuse, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(tDiffuse, vUv + t * vec2( 0.0, -1.0)).rgb;
  vec3 c = texture2D(tDiffuse, vUv + t * vec2( 1.0, -1.0)).rgb;
  vec3 d = texture2D(tDiffuse, vUv + t * vec2(-1.0,  0.0)).rgb;
  vec3 e = texture2D(tDiffuse, vUv).rgb;
  vec3 f = texture2D(tDiffuse, vUv + t * vec2( 1.0,  0.0)).rgb;
  vec3 g = texture2D(tDiffuse, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 h = texture2D(tDiffuse, vUv + t * vec2( 0.0,  1.0)).rgb;
  vec3 i = texture2D(tDiffuse, vUv + t * vec2( 1.0,  1.0)).rgb;

  vec3 o = e * 4.0 + (b + d + f + h) * 2.0 + (a + c + g + i);
  gl_FragColor = vec4(o * (uIntensity / 16.0), 1.0);
}
`;

/* Final: HDR + bloom, ACES, vignette, film grain, dispersion, dithering. */
export const FINAL_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uChromatic;
uniform float uTime;
uniform int   uDebug;

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
vec3 acesFitted(vec3 c){
  c = ACES_IN * max(c, vec3(0.0));
  c = rrtOdtFit(c);
  c = ACES_OUT * c;
  return clamp(c, 0.0, 1.0);
}
vec3 linearToSRGB(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main(){
  vec2 uv = vUv;
  vec2 d  = uv - 0.5;
  float r2 = dot(d, d);

  vec3 hdr;
  if (uChromatic > 0.001){
    float k = uChromatic * 0.0055;
    hdr.r = texture2D(tScene, 0.5 + d * (1.0 - k * (0.35 + r2 * 2.4))).r;
    hdr.g = texture2D(tScene, uv).g;
    hdr.b = texture2D(tScene, 0.5 + d * (1.0 + k * (0.35 + r2 * 2.4))).b;
  } else {
    hdr = texture2D(tScene, uv).rgb;
  }

  vec3 bloom = texture2D(tBloom, uv).rgb;
  float exposure = max(uExposure, 0.0);

  vec3 c;
  if (uDebug == 8){
    c = bloom * max(uBloomStrength, 0.35) * 2.6;
    c = acesFitted(c);
  } else {
    c = hdr * exposure + bloom * uBloomStrength;
    c = acesFitted(c);
  }

  /* vignette */
  float vig = 1.0 - uVignette * smoothstep(0.18, 0.95, length(d) * 1.45);
  c *= clamp(vig, 0.0, 1.0);

  c = linearToSRGB(c);

  /* film grain (display space, heavier in the shadows) */
  if (uGrain > 0.0001){
    float n = hash12(gl_FragCoord.xy + fract(uTime * 71.3) * 311.7) - 0.5;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c += n * uGrain * (0.30 + 0.85 * (1.0 - lum));
  }

  /* ordered-ish dithering to stop 8-bit banding in the deep gradients */
  c += (hash12(gl_FragCoord.xy * 1.7 + 17.0) - 0.5) / 255.0;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
