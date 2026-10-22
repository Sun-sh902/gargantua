#!/usr/bin/env node
/**
 * GARGANTUA — visual acceptance matrix.
 *
 * Renders every camera preset and every debug view through the headless
 * capture harness and asserts, for each frame, that
 *   · the page produced no console errors / uncaught exceptions,
 *   · the frame is not black (mean luminance and bright-pixel fraction),
 *   · a PNG was actually written.
 *
 *   node tests/visual-matrix.mjs [--base http://127.0.0.1:8123] [--size 640x360] [--out shots/matrix]
 *
 * Exit code 0 = every frame passed.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const BASE = arg('base', 'http://127.0.0.1:8123');
const [W, H] = arg('size', '640x360').split('x').map(Number);
const OUT = path.resolve(ROOT, arg('out', 'shots/matrix'));

const PRESETS = ['INTERSTELLAR', 'OVERHEAD', 'PHOTON-RING', 'WIDE'];
const VIEWS = ['BEAUTY', 'STEPS', 'CROSSINGS', 'REDSHIFT', 'NEWTONIAN', 'SKY', 'IMPACT', 'TEMPERATURE', 'BLOOM', 'DEPTH'];

await mkdir(OUT, { recursive: true });

function run(args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'capture.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
  });
}

const rows = [];
let failures = 0;

async function shot(label, query, file) {
  const url = `${BASE}/?shot=1&hud=0&frames=3&${query}`;
  const json = path.join(OUT, file + '.json');
  const png = path.join(OUT, file + '.png');
  const { code, out } = await run(['--url', url, '--out', png, '--json', json, '--width', String(W), '--height', String(H), '--wait', '90000', '--settle', '150']);
  let report = null;
  try { report = JSON.parse(await readFile(json, 'utf8')); } catch (e) { /* keep null */ }
  const errors = report ? report.errors.length : -1;
  const lum = report && report.luminance ? report.luminance : null;
  const ok = code === 0 && errors === 0 && lum && report.nonBlack === true;
  if (!ok) failures++;
  rows.push({
    label, ok, code, errors,
    mean: lum ? (lum.mean * 255).toFixed(1) : '–',
    max: lum ? (lum.max * 255).toFixed(0) : '–',
    bright: lum ? (lum.brightFraction * 100).toFixed(1) + '%' : '–',
    size: report ? `${report.width}×${report.height}` : '–',
    file: path.relative(ROOT, png),
    note: report && !report.nonBlack ? 'BLACK FRAME' : (report && report.errors[0] ? String(report.errors[0].text).slice(0, 60) : ''),
  });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} mean=${rows.at(-1).mean.padStart(5)} max=${rows.at(-1).max.padStart(3)} bright=${rows.at(-1).bright.padStart(6)} ${rows.at(-1).note}\n`);
}

console.log(`GARGANTUA visual matrix — ${W}×${H}, base ${BASE}\n`);

console.log('[presets]');
for (let i = 0; i < 4; i++) await shot(`preset ${i + 1} ${PRESETS[i]}`, `preset=${i}`, `preset${i + 1}`);

console.log('\n[debug views]');
for (let i = 0; i < 10; i++) await shot(`view ${i} ${VIEWS[i]}`, `debug=${i}`, `view${i}`);

console.log('\n[quality tiers]');
for (const q of ['standard', 'high', 'cinematic']) await shot(`quality ${q}`, `quality=${q}&debug=0`, `quality-${q}`);

console.log('\n[parameters]');
await shot('doppler off', 'doppler=0', 'param-nodoppler');
await shot('no disk', 'disk=0', 'param-nodisk');
await shot('galaxy only', 'starBrightness=0&nebula=0&debug=5', 'param-galaxy');
await shot('close approach', 'diskInner=2.2&diskOuter=28&fov=70', 'param-wide-disk');

console.log(`\n${rows.length - failures}/${rows.length} frames passed`);
if (failures) {
  console.log('FAILED:');
  for (const r of rows.filter(r => !r.ok)) console.log(`  · ${r.label} (exit ${r.code}, ${r.errors} errors) ${r.note}`);
}
process.exit(failures ? 1 : 0);
