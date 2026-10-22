#!/usr/bin/env node
/**
 * float32-emulated copy of the shader's geodesic loop.
 * Determines whether the concentric ring artefact is a truncation error or a
 * single-precision rounding effect, and which quantity carries it.
 */
const F = Math.fround;
const mul = (a, b) => F(a * b), add = (a, b) => F(a + b);

const R_CAM = 21, ESCAPE = 260, MAXSTEPS = 1200;

function rk4(u, w, h) {
  const k1u = w;
  const k1w = add(-u, mul(1.5, mul(u, u)));
  const ua = add(u, mul(mul(0.5, h), k1u));
  const wa = add(w, mul(mul(0.5, h), k1w));
  const k2u = wa;
  const k2w = add(-ua, mul(1.5, mul(ua, ua)));
  const ub = add(u, mul(mul(0.5, h), k2u));
  const wb = add(w, mul(mul(0.5, h), k2w));
  const k3u = wb;
  const k3w = add(-ub, mul(1.5, mul(ub, ub)));
  const uc = add(u, mul(h, k3u));
  const wc = add(w, mul(h, k3w));
  const k4u = wc;
  const k4w = add(-uc, mul(1.5, mul(uc, uc)));
  const h6 = mul(h, F(1 / 6));
  const un = add(u, mul(h6, add(add(k1u, mul(2, k2u)), add(mul(2, k3u), k4u))));
  const wn = add(w, mul(h6, add(add(k1w, mul(2, k2w)), add(mul(2, k3w), k4w))));
  return [un, wn];
}

function trace(psi, h, f32, maxSteps = MAXSTEPS) {
  const D1 = f32 ? F(-Math.cos(psi)) : -Math.cos(psi);
  const D2 = f32 ? F(Math.sin(psi)) : Math.sin(psi);
  let u = f32 ? F(1 / R_CAM) : 1 / R_CAM;
  let w = f32 ? F(-u * F(D1 / D2)) : -u * (D1 / D2);
  let phi = 0; let steps = 0;
  for (let i = 0; i < maxSteps; i++) {
    const r = 1 / u;
    if (r <= 1) return { st: 'captured', phi, u, w, steps };
    if (r >= ESCAPE) return { st: 'escaped', phi, u, w, steps };
    steps++;
    const [un, wn] = f32 ? rk4(u, w, h) : (() => {
      const k1u = w, k1w = -u + 1.5 * u * u;
      const ua = u + 0.5 * h * k1u, wa = w + 0.5 * h * k1w;
      const k2u = wa, k2w = -ua + 1.5 * ua * ua;
      const ub = u + 0.5 * h * k2u, wb = w + 0.5 * h * k2w;
      const k3u = wb, k3w = -ub + 1.5 * ub * ub;
      const uc = u + h * k3u, wc = w + h * k3w;
      const k4u = wc, k4w = -uc + 1.5 * uc * uc;
      return [u + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u),
              w + (h / 6) * (k1w + 2 * k2w + 2 * k3w + k4w)];
    })();
    if (un >= 1) return { st: 'captured', phi, u, w, steps };
    u = un; w = wn;
    phi = f32 ? F(phi + h) : phi + h;
  }
  return { st: 'budget', phi, u, w, steps };
}

const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const dirOut = s => s.phi - Math.atan2(s.u, s.w) + Math.PI;
const deg = x => x * 180 / Math.PI;

const REF = new Map();
for (let p = 12; p <= 34.0001; p += 0.05) {
  const psi = p * Math.PI / 180;
  REF.set(p.toFixed(2), trace(psi, 1e-5, false, 400000));
}

for (const h of [0.038, 0.019, 0.012, 0.006]) {
  for (const f32 of [true, false]) {
    let maxE = 0, at = 0, maxJ = 0, jat = 0, prev = null;
    for (let p = 8; p <= 34.0001; p += 0.05) {
      const psi = p * Math.PI / 180;
      const s = trace(psi, h, f32);
      const r = REF.get(p.toFixed(2));
      if (!r || r.st !== 'escaped' || s.st !== 'escaped') { prev = null; continue; }
      const e = wrap(dirOut(s) - dirOut(r));
      if (Math.abs(e) > maxE) { maxE = Math.abs(e); at = p; }
      if (prev !== null) { const j = Math.abs(wrap(e - prev)); if (j > maxJ) { maxJ = j; jat = p; } }
      prev = e;
    }
    console.log(`h=${String(h).padEnd(6)} ${f32 ? 'float32' : 'float64'}  max|err|=${deg(maxE).toFixed(4).padStart(9)}° @psi=${at.toFixed(1)}°   max ring jump=${deg(maxJ).toFixed(4).padStart(8)}° @psi=${jat.toFixed(1)}°`);
  }
}
