#!/usr/bin/env node
/**
 * Numeric probe for the Schwarzschild φ-ODE used by the fragment shader.
 *
 *   d²u/dφ² = -u + 3M u²      (2M = 1  →  1.5 u²)
 *
 * Reproduces the shader's fixed-step RK4 for a sweep of camera pixels and
 * reports the asymptotic escape direction, so step-size artefacts can be
 * diagnosed outside the GPU.
 *
 *   node tests/geodesic-probe.mjs [h] [rCam] [escapeR] [maxSteps]
 */

const H = parseFloat(process.argv[2] ?? '0.038');
const R_CAM = parseFloat(process.argv[3] ?? '21');
const ESCAPE = parseFloat(process.argv[4] ?? '260');
const MAXSTEPS = parseInt(process.argv[5] ?? '1200', 10);

function rk4(u, w, h) {
  const k1u = w, k1w = -u + 1.5 * u * u;
  const ua = u + 0.5 * h * k1u, wa = w + 0.5 * h * k1w;
  const k2u = wa, k2w = -ua + 1.5 * ua * ua;
  const ub = u + 0.5 * h * k2u, wb = w + 0.5 * h * k2w;
  const k3u = wb, k3w = -ub + 1.5 * ub * ub;
  const uc = u + h * k3u, wc = w + h * k3w;
  const k4u = wc, k4w = -uc + 1.5 * uc * uc;
  return [u + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u),
          w + (h / 6) * (k1w + 2 * k2w + 2 * k3w + k4w)];
}

/** Integrate a ray that leaves the camera at angle psi from the aim point. */
function trace(psi, h, maxSteps = MAXSTEPS) {
  const D1 = -Math.cos(psi), D2 = Math.sin(psi);
  let u = 1 / R_CAM;
  let w = -u * (D1 / D2);
  let phi = 0, steps = 0;
  const b = 1 / Math.sqrt(Math.max(u * u + w * w - u * u * u, 1e-12));
  for (let i = 0; i < maxSteps; i++) {
    const r = 1 / u;
    if (r <= 1) return { status: 'captured', phi, u, w, steps, b };
    if (r >= ESCAPE) return { status: 'escaped', phi, u, w, steps, b };
    steps++;
    const [un, wn] = rk4(u, w, h);
    if (un >= 1) return { status: 'captured', phi, u, w, steps, b };
    u = un; w = wn; phi += h;
  }
  return { status: 'budget', phi, u, w, steps, b };
}

/** Asymptotic direction of travel (angle in the orbital plane). */
const dirOut = s => s.phi - Math.atan2(s.u, s.w) + Math.PI;
/** Naive instantaneous-tangent estimate at the escape radius. */
const tangent = s => {
  // tangent = dr/dφ · rad + r · tanv  →  its angle is atan2(r, dr/dφ) from rad
  const drdphi = -s.w / (s.u * s.u);
  const r = 1 / s.u;
  return s.phi + Math.atan2(r, drdphi);
};

/* ── reference solution with a very fine step ─────────────────────────── */
function reference(psi) {
  const coarse = trace(psi, 1e-6, 4_000_000);
  return coarse;
}

const deg = x => (x * 180 / Math.PI);

console.log(`h=${H}  r_cam=${R_CAM}  escapeR=${ESCAPE}  maxSteps=${MAXSTEPS}\n`);
console.log('  psi°     b      steps   φ_out(rad)      Δφ_out vs ref      tangent err');
console.log('─'.repeat(78));

const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
let prev = null, maxJump = 0, jumpAt = 0, maxErr = 0, errAt = 0;
for (let psiDeg = 8.0; psiDeg <= 34.0; psiDeg += 0.1) {
  const psi = psiDeg * Math.PI / 180;
  const s = trace(psi, H);
  const ref = reference(psi);
  const e = wrap(dirOut(s) - dirOut(ref));
  const te = wrap(tangent(s) - dirOut(ref));
  if (prev !== null) {
    const jump = Math.abs(wrap(e - prev));
    if (jump > maxJump) { maxJump = jump; jumpAt = psiDeg; }
  }
  prev = e;
  if (Math.abs(e) > maxErr) { maxErr = Math.abs(e); errAt = psiDeg; }
  if (Math.abs(psiDeg * 2 - Math.round(psiDeg * 2)) < 1e-9 && Math.round(psiDeg * 2) % 2 === 0) {
    console.log(
      `${psiDeg.toFixed(2).padStart(6)}  ${s.b.toFixed(3).padStart(7)}  ${String(s.steps).padStart(5)}` +
      `  ${dirOut(s).toFixed(6).padStart(12)}  ${deg(e).toFixed(4).padStart(14)}°  ${deg(te).toFixed(4).padStart(12)}°`
    );
  }
}
console.log('─'.repeat(78));
console.log(`largest step-to-step jump in the error: ${deg(maxJump).toFixed(4)}° at psi=${jumpAt}°`);
console.log(`largest |error| vs fine reference    : ${deg(maxErr).toFixed(4)}° at psi=${errAt}°`);
