#!/usr/bin/env node
/**
 * tools/make-audio.mjs
 * ---------------------------------------------------------------------------
 * Offline, zero-dependency procedural music generator for the "Gargantua"
 * black-hole visualization site.
 *
 *   node tools/make-audio.mjs            -> synthesize + write + verify
 *   node tools/make-audio.mjs --verify   -> re-read the WAV and verify only
 *
 * Output: assets/audio/ambient-drone.wav
 *   30.0 s / 44100 Hz / 16-bit signed PCM / stereo / RIFF-WAVE / < 6 MB
 *
 * Everything below is hand-written: the PRNG, the oscillators, the LFOs, the
 * biquad filter math and the RIFF writer. No npm packages, no Web Audio.
 *
 * Seamless-loop strategy
 * ----------------------
 * 1. Every oscillator frequency and every LFO frequency is quantized to an
 *    exact integer multiple of the loop fundamental (1/30 Hz). Sample phases
 *    are evaluated as  TWO_PI * ((k * n) % N) / N  which is bit-exactly
 *    periodic over N samples (k*n < 2^53 so the modulo is exact).
 * 2. Noise cannot be made periodic, so the raw signal is rendered with an
 *    extra 2.0 s tail (N + L samples). The tail is equal-power (sin/cos)
 *    crossfaded into the first 2.0 s, and the buffer is truncated back to
 *    exactly N samples. The loop joint then sits *inside* the continuous raw
 *    stream: out[N-1] = raw[N-1] and out[0] = raw[N], which are consecutive
 *    samples of one smooth signal -> no fade dip and no click.
 * 3. A constant DC offset is removed afterwards (a constant is periodic, so
 *    this cannot break the loop).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const OUT_REL = join('assets', 'audio', 'ambient-drone.wav');
const OUT_PATH = join(PROJECT_ROOT, OUT_REL);

const SAMPLE_RATE = 44100;
const DURATION_S = 30.0;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

const N = Math.round(SAMPLE_RATE * DURATION_S); // 1_323_000 frames
const LOOP_FUNDAMENTAL = 1 / DURATION_S; // Hz — the quantization grid
const QUANTUM_INDEX = (hz) => Math.round(hz * DURATION_S); // -> integer k
const TWO_PI = Math.PI * 2;

const XFADE_S = 2.0;
const L = Math.round(XFADE_S * SAMPLE_RATE); // 88_200 frames
const RAW_N = N + L; // render length before crossfade fold-back

const PRNG_SEED = 0x5eed1a7e;
const NOISE_PREROLL = 8192; // warm-up samples so the wash starts stationary

// Level targets.
const RMS_TARGET_DB = -20.0;
const PEAK_MAX_DB = -5.5;
const PEAK_MIN_DB = -8.5;
const PEAK_FALLBACK_DB = -6.5;
const MAX_PEAK_FS = 0.9; // hard safety ceiling

// Noise wash mix (relative amplitude vs. the tonal layer) and band edges.
const NOISE_MIX = 0.18;
const NOISE_HP_HZ = 100;
const NOISE_LP_HZ = 900;
const BIQUAD_Q = Math.SQRT1_2; // Butterworth

// Detune partners, expressed on the 1/30 Hz grid: 5..18 quanta
// => +/-0.1667 Hz .. +/-0.6 Hz. Slow beating, never a chorus.
const DETUNE_QUANTA = [5, 7, 9, 12, 15, 18];
const PARTNER_GAIN = 0.5; // each detuned partner vs. its centre partial
const CHANNEL_LFO_PHASE = 0.85; // rad — decorrelates L/R modulation a little

/**
 * Tonal skeleton: root A1 = 55 Hz plus fifth / octave / octave+fifth /
 * two octaves and two very quiet shimmer partials. Every `hz` lands exactly on
 * the 1/30 Hz grid. Each partial is driven by its own slow LFO whose period
 * divides 30 s exactly (30 / 15 / 10 / 7.5 / 6 / 5 s).
 */
const PARTIALS = [
  { name: 'root         A1  55.00 Hz', hz: 55.0, gain: 0.5000, lfoK: 1, lfoDepth: 0.45 },
  { name: 'fifth        E2  82.50 Hz', hz: 82.5, gain: 0.3000, lfoK: 2, lfoDepth: 0.55 },
  { name: 'octave       A2 110.00 Hz', hz: 110.0, gain: 0.2400, lfoK: 3, lfoDepth: 0.50 },
  { name: 'octave+fifth E3 165.00 Hz', hz: 165.0, gain: 0.1400, lfoK: 4, lfoDepth: 0.60 },
  { name: 'two octaves  A3 220.00 Hz', hz: 220.0, gain: 0.1000, lfoK: 5, lfoDepth: 0.55 },
  { name: 'shimmer      A4 440.00 Hz', hz: 440.0, gain: 0.0200, lfoK: 6, lfoDepth: 0.70 },
  { name: 'shimmer      E5 660.00 Hz', hz: 660.0, gain: 0.0120, lfoK: 3, lfoDepth: 0.65 },
];

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Deterministic PRNG (mulberry32). Same seed => same file, forever. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Exact periodic phase. `k` is an integer number of cycles per 30 s buffer, so
 * phase(n) === phase(n + N) bit-exactly (k*n stays well under 2^53).
 */
const phaseOf = (k, n) => (TWO_PI * ((k * n) % N)) / N;

// ---------------------------------------------------------------------------
// Biquad filters (RBJ cookbook, direct form II transposed) — hand rolled.
// ---------------------------------------------------------------------------

function biquadCoeffs(type, f0, q, fs) {
  const w0 = (TWO_PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0;
  let b1;
  let b2;
  if (type === 'lp') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
  } else if (type === 'hp') {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
  } else {
    throw new Error(`unknown biquad type: ${type}`);
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquadRun(input, c) {
  const out = new Float64Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    out[i] = y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voice construction
// ---------------------------------------------------------------------------

/**
 * Build the per-channel component table. Channel 0 (L) and channel 1 (R) share
 * the centre partial (same frequency AND same phase => mono compatible) but get
 * different detune partners, different partner phases and a small LFO phase
 * offset (=> stereo width that survives a mono fold-down).
 */
function buildComponents() {
  const rng = makeRng(PRNG_SEED ^ 0x9e3779b9);
  const perChannel = [[], []];
  const centrePhases = PARTIALS.map(() => 0);
  // Draw the shared centre phases first so the PRNG order is stable.
  for (let i = 0; i < PARTIALS.length; i++) centrePhases[i] = rng() * TWO_PI;

  let maxHz = 0;
  for (let i = 0; i < PARTIALS.length; i++) {
    const p = PARTIALS[i];
    const kCentre = QUANTUM_INDEX(p.hz);
    if (Math.abs(kCentre / DURATION_S - p.hz) > 1e-9) {
      throw new Error(`partial ${p.name} is off the 1/30 Hz grid`);
    }
    const dL = DETUNE_QUANTA[i % DETUNE_QUANTA.length];
    const dR = DETUNE_QUANTA[(i + 2) % DETUNE_QUANTA.length];
    for (let ch = 0; ch < CHANNELS; ch++) {
      const sign = ch === 0 ? +1 : -1;
      const d = ch === 0 ? dL : dR;
      const kPartner = kCentre + sign * d;
      const lfoPhase = ch * CHANNEL_LFO_PHASE;
      // Centre: identical frequency + phase in both channels.
      perChannel[ch].push({
        partial: i,
        kind: 'centre',
        k: kCentre,
        amp: p.gain,
        phase: centrePhases[i],
        lfoK: p.lfoK,
        lfoDepth: p.lfoDepth,
        lfoPhase,
      });
      // Detuned partner: unique frequency + phase per channel.
      perChannel[ch].push({
        partial: i,
        kind: 'partner',
        k: kPartner,
        amp: p.gain * PARTNER_GAIN,
        phase: rng() * TWO_PI,
        lfoK: p.lfoK,
        lfoDepth: p.lfoDepth,
        lfoPhase,
      });
      maxHz = Math.max(maxHz, Math.abs(kPartner) / DURATION_S);
    }
  }
  const lfoKinds = [...new Set(PARTIALS.map((p, i) => p.lfoK))].sort((a, b) => a - b);
  return { perChannel, maxHz, lfoKinds };
}

/** Analytic tonal sample — used by the renderer and by the periodicity proof. */
function tonalSampleAt(comps, n, ch) {
  let s = 0;
  for (const c of comps.perChannel[ch]) {
    const lfo = 1 + c.lfoDepth * Math.sin(phaseOf(c.lfoK, n) + c.lfoPhase);
    s += c.amp * lfo * Math.sin(phaseOf(c.k, n) + c.phase);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTonal(comps) {
  const buf = [new Float64Array(RAW_N), new Float64Array(RAW_N)];
  for (let ch = 0; ch < CHANNELS; ch++) {
    const out = buf[ch];
    const list = comps.perChannel[ch];
    // Pre-flatten constants for the inner loop.
    const n_ = list.length;
    const k = new Float64Array(n_);
    const amp = new Float64Array(n_);
    const ph = new Float64Array(n_);
    const lk = new Int32Array(n_);
    const ld = new Float64Array(n_);
    const lp = new Float64Array(n_);
    for (let j = 0; j < n_; j++) {
      k[j] = list[j].k;
      amp[j] = list[j].amp;
      ph[j] = list[j].phase;
      lk[j] = list[j].lfoK;
      ld[j] = list[j].lfoDepth;
      lp[j] = list[j].lfoPhase;
    }
    for (let n = 0; n < RAW_N; n++) {
      let s = 0;
      for (let j = 0; j < n_; j++) {
        const lfo = 1 + ld[j] * Math.sin(phaseOf(lk[j], n) + lp[j]);
        s += amp[j] * lfo * Math.sin(phaseOf(k[j], n) + ph[j]);
      }
      out[n] = s;
    }
  }
  return buf;
}

/** White noise -> HP 100 Hz -> 2x LP 900 Hz. Filter math implemented above. */
function renderNoise() {
  const hp = biquadCoeffs('hp', NOISE_HP_HZ, BIQUAD_Q, SAMPLE_RATE);
  const lp = biquadCoeffs('lp', NOISE_LP_HZ, BIQUAD_Q, SAMPLE_RATE);
  const lp2 = biquadCoeffs('lp', NOISE_LP_HZ, 0.9, SAMPLE_RATE);
  const total = RAW_N + NOISE_PREROLL;
  const buf = [new Float64Array(RAW_N), new Float64Array(RAW_N)];
  for (let ch = 0; ch < CHANNELS; ch++) {
    const rng = makeRng(PRNG_SEED ^ (0x51ed2701 + ch * 0x1f123bb5));
    const white = new Float64Array(total);
    for (let i = 0; i < total; i++) white[i] = rng() * 2 - 1;
    const filtered = biquadRun(biquadRun(biquadRun(white, hp), lp), lp2);
    const out = buf[ch];
    for (let i = 0; i < RAW_N; i++) out[i] = filtered[i + NOISE_PREROLL];
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function measure(chans, frames) {
  let peak = 0;
  let sumSq = 0;
  let sumL = 0;
  let sumR = 0;
  const l = chans[0];
  const r = chans[1];
  for (let i = 0; i < frames; i++) {
    const a = l[i];
    const b = r[i];
    const aa = Math.abs(a);
    const ab = Math.abs(b);
    if (aa > peak) peak = aa;
    if (ab > peak) peak = ab;
    sumSq += a * a + b * b;
    sumL += a;
    sumR += b;
  }
  const rms = Math.sqrt(sumSq / (2 * frames));
  return { peak, rms, dcL: sumL / frames, dcR: sumR / frames };
}

function correlation(l, r, frames) {
  let ml = 0;
  let mr = 0;
  for (let i = 0; i < frames; i++) {
    ml += l[i];
    mr += r[i];
  }
  ml /= frames;
  mr /= frames;
  let num = 0;
  let dl = 0;
  let dr = 0;
  for (let i = 0; i < frames; i++) {
    const a = l[i] - ml;
    const b = r[i] - mr;
    num += a * b;
    dl += a * a;
    dr += b * b;
  }
  const den = Math.sqrt(dl * dr);
  return den > 0 ? num / den : 0;
}

/** Goertzel magnitude at one frequency (spectral probe, no FFT needed). */
function goertzel(x, frames, freq, sampleRate = SAMPLE_RATE) {
  const w = (TWO_PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < frames; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / frames;
}

/**
 * Independent click detector. Fit an order-`order` linear predictor
 * (Levinson-Durbin on the interior autocorrelation), then predict y[0] from the
 * looped past y[N-1], y[N-2], ... If the buffer were cut mid-waveform the joint
 * prediction error would be a wild outlier; a seamless loop makes it an
 * ordinary sample. Returns the percentile of the joint error.
 */
function lpcJointPercentile(x, frames, order = 64) {
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let i = k; i < frames; i++) s += x[i] * x[i - k];
    r[k] = s / frames;
  }
  if (!(r[0] > 0)) return 100;
  const a = new Float64Array(order + 1);
  const prev = new Float64Array(order + 1);
  let err = r[0];
  a[0] = 1;
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc -= a[j] * r[i - j];
    const k = err > 0 ? acc / err : 0;
    prev.set(a.subarray(0, i));
    a[i] = k;
    for (let j = 1; j < i; j++) a[j] = prev[j] - k * prev[i - j];
    err *= 1 - k * k;
  }
  const predict = (n) => {
    let p = 0;
    for (let j = 1; j <= order; j++) p += a[j] * x[(n - j + frames) % frames];
    return p;
  };
  const joint = Math.abs(x[0] - predict(0));
  let below = 0;
  let total = 0;
  for (let n = order; n < frames; n++) {
    let p = 0;
    for (let j = 1; j <= order; j++) p += a[j] * x[n - j];
    total++;
    if (Math.abs(x[n] - p) < joint) below++;
  }
  return total > 0 ? (below / total) * 100 : 100;
}

// ---------------------------------------------------------------------------
// Synthesis pipeline
// ---------------------------------------------------------------------------

function synthesize() {
  const comps = buildComponents();
  const tonal = renderTonal(comps);
  const noise = renderNoise();

  // Mix keyed off the tonal level so the wash is always a fixed low fraction.
  const tonalStats = measure(tonal, RAW_N);
  const noiseStats = measure(noise, RAW_N);
  const noiseGain =
    noiseStats.rms > 0 ? (tonalStats.rms * NOISE_MIX) / noiseStats.rms : 0;

  // Equal-power (sin/cos) crossfade: fold the 2 s tail back onto the head, then
  // truncate to exactly N frames. sin^2 + cos^2 = 1 => constant power.
  const out = [new Float64Array(N), new Float64Array(N)];
  let xfadeMaxErr = 0;
  for (let ch = 0; ch < CHANNELS; ch++) {
    const raw = new Float64Array(RAW_N);
    const t = tonal[ch];
    const nz = noise[ch];
    for (let i = 0; i < RAW_N; i++) raw[i] = t[i] + nz[i] * noiseGain;

    const o = out[ch];
    for (let n = 0; n < N; n++) {
      if (n < L) {
        const a = (Math.PI / 2) * (n / L);
        const s = Math.sin(a);
        const c = Math.cos(a);
        o[n] = raw[n] * s + raw[N + n] * c;
        const p = s * s + c * c;
        const e = Math.abs(p - 1);
        if (e > xfadeMaxErr) xfadeMaxErr = e;
      } else {
        o[n] = raw[n];
      }
    }
  }

  // DC removal (constant offset => still perfectly periodic).
  const preStats = measure(out, N);
  for (let ch = 0; ch < CHANNELS; ch++) {
    const dc = ch === 0 ? preStats.dcL : preStats.dcR;
    const o = out[ch];
    for (let i = 0; i < N; i++) o[i] -= dc;
  }

  // Normalize: aim for -20 dBFS RMS, then pull the peak into [-8.5, -5.5] dBFS.
  const stats = measure(out, N);
  let scale = dbToLin(RMS_TARGET_DB) / stats.rms;
  let peakFS = stats.peak * scale;
  if (peakFS > dbToLin(PEAK_MAX_DB)) {
    scale = dbToLin(PEAK_MAX_DB) / stats.peak;
    peakFS = dbToLin(PEAK_MAX_DB);
  } else if (peakFS < dbToLin(PEAK_MIN_DB)) {
    scale = dbToLin(PEAK_FALLBACK_DB) / stats.peak;
    peakFS = dbToLin(PEAK_FALLBACK_DB);
  }
  for (let ch = 0; ch < CHANNELS; ch++) {
    const o = out[ch];
    for (let i = 0; i < N; i++) o[i] *= scale;
  }

  const final = measure(out, N);
  if (final.peak >= MAX_PEAK_FS) {
    throw new Error(`peak ${final.peak} FS exceeds the ${MAX_PEAK_FS} FS ceiling`);
  }

  return { channels: out, comps, noiseGain, xfadeMaxErr, stats: final };
}

// ---------------------------------------------------------------------------
// WAV container
// ---------------------------------------------------------------------------

function encodeWav(channels) {
  const dataBytes = N * CHANNELS * BYTES_PER_SAMPLE;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  buf.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let clipped = 0;
  let off = 44;
  const l = channels[0];
  const r = channels[1];
  for (let i = 0; i < N; i++) {
    for (let ch = 0; ch < CHANNELS; ch++) {
      const v = ch === 0 ? l[i] : r[i];
      let s = Math.round(v * 32767);
      if (s > 32767) {
        s = 32767;
        clipped++;
      } else if (s < -32768) {
        s = -32768;
        clipped++;
      }
      buf.writeInt16LE(s, off);
      off += 2;
    }
  }
  return { buf, clipped };
}

function parseWav(buf) {
  if (buf.length < 44) throw new Error('file shorter than a minimal RIFF/WAVE header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('missing RIFF magic');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('missing WAVE magic');
  const riffSize = buf.readUInt32LE(4);
  let off = 12;
  const chunks = [];
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    chunks.push({ id, size, body });
    if (id === 'fmt ') {
      fmt = {
        size,
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { size, body };
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new Error('no fmt chunk');
  if (!data) throw new Error('no data chunk');
  return { riffSize, chunks, fmt, data };
}

function decodeWav(buf, parsed) {
  const { fmt, data } = parsed;
  const frames = Math.floor(data.size / (fmt.channels * (fmt.bitsPerSample / 8)));
  const l = new Float64Array(frames);
  const r = new Float64Array(frames);
  let off = data.body;
  let clipped = 0;
  for (let i = 0; i < frames; i++) {
    const a = buf.readInt16LE(off);
    const b = fmt.channels > 1 ? buf.readInt16LE(off + 2) : a;
    off += fmt.channels * 2;
    if (a === 32767 || a === -32768 || b === 32767 || b === -32768) clipped++;
    l[i] = a / 32767;
    r[i] = b / 32767;
  }
  return { frames, l, r, clipped };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function verifyFile(path) {
  const lines = [];
  const checks = [];
  const add = (ok, label, detail) => {
    checks.push({ ok, label, detail });
    lines.push(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  };

  let buf;
  try {
    buf = readFileSync(path);
  } catch (err) {
    return { lines: [`  [FAIL] cannot read ${path} — ${err.message}`], ok: false };
  }

  let parsed;
  let dec;
  try {
    parsed = parseWav(buf);
    dec = decodeWav(buf, parsed);
  } catch (err) {
    return { lines: [`  [FAIL] RIFF parse error — ${err.message}`], ok: false };
  }

  const { fmt, data, riffSize } = parsed;
  const frames = dec.frames;

  add(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE',
    'RIFF/WAVE magic', `"${buf.toString('ascii', 0, 4)}"/"${buf.toString('ascii', 8, 12)}"`);
  add(fmt.audioFormat === 1, 'format is PCM', `audioFormat=${fmt.audioFormat}`);
  add(fmt.bitsPerSample === 16, '16-bit samples', `${fmt.bitsPerSample} bit`);
  add(fmt.channels === 2, 'stereo', `${fmt.channels} ch`);
  add(fmt.sampleRate === SAMPLE_RATE, 'sample rate 44100 Hz', `${fmt.sampleRate} Hz`);
  add(frames === N, 'exactly 30.000 s', `${frames} frames = ${(frames / SAMPLE_RATE).toFixed(6)} s`);
  add(fmt.byteRate === SAMPLE_RATE * 2 * 2 && fmt.blockAlign === 4,
    'byteRate/blockAlign consistent', `byteRate=${fmt.byteRate} blockAlign=${fmt.blockAlign}`);
  add(riffSize === buf.length - 8 && data.size === frames * 4,
    'chunk sizes consistent', `riffSize=${riffSize} dataSize=${data.size} fileSize=${buf.length}`);
  add(buf.length < 6 * 1024 * 1024, 'file under 6 MB',
    `${buf.length} bytes (${(buf.length / 1048576).toFixed(2)} MiB)`);

  const stats = measure([dec.l, dec.r], frames);
  const peakDb = linToDb(stats.peak);
  const rmsDb = linToDb(stats.rms);
  const crestDb = peakDb - rmsDb;
  const corr = correlation(dec.l, dec.r, frames);

  add(peakDb >= -9 && peakDb <= -5, 'peak between -9 and -5 dBFS', `${peakDb.toFixed(2)} dBFS`);
  add(stats.peak < MAX_PEAK_FS, `peak < ${MAX_PEAK_FS} FS`, `${stats.peak.toFixed(6)} FS`);
  add(dec.clipped === 0, 'no clipped samples (|x| = 32767)', `${dec.clipped} samples at full scale`);
  add(rmsDb >= -22 && rmsDb <= -18, 'RMS near -20 dBFS', `${rmsDb.toFixed(2)} dBFS`);
  add(corr >= 0.2 && corr <= 0.85, 'L/R correlation in [0.2, 0.85]', corr.toFixed(4));
  add(Number.isFinite(peakDb) && Number.isFinite(rmsDb), 'no NaN/Inf samples', 'all finite');

  // ---- loop discontinuity, analytic: value at t=0 vs. value at t=30 s --------
  const comps = buildComponents();
  let maxDisc = 0;
  for (let ch = 0; ch < CHANNELS; ch++) {
    const d = Math.abs(tonalSampleAt(comps, 0, ch) - tonalSampleAt(comps, N, ch));
    if (d > maxDisc) maxDisc = d;
  }
  add(maxDisc < 1e-3, 'loop discontinuity (analytic t=0 vs t=30 s) < 1e-3 FS',
    `${maxDisc.toExponential(3)} FS`);

  // ---- loop joint step vs. interior step (click detector) -------------------
  let jointStep = Math.abs(dec.l[0] - dec.l[frames - 1]);
  const jr = Math.abs(dec.r[0] - dec.r[frames - 1]);
  if (jr > jointStep) jointStep = jr;
  let interiorMax = 0;
  for (let i = 1; i < frames - 1; i++) {
    const a = Math.abs(dec.l[i + 1] - dec.l[i]);
    const b = Math.abs(dec.r[i + 1] - dec.r[i]);
    if (a > interiorMax) interiorMax = a;
    if (b > interiorMax) interiorMax = b;
  }
  const ratio = interiorMax > 0 ? jointStep / interiorMax : 0;
  add(ratio <= 1.0, 'loop joint step no larger than the largest interior step',
    `joint=${jointStep.toFixed(6)} FS, interiorMax=${interiorMax.toFixed(6)} FS, ratio=${ratio.toFixed(3)}`);

  // ---- independent click detector: linear prediction across the joint -------
  const pctL = lpcJointPercentile(dec.l, frames);
  const pctR = lpcJointPercentile(dec.r, frames);
  const worstPct = Math.max(pctL, pctR);
  add(worstPct < 99, 'loop joint is an ordinary sample under order-64 linear prediction',
    `L percentile ${pctL.toFixed(2)}%, R percentile ${pctR.toFixed(2)}% (a cut waveform scores ~100%)`);

  // ---- spectral sanity: band-limited, nothing ultrasonic --------------------
  const probeLen = Math.min(32768, frames);
  const mag = (f) => goertzel(dec.l, probeLen, f);
  const ref = Math.max(mag(110), 1e-12);
  const dbAt = (f) => 20 * Math.log10(Math.max(mag(f), 1e-12) / ref);
  const at3k = dbAt(3000);
  const at10k = dbAt(10000);
  add(comps.maxHz < 2000, 'all oscillator partials below 2 kHz',
    `highest partial = ${comps.maxHz.toFixed(3)} Hz`);
  add(at3k < -60 && at10k < -60, 'no ultrasonic content (3 kHz / 10 kHz >= 60 dB below 110 Hz)',
    `3 kHz ${at3k.toFixed(1)} dB, 10 kHz ${at10k.toFixed(1)} dB`);

  // ---- LFO rates ------------------------------------------------------------
  const lfoHz = comps.lfoKinds.map((k) => k / DURATION_S);
  const fastest = Math.max(...lfoHz);
  add(fastest <= 0.5 && comps.lfoKinds.length >= 4,
    'at least 4 LFOs, none faster than 0.5 Hz',
    `${comps.lfoKinds.length} LFOs: ${lfoHz.map((f) => f.toFixed(4)).join(', ')} Hz`);

  lines.push('');
  lines.push(`  loop discontinuity : ${maxDisc.toExponential(3)} FS (analytic, t=0 vs t=30 s)`);
  lines.push(`  loop joint step    : ${jointStep.toExponential(3)} FS (ratio to interior max ${ratio.toFixed(3)})`);
  lines.push(`  peak               : ${peakDb.toFixed(2)} dBFS (${stats.peak.toFixed(6)} FS)`);
  lines.push(`  RMS                : ${rmsDb.toFixed(2)} dBFS (${stats.rms.toFixed(6)} FS)`);
  lines.push(`  crest factor       : ${crestDb.toFixed(2)} dB`);
  lines.push(`  L/R correlation    : ${corr.toFixed(4)}`);
  lines.push(`  DC offset          : L ${stats.dcL.toExponential(2)}  R ${stats.dcR.toExponential(2)}`);

  return { lines, ok: checks.every((c) => c.ok), stats, corr, maxDisc, ratio, peakDb, rmsDb };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  return `${n} bytes (${(n / 1048576).toFixed(2)} MiB)`;
}

function main() {
  const verifyOnly = process.argv.slice(2).includes('--verify');

  if (!verifyOnly) {
    const t0 = Date.now();
    const { channels, comps, noiseGain, xfadeMaxErr, stats } = synthesize();
    const { buf, clipped } = encodeWav(channels);
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, buf);

    const peakDb = linToDb(stats.peak);
    const rmsDb = linToDb(stats.rms);

    console.log('=== Gargantua ambient drone — synthesis report ===');
    console.log(`output             : ${relative(PROJECT_ROOT, OUT_PATH)}`);
    console.log(`duration           : ${(N / SAMPLE_RATE).toFixed(3)} s`);
    console.log(`sample rate        : ${SAMPLE_RATE} Hz`);
    console.log(`channels           : ${CHANNELS} (stereo, ${BITS_PER_SAMPLE}-bit signed PCM)`);
    console.log(`frames             : ${N}`);
    console.log(`byte size          : ${fmtBytes(buf.length)}`);
    console.log(`peak               : ${peakDb.toFixed(2)} dBFS (${stats.peak.toFixed(6)} FS)`);
    console.log(`RMS                : ${rmsDb.toFixed(2)} dBFS (${stats.rms.toFixed(6)} FS)`);
    console.log(`crest factor       : ${(peakDb - rmsDb).toFixed(2)} dB`);
    console.log(`noise wash         : ${NOISE_HP_HZ}-${NOISE_LP_HZ} Hz biquad band, mix gain ${noiseGain.toFixed(4)}`);
    console.log(`loop crossfade     : ${XFADE_S.toFixed(2)} s equal-power sin/cos (sin^2+cos^2-1 max err ${xfadeMaxErr.toExponential(2)})`);
    console.log(`quantization grid  : 1/${DURATION_S} Hz (every osc + LFO frequency is an integer multiple)`);
    console.log(`PRNG seed          : 0x${PRNG_SEED.toString(16)} (mulberry32, deterministic)`);
    console.log(`clipped samples    : ${clipped}`);
    console.log('partials:');
    for (const p of PARTIALS) {
      const k = QUANTUM_INDEX(p.hz);
      console.log(`  ${p.name}  k=${String(k).padStart(5)}  gain=${p.gain.toFixed(4)}  LFO ${(p.lfoK / DURATION_S).toFixed(4)} Hz (${(DURATION_S / p.lfoK).toFixed(2)} s)`);
    }
    console.log('detune partners    : ' + DETUNE_QUANTA.map((q) => `${(q / DURATION_S >= 0 ? '+' : '')}${(q / DURATION_S).toFixed(4)}`).join(', ') + ' Hz');
    console.log(`highest partial    : ${comps.maxHz.toFixed(3)} Hz`);
    console.log(`render time        : ${((Date.now() - t0) / 1000).toFixed(2)} s`);
  } else {
    console.log('=== Gargantua ambient drone — verify (--verify) ===');
    console.log(`input              : ${relative(PROJECT_ROOT, OUT_PATH)}`);
  }

  console.log('');
  console.log('=== verification (re-read from disk) ===');
  const res = verifyFile(OUT_PATH);
  for (const line of res.lines) console.log(line);
  console.log('');
  console.log(res.ok ? 'ALL CHECKS PASSED' : 'ONE OR MORE CHECKS FAILED');
  if (!res.ok) process.exitCode = 1;
}

main();
