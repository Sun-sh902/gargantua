/**
 * GARGANTUA — Schwarzschild null-geodesic raytracer (fragment shader).
 *
 * Physics
 * -------
 * Units: r_s = 2M = 1, so M = 1/2 and the horizon sits at r = 1.
 * Every pixel shoots a null geodesic from the observer.  Instead of
 * integrating the 3D trajectory we use the exact planar symmetry of
 * Schwarzschild spacetime: the orbit of a photon lies in the plane spanned
 * by the observer position and the ray direction, so the whole geodesic is
 * described by one ODE for u = 1/r as a function of the longitude φ:
 *
 *        d²u/dφ² = -u + 3M u² = -u + 1.5 u²
 *
 * which is integrated with classical RK4.  From that flow we get, for free:
 *   • the event horizon   (u reaches 1   → captured, pure black)
 *   • the photon sphere   (winding solutions at r = 3M = 1.5 r_s → photon ring)
 *   • the exact deflection of the background sky (gravitational lensing)
 *   • every equatorial-plane crossing → repeated images of the accretion disk
 *   • the conserved impact parameter b = L/E, hence the exact redshift factor
 *
 * The accretion disk is treated as a thin, flared, semi-transparent slab.
 * Each crossing contributes an emission/absorption event with a Keplerian
 * Doppler factor and gravitational redshift computed from the constants of
 * the motion:
 *
 *        g = ν_obs/ν_emit = sqrt(1 - 3M/r) / (1 - Ω b),   Ω = sqrt(M/r³)
 *
 * so the approaching side of the disk is beamed and blue-shifted while the
 * receding side is dimmed and red-shifted, exactly as the metric demands.
 */

import { GLSL_COMMON } from './lib.js';

export const BLACKHOLE_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const BLACKHOLE_FRAG = /* glsl */`
${GLSL_COMMON}

#define MAX_STEPS 1200
#define MAX_CROSS 10
#define B_CRIT   2.598076211353316   // 3*sqrt(3)*M with 2M = 1

varying vec2 vUv;

/* ── camera ───────────────────────────────────────────────────────────── */
uniform vec2  uResolution;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;

/* ── simulation ───────────────────────────────────────────────────────── */
uniform float uTime;
uniform float uMaxSteps;     // integration budget (float for the ES1 loop guard)
uniform float uStepSize;     // dφ
uniform float uEscapeR;      // radius at which a photon is declared escaped

/* ── accretion disk ───────────────────────────────────────────────────── */
uniform float uDiskOn;       // 0/1
uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskThickness;
uniform float uDiskDensity;
uniform float uDiskBrightness;
uniform float uDiskTemp;
uniform float uDoppler;
uniform float uRedshift;
uniform float uDiskSpin;     // +1 prograde, -1 retrograde
uniform float uTurbScale;
uniform float uTurbSpeed;
uniform float uTurbContrast;
uniform float uNewtonian;    // debug 4: kill all relativistic frequency shifts

/* ── deep sky ─────────────────────────────────────────────────────────── */
uniform float uStarOn;
uniform float uStarDensity;
uniform float uStarBrightness;
uniform float uGalaxyBrightness;
uniform float uNebula;

uniform int   uDebug;

/* ── trace telemetry (globals; GLSL ES 1.0 has no out-structs we care for) */
vec3  gColor;
float gSteps;
float gCross;
float gTrans;
float gG;        // redshift factor of the last crossing
float gTemp;     // observed temperature of the last crossing (K)
float gB;        // impact parameter
float gDeflect;  // total deflection angle (rad)
float gFirstHit; // radius of the first crossing
bool  gCaptured;
bool  gEscaped;

/* ══════════════════════════════════════════════════════════════════════ *
 *  Geodesic flow:  u' = w,  w' = -u + 1.5 u²     (RK4 on (u,w))
 * ══════════════════════════════════════════════════════════════════════ */
void rk4(float u, float w, float h, out float un, out float wn){
  float k1u = w;
  float k1w = -u + 1.5 * u * u;

  float ua = u + 0.5 * h * k1u;
  float wa = w + 0.5 * h * k1w;
  float k2u = wa;
  float k2w = -ua + 1.5 * ua * ua;

  float ub = u + 0.5 * h * k2u;
  float wb = w + 0.5 * h * k2w;
  float k3u = wb;
  float k3w = -ub + 1.5 * ub * ub;

  float uc = u + h * k3u;
  float wc = w + h * k3w;
  float k4u = wc;
  float k4w = -uc + 1.5 * uc * uc;

  un = u + (h / 6.0) * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
  wn = w + (h / 6.0) * (k1w + 2.0 * k2w + 2.0 * k3w + k4w);
}

/* ══════════════════════════════════════════════════════════════════════ *
 *  Deep sky: procedural stars, Milky Way band, nebulae.
 *  Sampled with the *asymptotic* direction of the escaped photon, which is
 *  what makes the background warp into Einstein rings.
 * ══════════════════════════════════════════════════════════════════════ */
vec3 starLayer(vec3 dir, float scale, float thresh, float pixAng, float sizeMult, float bright){
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 h = hash33(cell);
  if (h.z >= thresh) return vec3(0.0);

  vec3 h2 = hash33(cell + 17.31);
  vec3 sp = vec3(0.30) + 0.40 * h2;             // star kept inside its own cell
  vec3 f = p - cell;
  float ang = length(f - sp) / scale;           // angular distance in radians

  /* Size stars in PIXELS: a cell-proportional floor makes the low-frequency
     layers enormous at low resolutions, which reads as snow. */
  float rad = min(pixAng * sizeMult, 0.18 / scale);
  float x = ang / rad;
  float profile = exp(-x * x * 3.2) + 0.085 * exp(-x * x * 0.55);

  float temp = mix(2700.0, 13500.0, pow(h.x, 1.6));
  float mag  = 0.06 + 12.0 * pow(h2.x, 6.0);
  return blackbody(temp) * profile * mag * bright;
}

vec3 skyColor(vec3 dir, float pixAng){
  vec3 col = vec3(0.0);

  /* ── Milky Way: a wide great-circle band plus a brighter core ── */
  vec3 gpole = normalize(vec3(0.44, 0.60, -0.67));
  float bb = dot(dir, gpole);
  float band = exp(-bb * bb * 16.0) + 0.26 * exp(-bb * bb * 3.0);

  float n1 = 0.5 + 0.5 * sfbm3(dir * 1.55 + vec3(5.2, 1.3, 9.7));
  float n2 = 0.5 + 0.5 * sfbm2(dir * 4.10 - vec3(2.1, 7.7, 1.9));
  float cloud = saturate(n1 * 1.18 + n2 * 0.42 - 0.44);

  vec3 warm = vec3(1.00, 0.80, 0.55);
  vec3 cool = vec3(0.48, 0.63, 1.00);
  vec3 gal  = mix(cool, warm, saturate(cloud * 1.5)) * (0.10 + 1.35 * cloud) * band;

  float dust = sridged(dir * 3.1 + vec3(21.0, 3.0, 11.0));
  gal *= mix(1.0, 0.16, saturate(dust * 1.5 - 0.55) * saturate(band * 1.6));

  float bulge = pow(saturate(dot(dir, normalize(vec3(-0.58, 0.26, 0.77)))), 34.0);
  gal += vec3(1.0, 0.87, 0.64) * bulge * 0.9 * band;

  col += gal * uGalaxyBrightness * 0.13;

  /* ── faint emission nebulae over the whole sphere ── */
  float neb  = 0.5 + 0.5 * sfbm3(dir * 2.6 + vec3(13.0, 2.0, 5.0));
  float neb2 = 0.5 + 0.5 * sfbm2(dir * 1.4 + vec3(3.0, 8.0, 1.0));
  vec3 nebc  = mix(vec3(0.46, 0.12, 0.55), vec3(0.05, 0.48, 0.52), neb2);
  col += nebc * pow(saturate(neb * 1.3 - 0.52), 1.9) * uNebula * 0.20;

  /* ── stars (four magnitude/density layers) ── */
  if (uStarOn > 0.5 && uStarDensity > 0.001){
    float d = uStarDensity;
    col += starLayer(dir,  46.0, min(0.50 * d, 0.95), pixAng, 1.55, 1.00) * uStarBrightness;
    col += starLayer(dir, 118.0, min(0.36 * d, 0.95), pixAng, 1.15, 0.44) * uStarBrightness;
    col += starLayer(dir, 252.0, min(0.26 * d, 0.95), pixAng, 0.95, 0.18) * uStarBrightness;
    col += starLayer(dir, 470.0, min(0.20 * d, 0.95), pixAng, 0.85, 0.08) * uStarBrightness;
  }
  return col;
}

/* ══════════════════════════════════════════════════════════════════════ *
 *  Accretion disk emission at an equatorial crossing.
 *  pos  : 3D crossing point       dir : photon direction there
 *  Returns the emitted (already shifted) radiance.
 * ══════════════════════════════════════════════════════════════════════ */
vec3 diskEmission(float rc, vec3 pos, vec3 dir, float bSigned,
                  out float alpha, out float gOut, out float tOut){
  alpha = 0.0; gOut = 1.0; tOut = 0.0;

  /* radial extent — smooth edges so the ISCO rim stays crisp but not jagged */
  float t = (rc - uDiskInner) / max(uDiskOuter - uDiskInner, 1e-3);
  float win = smoothstep(0.0, 0.030, t) * (1.0 - smoothstep(0.58, 1.0, t));
  if (win <= 0.0001) return vec3(0.0);

  /* Shakura–Sunyaev / Novikov–Thorne radial temperature profile,
     normalised so that its maximum is 1 (peak at r = 49/36 r_in). */
  float x = clamp(uDiskInner / max(rc, 1e-3), 0.0, 0.9995);
  float prof = 2.049 * pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25);
  if (prof <= 0.0) return vec3(0.0);

  /* Keplerian shear: the noise pattern is advected by Ω(r), with the
     differential part saturating so the flow never winds itself into
     numerical mush during a long session. */
  float om    = sqrt(0.5 / (rc * rc * rc));
  float omRef = sqrt(0.5 / 512.0);                       // r = 8 r_s reference
  float K     = 5.0 * uTurbSpeed;
  float satA  = 14.0;
  float shear = satA * tanh((om - omRef) * uTime * K / satA);
  float ang   = (omRef * uTime * K + shear) * uDiskSpin;
  vec2  p0    = rot2(pos.xz, ang);

  vec3 q = vec3(p0, 0.0) * (uTurbScale * 0.9) + vec3(0.0, 0.0, uTime * 0.05 * (0.35 + uTurbSpeed));
  float n1 = 0.5 + 0.5 * sfbm3(q);
  float n2 = 0.5 + 0.5 * snoise(q * 3.13 + 19.7);
  float turb = n1 * 0.74 + n2 * 0.26;
  turb *= 0.74 + 0.42 * (0.5 + 0.5 * sfbm2(q * 1.7 + 5.1));
  turb *= 1.0 + 0.18 * sin(length(p0) * uTurbScale * 6.0 + n1 * 8.0);
  turb = max(mix(0.55, turb * 1.45, saturate(uTurbContrast)), 0.0);

  /* flared slab: H grows slowly with radius, optical depth scales with the
     geometric path length through the slab (grazing rays are brighter). */
  float H = uDiskThickness * pow(rc / max(uDiskInner, 0.5), 1.15);
  float cosInc = max(abs(dir.y), 0.05);
  float pathF  = min(1.0 / cosInc, 4.0);
  /* Surface density climbs inward, so the hot inner rings stay optically
     thick while the cooler outer flow is semi-transparent — structure comes
     from the emissivity modulation rather than from a saturated wall. */
  float sigma  = pow(max(uDiskInner, 0.5) / rc, 0.55);
  float tau    = uDiskDensity * win * turb * H * sigma * pathF * 3.4;
  alpha = 1.0 - exp(-max(tau, 0.0));
  if (alpha <= 0.0005) return vec3(0.0);

  /* relativistic frequency shift: exact GR numerator, exact Doppler factor */
  float grav = sqrt(max(1.0 - 1.0 / rc, 0.0));                 // sqrt(1-2M/r)
  float denom = max(1.0 - (om * uDiskSpin) * bSigned, 0.04);
  float gTot = sqrt(max(1.0 - 1.5 / rc, 1e-4)) / denom;        // sqrt(1-3M/r)/(1-Ωb)
  float dop  = gTot / max(grav, 1e-3);
  float gShift = pow(grav, uRedshift) * pow(dop, uDoppler);
  if (uNewtonian > 0.5) gShift = 1.0;

  float Tk = uDiskTemp * prof;
  gOut = gShift;
  tOut = Tk * gShift;

  /* Stefan–Boltzmann-ish emissivity, then the observed beaming g⁴. */
  float turb01 = saturate(turb / 1.45);          // emissivity follows the filaments
  vec3 col = blackbody(max(Tk * gShift, 400.0))
           * pow(max(prof, 0.0), 1.7)
           * (0.30 + 1.05 * turb01)
           * pow(gShift, 4.0)
           * uDiskBrightness;

  /* a touch of extra glow right at the ISCO rim */
  col *= 1.0 + 0.55 * exp(-pow((rc - uDiskInner) / max(0.45 * uDiskInner, 0.2), 2.0));
  return col;
}

/* ══════════════════════════════════════════════════════════════════════ *
 *  Main geodesic trace.
 * ══════════════════════════════════════════════════════════════════════ */
void trace(vec3 ro, vec3 rd, float pixAng){
  gColor = vec3(0.0); gSteps = 0.0; gCross = 0.0; gTrans = 1.0;
  gG = 1.0; gTemp = 0.0; gB = 0.0; gDeflect = 0.0; gFirstHit = -1.0;
  gCaptured = false; gEscaped = false;

  float r0 = max(length(ro), 1.001);
  vec3 e1 = ro / r0;
  float D1 = dot(rd, e1);
  vec3  perp = rd - e1 * D1;
  float D2 = length(perp);

  /* ── radial rays: no orbital plane, trivial answer ── */
  if (D2 < 1e-5){
    if (D1 > 0.0){ gEscaped = true; gColor = skyColor(rd, pixAng); }
    else { gCaptured = true; gColor = vec3(0.0); gTrans = 0.0; }
    gSteps = 1.0;
    return;
  }

  vec3 e2 = perp / D2;
  float a1 = e1.y, a2 = e2.y;          // disk-plane (y = 0) coefficients

  float u = 1.0 / r0;
  float w = -u * (D1 / D2);            // du/dφ at φ = 0
  float uEsc = 1.0 / max(uEscapeR, r0 * 2.0 + 2.0);

  vec2 cs = vec2(1.0, 0.0);
  float ch = cos(uStepSize), sh = sin(uStepSize);
  float phi = 0.0;

  float bMag  = inversesqrt(max(u * u + w * w - u * u * u, 1e-9));
  gB = bMag;
  /* Conserved axial impact parameter b_Y = (L·Ŷ)/E of the photon.  The metric
     hands us |L|/E = bMag directly and L points along the orbit normal, so the
     component along the disk axis is bMag · (n̂·Ŷ): continuous everywhere, and
     exactly ±bMag for photons orbiting in the equatorial plane.  Using the
     signed magnitude instead puts a hard seam wherever the orbital plane
     contains the axis, which is not what the metric does. */
  float bSigned = bMag * dot(cross(e1, e2), vec3(0.0, 1.0, 0.0));
  float yPrev = (a1 * cs.x + a2 * cs.y) / u;
  bool captured = false, escaped = false;

  for (int i = 0; i < MAX_STEPS; i++){
    if (float(i) >= uMaxSteps) break;
    gSteps = float(i) + 1.0;

    /* Test the horizon and the far-field cut-off on u itself.
       NEVER on r = 1/u: far from the hole a single φ-step moves u by more
       than its own value, so u can cross zero within one step and r comes
       back NEGATIVE — which an "r <= 1" test misreads as "inside the horizon"
       and paints dark rings wherever the step phase happens to land there. */
    if (u >= 1.0){ captured = true; break; }          // crossed the horizon
    if (u <= uEsc){ escaped = true; break; }          // far field reached

    float un, wn;
    rk4(u, w, uStepSize, un, wn);
    if (un >= 1.0){ captured = true; break; }         // horizon inside this step

    vec2 csN = vec2(cs.x * ch - cs.y * sh, cs.x * sh + cs.y * ch);
    float yNext = (a1 * csN.x + a2 * csN.y) / un;

    /* ── equatorial crossing: refine with a bisection on the RK4 flow ── */
    if (un > 0.0 && yPrev * yNext < 0.0 && gCross < float(MAX_CROSS)){
      float lo = 0.0, hi = uStepSize;
      float uC = un, wC = wn, hC = uStepSize;
      for (int k = 0; k < 6; k++){
        float mid = 0.5 * (lo + hi);
        float um, wm;
        rk4(u, w, mid, um, wm);
        if (um <= 1e-6){ hi = mid; hC = mid; uC = um; wC = wm; continue; }
        float cm = cos(mid), sm = sin(mid);
        vec2 csm = vec2(cs.x * cm - cs.y * sm, cs.x * sm + cs.y * cm);
        float ym = (a1 * csm.x + a2 * csm.y) / um;
        if (ym * yPrev <= 0.0){ hi = mid; hC = mid; uC = um; wC = wm; }
        else { lo = mid; }
      }
      if (uC > 1e-6 && uC < 1.0){
        float rc = 1.0 / uC;
        float cm = cos(hC), sm = sin(hC);
        vec2 csC = vec2(cs.x * cm - cs.y * sm, cs.x * sm + cs.y * cm);
        vec3 rad = csC.x * e1 + csC.y * e2;
        vec3 tanv = -csC.y * e1 + csC.x * e2;
        vec3 pos = rad * rc;
        vec3 dir = normalize((-wC / (uC * uC)) * rad + rc * tanv + vec3(0.0, 0.0, 1e-12));

        float alpha, gOut, tOut;
        vec3 em = diskEmission(rc, pos, dir, bSigned, alpha, gOut, tOut);
        if (uDiskOn > 0.5 && alpha > 0.0){
          gColor += gTrans * alpha * em;
          gTrans *= (1.0 - alpha);
          gCross += 1.0;
          gG = gOut; gTemp = tOut;
          if (gFirstHit < 0.0) gFirstHit = rc;
        }
      }
    }

    u = un; w = wn; cs = csN; phi += uStepSize; yPrev = yNext;
  }

  if (captured && !escaped){
    gCaptured = true;
    gTrans = 0.0;                       // nothing behind the horizon
    return;
  }

  /* ── escaped (or budget exhausted): look up the lensed sky ──────────────
     In the far field the φ-ODE reduces to u = C·sin(φ − φ∞): the photon is on
     its final straight-line asymptote, so φ∞ = φ − atan2(u, w) is its exact
     direction of travel at infinity.

     Do NOT use the instantaneous tangent here.  At radius r it still carries
     the residual bend b/r (up to ~3° at the escape radius r = 260), and since
     one φ-step covers a huge Δr out there, that error jumps discontinuously
     from pixel to pixel and etches concentric rings into the lensed sky. */
  float angOut = phi - atan(u, w) + PI;
  vec3 dirOut = cos(angOut) * e1 + sin(angOut) * e2;

  gEscaped = true;
  gDeflect = acos(clamp(dot(rd, dirOut), -1.0, 1.0));
  gColor += gTrans * skyColor(dirOut, pixAng);
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float pixAng = 2.0 * uTanHalfFov / max(uResolution.y, 1.0);

  vec3 rd = normalize(uCamFwd
        + uCamRight * (ndc.x * uTanHalfFov * aspect)
        + uCamUp    * (ndc.y * uTanHalfFov));

  trace(uCamPos, rd, pixAng);

  vec3 col = gColor;

  /* ── debug visualisations 0…9 ─────────────────────────────────────── */
  if (uDebug == 1){
    col = heatmap(gSteps / max(uMaxSteps, 1.0));
  } else if (uDebug == 2){
    col = vec3(0.06, 0.07, 0.10);
    if (gCross >= 1.0) col = vec3(0.95, 0.34, 0.06);
    if (gCross >= 2.0) col = vec3(1.00, 0.78, 0.22);
    if (gCross >= 3.0) col = vec3(0.42, 0.90, 1.00);
    if (gCross >= 4.0) col = vec3(0.78, 0.45, 1.00);
    if (gCaptured) col *= 0.30;
  } else if (uDebug == 3){
    if (gCross > 0.0){
      float v = clamp(log(max(gG, 1e-3)) / log(2.2) * 0.5 + 0.5, 0.0, 1.0);
      col = spectralRamp(v) * 1.4;
    } else {
      col = gCaptured ? vec3(0.10, 0.02, 0.02) : vec3(0.03, 0.04, 0.06);
    }
  } else if (uDebug == 5){
    col = gColor;                                    // disk switched off on the CPU side
  } else if (uDebug == 6){
    float t = gB / B_CRIT;                       // 1.0 == the critical curve
    col = heatmap(clamp(log(max(t, 0.05)) / log(6.0), 0.0, 1.0)) * 0.85;
    col = mix(col, vec3(1.0, 0.96, 0.88), smoothstep(0.06, 0.0, abs(t - 1.0)));
    if (gCaptured) col *= 0.22;
  } else if (uDebug == 7){
    if (gCross > 0.0) col = spectralRamp(clamp(gTemp / 24000.0, 0.0, 1.0)) * 1.6;
    else col = gCaptured ? vec3(0.08, 0.02, 0.02) : vec3(0.02, 0.03, 0.05);
  } else if (uDebug == 9){
    col = gCaptured ? vec3(0.30, 0.03, 0.02)
                    : heatmap(clamp((1.0 - gTrans) * 1.6, 0.0, 1.0)) * 0.85;
  }

  /* debug 4 shares the beauty image, the CPU disables the shifts;
     debug 8 (bloom buffer) is resolved by the post pipeline. */
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;
