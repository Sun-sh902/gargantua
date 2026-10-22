#!/usr/bin/env node
/**
 * tools/capture.mjs
 * ---------------------------------------------------------------------------
 * Zero-dependency (Node builtins only) headless-Chrome screenshot + console
 * capture harness for WebGL pages. It talks to Chrome over the raw DevTools
 * Protocol using the global WebSocket — no puppeteer, no npm packages.
 *
 * USAGE
 *   node tools/capture.mjs --url <URL> --out <FILE.png>
 *        [--width 1280] [--height 720] [--wait 20000] [--settle 800]
 *        [--chrome "/path/to/Google Chrome"] [--fullpage] [--json <FILE.json>]
 *        [--flag=<extra chrome flag>]...
 *
 * OPTIONS
 *   --url      <URL>     Page to load. Must already be served; this tool never
 *                        starts a server. (required)
 *   --out      <PATH>    PNG output path. Parent dirs are created. (required)
 *   --json     <PATH>    Optional machine-readable report path.
 *   --width    <PX>      Viewport / window width.  (default 1280)
 *   --height   <PX>      Viewport / window height. (default 720)
 *   --wait     <MS>      Overall readiness deadline. (default 20000)
 *   --settle   <MS>      Extra quiet time after readiness before the shot.
 *                        (default 800, --settle 0 allowed)
 *   --chrome   <PATH>    Chrome binary. (default: macOS Google Chrome)
 *   --fullpage           Capture the full scrollable page (captureBeyondViewport).
 *   --flag=<FLAG>        Append an extra raw Chrome flag; repeatable.
 *   --help               Print this header.
 *
 * READINESS CONTRACT
 *   After Page.navigate the harness polls Runtime.evaluate on
 *   `window.GARGANTUA && window.GARGANTUA.ready`:
 *     - if `ready` is thenable it is awaited (awaitPromise + returnByValue),
 *       bounded per-poll so a never-settling promise cannot eat the deadline;
 *     - otherwise it polls until the value is truthy.
 *   A readiness timeout is not fatal: the screenshot is still taken.
 *
 * WHAT IS COLLECTED (each with ms timestamps relative to harness start)
 *   - console messages         (Runtime.consoleAPICalled: level/source/text)
 *   - uncaught exceptions      (Runtime.exceptionThrown + console error/assert)
 *   - browser log entries      (Log.entryAdded)
 *   - failed requests          (Network.loadingFailed, responses with status>=400)
 *   - shader / WebGL warnings  (console + log entries matching WebGL/GLSL terms)
 *
 * BLACK-SCREEN DETECTION
 *   The captured PNG is decoded in-process with node:zlib + a self-contained
 *   PNG reader (signature, IHDR, IDAT, unfilter; color types 2/6, bit depth 8,
 *   non-interlaced — what Chrome emits). Mean luminance, max luminance and the
 *   bright-pixel fraction (luminance > 8/255) are computed. The frame is
 *   "black" when mean < 1/255 OR brightFraction < 0.001. If decoding fails the
 *   report gets `nonBlack: null` plus a warning instead of crashing.
 *
 * EXIT CODES
 *   0  no captured errors and the screenshot was written
 *   2  the page produced console errors / uncaught exceptions
 *   3  the render looks black
 *   1  harness / setup failure (bad args, Chrome never started, no websocket,
 *      navigation refused, screenshot could not be written)
 *   Precedence is 1 > 2 > 3 (errors are reported before blackness).
 *
 * Chrome is always killed and the temporary user-data-dir always removed on
 * exit, including on error, signal and unhandled rejection.
 * ---------------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOG_CAP = 200;

/* ========================================================================== */
/* CLI                                                                        */
/* ========================================================================== */

const USAGE = [
  'usage: node tools/capture.mjs --url <URL> --out <FILE.png>',
  '         [--width 1280] [--height 720] [--wait 20000] [--settle 800]',
  '         [--chrome <PATH>] [--fullpage] [--json <FILE.json>] [--flag=<FLAG>]...',
].join('\n');

function parseArgs(argv) {
  const opts = {
    url: null,
    out: null,
    json: null,
    width: 1280,
    height: 720,
    wait: 20000,
    settle: 800,
    chrome: process.env.CHROME_PATH || DEFAULT_CHROME,
    fullpage: false,
    flags: [],
    help: false,
  };

  const numeric = new Set(['--width', '--height', '--wait', '--settle']);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let key = raw;
    let val = null;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq !== -1) {
      key = raw.slice(0, eq);
      val = raw.slice(eq + 1);
    }
    const take = () => {
      if (val !== null) return val;
      if (i + 1 >= argv.length) throw new Error(`option ${key} needs a value`);
      return argv[++i];
    };

    switch (key) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--url':
        opts.url = take();
        break;
      case '--out':
        opts.out = take();
        break;
      case '--json':
        opts.json = take();
        break;
      case '--chrome':
        opts.chrome = take();
        break;
      case '--fullpage':
        opts.fullpage = true;
        break;
      case '--flag':
        opts.flags.push(take());
        break;
      default:
        if (numeric.has(key)) {
          const n = Number(take());
          if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
          opts[key.slice(2)] = Math.round(n);
        } else {
          throw new Error(`unknown option: ${raw}`);
        }
    }
  }

  if (opts.help) return opts;
  if (!opts.url) throw new Error('--url is required');
  if (!opts.out) throw new Error('--out is required');
  try {
    // eslint-disable-next-line no-new
    new URL(opts.url);
  } catch {
    throw new Error(`--url is not a valid absolute URL: ${opts.url}`);
  }
  if (opts.width < 1 || opts.height < 1) throw new Error('--width/--height must be >= 1');
  return opts;
}

/* ========================================================================== */
/* Small utilities                                                            */
/* ========================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

/* ========================================================================== */
/* Minimal CDP client over the global WebSocket                               */
/* ========================================================================== */

function openWebSocket(url, timeoutMs) {
  return new Promise((resolveWs, rejectWs) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      rejectWs(err);
      return;
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      rejectWs(new Error(`websocket connect timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolveWs(ws);
    }, { once: true });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      const msg = ev && (ev.message || ev.error?.message) ? (ev.message || ev.error.message) : 'websocket error';
      rejectWs(new Error(`${msg}: ${url}`));
    }, { once: true });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
        else p.resolve(msg.result || {});
      } else if (msg.method) {
        const set = this.listeners.get(msg.method);
        if (set) {
          for (const fn of [...set]) {
            try { fn(msg.params || {}, msg); } catch { /* listener errors are contained */ }
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('websocket closed before response'));
      this.pending.clear();
    });
  }

  /** Send a CDP command; resolves on matching id, rejects on CDP error/timeout. */
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const p = new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        rej(err);
      }
    });
    return withTimeout(p, timeoutMs, `${method} (id ${id})`);
  }

  /** Register an event listener; returns an unsubscribe function. */
  on(method, fn) {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(method);
    };
  }

  /** Resolve once an event fires (or on timeout with ok:false). */
  once(method, timeoutMs) {
    return new Promise((res) => {
      let settled = false;
      const off = this.on(method, (params) => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        res({ ok: true, params });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        res({ ok: false, params: null });
      }, timeoutMs);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/* ========================================================================== */
/* Chrome process                                                             */
/* ========================================================================== */

function spawnChrome({ chrome, userDataDir, width, height, extraFlags }) {
  const args = [
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    // Node's WebSocket may send an Origin header; Chrome >= M111 rejects the
    // DevTools endpoint without this.
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${width},${height}`,
    // Software WebGL2 in headless via ANGLE + SwiftShader.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    // SwiftShader is ~100x slower than a real GPU: without these the GPU
    // watchdog can declare the (perfectly healthy) renderer hung and kill
    // the WebGL context mid-capture.
    '--disable-gpu-watchdog',
    '--disable-hang-monitor',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...extraFlags,
    'about:blank',
  ];

  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (stderr.length < 400000) stderr += s;
    if (process.env.CAPTURE_DEBUG) process.stderr.write(s);
  });
  child.stdout.on('data', (d) => {
    const s = d.toString();
    if (stdout.length < 200000) stdout += s;
    if (process.env.CAPTURE_DEBUG) process.stdout.write(s);
  });
  child.on('error', () => { /* handled by caller via exitCode/launch timeout */ });

  return {
    child,
    args,
    getStderr: () => stderr,
    getStdout: () => stdout,
  };
}

async function waitForDevToolsActivePort(userDataDir, proc, timeoutMs) {
  const file = resolve(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.child.exitCode !== null || proc.child.signalCode) {
      throw new Error(
        `Chrome exited early (code=${proc.child.exitCode} signal=${proc.child.signalCode}). ` +
        `stderr tail:\n${proc.getStderr().slice(-2000)}`,
      );
    }
    if (existsSync(file)) {
      let txt = '';
      try { txt = readFileSync(file, 'utf8'); } catch { /* retry */ }
      const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length >= 2 && /^\d+$/.test(lines[0])) {
        return { port: Number(lines[0]), path: lines[1] };
      }
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for DevToolsActivePort`);
    await sleep(50);
  }
}

/** Attach to the first page target using flat session routing. */
async function attachToPage(cdp) {
  const { targetInfos = [] } = await cdp.send('Target.getTargets');
  let target = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!target) {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    target = { targetId: created.targetId };
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  if (!sessionId) throw new Error('Target.attachToTarget returned no sessionId');
  return sessionId;
}

/* ========================================================================== */
/* Remote-object formatting                                                   */
/* ========================================================================== */

function previewToString(preview) {
  if (!preview) return null;
  const parts = [];
  for (const p of preview.properties || []) {
    parts.push(`${p.name}: ${p.type === 'string' ? JSON.stringify(p.value) : p.value}`);
  }
  if (preview.subtype === 'array') return `[${parts.join(', ')}]`;
  return `{${parts.join(', ')}}`;
}

function remoteObjectToString(a) {
  if (!a) return 'undefined';
  if (a.type === 'string') return a.value ?? '';
  if (a.type === 'undefined') return 'undefined';
  if (a.unserializableValue != null) return String(a.unserializableValue);
  if (a.value !== undefined) {
    try { return JSON.stringify(a.value); } catch { return String(a.value); }
  }
  if (a.description) return a.description;
  const prev = previewToString(a.preview);
  if (prev) return prev;
  return a.type || 'unknown';
}

/* ========================================================================== */
/* Collector                                                                  */
/* ========================================================================== */

const SHADER_RE = /shader|glsl|webgl|webgl2|vertex|fragment|uniform|attribute|texture|framebuffer|renderbuffer|vao|program\b|context lost|swiftshader|angle/i;

function createCollector() {
  const t0 = Date.now();
  const errors = [];
  const warnings = [];
  const logs = [];
  const shaderWarnings = [];
  const failedRequestList = [];
  const requests = new Map(); // requestId -> url
  const recentConsole = []; // { text, t } for cross-domain dedupe

  const ts = () => Date.now() - t0;

  const noteConsole = (text) => {
    recentConsole.push({ text, t: Date.now() });
    while (recentConsole.length > 64) recentConsole.shift();
  };

  const pushLog = (level, source, text, extra = {}) => {
    const entry = { t: ts(), level, source, text: String(text).slice(0, 4000), ...extra };
    logs.push(entry);
    if (level === 'error') errors.push(entry);
    else if (level === 'warning') warnings.push(entry);
    // "shader/WebGL warnings" = warning-level entries that look GL-related.
    // Info/log-level GL chatter is deliberately not promoted to a warning.
    if (level === 'warning' && SHADER_RE.test(entry.text)) shaderWarnings.push(entry);
    return entry;
  };

  const pushConsole = (level, source, text, extra = {}) => {
    noteConsole(text);
    return pushLog(level, source, text, extra);
  };

  const sawConsoleRecently = (text) => {
    const now = Date.now();
    for (let i = recentConsole.length - 1; i >= 0; i--) {
      if (now - recentConsole[i].t > 1500) break;
      if (recentConsole[i].text === text) return true;
    }
    return false;
  };

  return {
    t0,
    errors,
    warnings,
    logs,
    shaderWarnings,
    failedRequestList,
    requests,
    ts,
    pushLog,
    pushConsole,
    noteConsole,
    sawConsoleRecently,
  };
}

function wireCollector(cdp, sessionId, col) {
  // ---- Runtime: console API + uncaught exceptions -------------------------
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map(remoteObjectToString).join(' ');
    const level = p.type === 'warning' ? 'warning'
      : p.type === 'error' || p.type === 'assert' ? 'error'
        : p.type === 'debug' ? 'debug'
          : 'log';
    const loc = p.stackTrace?.callFrames?.[0];
    col.pushConsole(level, `console.${p.type}`, text, {
      url: loc?.url,
      line: loc ? loc.lineNumber + 1 : undefined,
    });
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const exc = d.exception || {};
    const text = exc.description || d.text || 'Uncaught exception';
    col.noteConsole(text);
    const entry = {
      t: col.ts(),
      level: 'error',
      source: 'uncaught',
      text: String(text).slice(0, 4000),
      url: d.url || exc.className,
      line: (d.lineNumber ?? -1) + 1,
      column: (d.columnNumber ?? -1) + 1,
    };
    col.errors.push(entry);
    col.logs.push(entry);
  });

  cdp.on('Runtime.executionContextDestroyed', () => { /* navigation churn, ignore */ });

  // ---- Log domain: browser/GPU/security entries ---------------------------
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    const text = e.text || '';
    // Network failures are owned by the Network domain (loadingFailed /
    // responseReceived >= 400) so a missing favicon is reported as a failed
    // request, not as a page console error.
    if (e.source === 'network') return;
    // Uncaught exceptions are owned by Runtime.exceptionThrown.
    if (e.source === 'javascript' && e.level === 'error') return;
    // console.* is owned by Runtime.consoleAPICalled.
    if (e.source === 'console-api' && col.sawConsoleRecently(text)) return;
    const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : 'log';
    col.pushLog(level, `log.${e.source || 'browser'}`, text, { url: e.url, line: e.lineNumber });
  });

  // ---- Network ------------------------------------------------------------
  cdp.on('Network.requestWillBeSent', (p) => {
    if (p.requestId) col.requests.set(p.requestId, p.request?.url || '');
  });

  cdp.on('Network.responseReceived', (p) => {
    const r = p.response || {};
    if (typeof r.status === 'number' && r.status >= 400) {
      col.failedRequestList.push({
        t: col.ts(),
        kind: 'http-error',
        status: r.status,
        statusText: r.statusText,
        url: r.url || col.requests.get(p.requestId) || '',
        type: p.type,
      });
    }
  });

  cdp.on('Network.loadingFailed', (p) => {
    col.failedRequestList.push({
      t: col.ts(),
      kind: p.canceled ? 'canceled' : 'failed',
      errorText: p.errorText,
      blockedReason: p.blockedReason,
      url: col.requests.get(p.requestId) || '',
      type: p.type,
      canceled: !!p.canceled,
    });
  });
}

/* ========================================================================== */
/* Self-contained PNG decoder (node:zlib + manual unfilter)                   */
/* ========================================================================== */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Decode a non-interlaced, 8-bit, color-type 2 (RGB) or 6 (RGBA) PNG.
 * Returns { width, height, channels, data: Buffer }.
 */
function decodePNG(buf) {
  if (!buf || buf.length < 8) throw new Error('file too short to be a PNG');
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('bad PNG signature');
  }

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const dataStart = off + 8;
    if (dataStart + len + 4 > buf.length) throw new Error(`truncated chunk ${type}`);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('short IHDR');
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4;
  }

  if (!width || !height) throw new Error('missing or empty IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (only 8)`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported color type ${colorType} (only 2/6)`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  if (idat.length === 0) throw new Error('no IDAT data');

  const channels = colorType === 6 ? 4 : 3;
  const bpp = channels;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error(`inflated data too small: ${raw.length} < ${expected}`);

  const out = Buffer.allocUnsafe(stride * height);
  let prev = Buffer.alloc(stride); // scanline 0 has an implicit zero row above it

  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0; // left
      const b = prev[x]; // up
      const c = x >= bpp ? prev[x - bpp] : 0; // up-left
      let v = src[x];
      switch (ft) {
        case 0: break; // None
        case 1: v += a; break; // Sub
        case 2: v += b; break; // Up
        case 3: v += (a + b) >> 1; break; // Average
        case 4: { // Paeth
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${ft} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }

  return { width, height, channels, data: out };
}

/**
 * Mean/max luminance and bright-pixel fraction (luminance > 8/255).
 * Luminance is rec.709 on 0..1 scale. Fully transparent pixels count as dark.
 */
function luminanceStats(img) {
  const { width, height, channels, data } = img;
  const total = width * height;
  let sum = 0;
  let max = 0;
  let bright = 0;
  for (let i = 0, p = 0; i < total; i++, p += channels) {
    const r = data[p] / 255;
    const g = data[p + 1] / 255;
    const b = data[p + 2] / 255;
    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (channels === 4) lum *= data[p + 3] / 255; // transparent => dark
    sum += lum;
    if (lum > max) max = lum;
    if (lum > 8 / 255) bright++;
  }
  return {
    mean: sum / total,
    max,
    brightFraction: bright / total,
    mean255: (sum / total) * 255,
    pixels: total,
  };
}

/* ========================================================================== */
/* Main                                                                       */
/* ========================================================================== */

let cleanupState = { done: false, child: null, userDataDir: null };

function cleanup() {
  if (cleanupState.done) return;
  cleanupState.done = true;
  const { child, userDataDir } = cleanupState;
  if (child && child.exitCode === null && !child.signalCode) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  if (userDataDir) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        // Chrome may still be releasing files; retry synchronously.
      }
    }
  }
}

function hardExit(code) {
  cleanup();
  process.exitCode = code;
  const finish = () => process.exit(code);
  if (process.stdout.writableLength === 0 && process.stderr.writableLength === 0) {
    finish();
    return;
  }
  let fired = false;
  const go = () => { if (!fired) { fired = true; finish(); } };
  process.stdout.once('drain', go);
  process.stderr.once('drain', go);
  setTimeout(go, 500);
}

async function main(opts) {
  const warnings = []; // harness-level warnings (separate from page warnings)
  const outPath = resolve(process.cwd(), opts.out);
  const jsonPath = opts.json ? resolve(process.cwd(), opts.json) : null;

  // --- launch Chrome -------------------------------------------------------
  if (!existsSync(opts.chrome)) throw new Error(`Chrome binary not found: ${opts.chrome}`);
  const userDataDir = mkdtempSync(resolve(tmpdir(), 'gargantua-capture-'));
  cleanupState.userDataDir = userDataDir;
  const proc = spawnChrome({
    chrome: opts.chrome,
    userDataDir,
    width: opts.width,
    height: opts.height,
    extraFlags: opts.flags,
  });
  cleanupState.child = proc.child;

  let wsUrl = null;
  try {
    const { port, path } = await waitForDevToolsActivePort(userDataDir, proc, 20000);
    wsUrl = `ws://127.0.0.1:${port}${path}`;
  } catch (err) {
    const m = proc.getStderr().match(/ws:\/\/[^\s'"]+/);
    if (m) {
      wsUrl = m[0];
      warnings.push(`DevToolsActivePort discovery failed, recovered ws URL from stderr: ${err.message}`);
    } else {
      throw err;
    }
  }

  const ws = await openWebSocket(wsUrl, 20000);
  const cdp = new CDP(ws);
  let sessionId = null;

  const col = createCollector();

  // --- wire domains --------------------------------------------------------
  sessionId = await attachToPage(cdp);
  wireCollector(cdp, sessionId, col);

  for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'Console']) {
    try {
      await cdp.send(`${domain}.enable`, {}, sessionId, 10000);
    } catch (err) {
      warnings.push(`${domain}.enable failed: ${err.message}`);
    }
  }

  // Exact viewport (window-size is also passed to Chrome).
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId, 10000);
  } catch (err) {
    warnings.push(`Emulation.setDeviceMetricsOverride failed: ${err.message}`);
  }

  // --- navigate ------------------------------------------------------------
  const startNav = Date.now();
  const loaded = cdp.once('Page.loadEventFired', 15000);
  const nav = await cdp.send('Page.navigate', { url: opts.url }, sessionId, 30000);
  if (nav.errorText) {
    throw new Error(`navigation to ${opts.url} failed: ${nav.errorText}`);
  }

  // --- readiness -----------------------------------------------------------
  const READY_EXPR = `(async () => {
    try {
      if (!window.GARGANTUA) return { ready: false, kind: 'absent' };
      const r = window.GARGANTUA.ready;
      if (r && typeof r.then === 'function') {
        const v = await Promise.race([
          r,
          new Promise((res) => setTimeout(() => res('__GARGANTUA_PENDING__'), 1200)),
        ]);
        if (v === '__GARGANTUA_PENDING__') return { ready: false, kind: 'thenable-pending' };
        return { ready: !!v, kind: 'thenable' };
      }
      return { ready: !!r, kind: typeof r };
    } catch (e) {
      return { ready: false, kind: 'error', error: String((e && e.message) || e) };
    }
  })()`;

  const deadline = startNav + opts.wait;
  let ready = false;
  let readyMs = null;
  let lastKind = 'unknown';
  let lastReadyError = null;
  const readyWait = loaded.ok ? 0 : Math.min(10000, Math.max(0, deadline - Date.now()));
  if (readyWait > 0) await loaded; // navigation still in flight; wait a bit

  while (Date.now() < deadline) {
    let res;
    try {
      res = await cdp.send('Runtime.evaluate', {
        expression: READY_EXPR,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId, 10000);
    } catch (err) {
      // Context destroyed by a navigation; keep polling until the deadline.
      lastReadyError = err.message;
      await sleep(100);
      continue;
    }
    if (res.exceptionDetails) {
      lastReadyError = res.exceptionDetails.text || 'evaluate threw';
    } else {
      const v = res.result?.value;
      if (v && typeof v === 'object') {
        lastKind = v.kind || lastKind;
        lastReadyError = v.error || lastReadyError;
        if (v.ready) {
          ready = true;
          readyMs = Date.now() - startNav;
          break;
        }
      } else if (v) {
        ready = true;
        readyMs = Date.now() - startNav;
        break;
      }
    }
    await sleep(150);
  }

  if (ready) {
    if (opts.settle > 0) await sleep(opts.settle);
  } else {
    readyMs = Date.now() - startNav;
    warnings.push(
      `readiness not signalled within ${opts.wait}ms (last state: ${lastKind}` +
      `${lastReadyError ? `, ${lastReadyError}` : ''}); capturing anyway`,
    );
  }

  // --- screenshot ----------------------------------------------------------
  const shotParams = { format: 'png', fromSurface: true };
  if (opts.fullpage) {
    try {
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId, 10000);
      const cs = metrics.cssContentSize || metrics.contentSize;
      if (cs && cs.width && cs.height) {
        shotParams.clip = {
          x: 0,
          y: 0,
          width: Math.ceil(cs.width),
          height: Math.ceil(cs.height),
          scale: 1,
        };
      }
    } catch (err) {
      warnings.push(`Page.getLayoutMetrics failed: ${err.message}`);
    }
    shotParams.captureBeyondViewport = true;
  }

  const shot = await cdp.send('Page.captureScreenshot', shotParams, sessionId, 30000);
  if (!shot.data || typeof shot.data !== 'string') throw new Error('Page.captureScreenshot returned no data');

  const png = Buffer.from(shot.data, 'base64');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);

  // --- black-screen analysis ----------------------------------------------
  let nonBlack = null;
  let lum = null;
  let image = { width: opts.width, height: opts.height };
  try {
    const decoded = decodePNG(png);
    image = { width: decoded.width, height: decoded.height, channels: decoded.channels };
    lum = luminanceStats(decoded);
    nonBlack = !(lum.mean < 1 / 255 || lum.brightFraction < 0.001);
  } catch (err) {
    warnings.push(`PNG decode for black-screen detection failed: ${err.message}`);
  }

  // --- report --------------------------------------------------------------
  const ok = col.errors.length === 0 && nonBlack !== false;
  const exitCode = col.errors.length > 0 ? 2 : nonBlack === false ? 3 : 0;

  const report = {
    ok,
    url: opts.url,
    out: outPath,
    width: image.width,
    height: image.height,
    viewport: { width: opts.width, height: opts.height },
    ready,
    readyMs,
    readyState: lastKind,
    settleMs: opts.settle,
    fullpage: opts.fullpage,
    errors: col.errors,
    warnings: [...col.warnings, ...warnings],
    pageWarnings: col.warnings,
    harnessWarnings: warnings,
    logs: col.logs.slice(0, LOG_CAP),
    logsTotal: col.logs.length,
    shaderWarnings: col.shaderWarnings,
    failedRequests: col.failedRequestList.length,
    failedRequestList: col.failedRequestList,
    nonBlack,
    luminance: lum,
    exitCode,
    capturedAt: new Date().toISOString(),
    chrome: opts.chrome,
    chromeArgs: proc.args,
  };

  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  cdp.close();

  // --- human summary -------------------------------------------------------
  const out = [];
  out.push(`[capture] url        ${opts.url}`);
  out.push(`[capture] screenshot ${outPath} (${image.width}x${image.height}, ${png.length} bytes)`);
  out.push(`[capture] ready      ${ready}${ready ? ` after ${readyMs}ms` : ` (timeout ${opts.wait}ms, state=${lastKind})`}`);
  if (lum) {
    out.push(
      `[capture] luminance  mean=${lum.mean.toFixed(5)} (${lum.mean255.toFixed(2)}/255) ` +
      `max=${lum.max.toFixed(4)} brightFraction=${lum.brightFraction.toFixed(6)} ` +
      `=> ${nonBlack ? 'non-black' : 'BLACK'}`,
    );
  } else {
    out.push('[capture] luminance  unavailable (PNG decode failed; see warnings)');
  }
  out.push(`[capture] errors     ${col.errors.length}`);
  for (const e of col.errors.slice(0, 10)) {
    out.push(`[capture]   - [${e.source}] ${e.text.split('\n')[0].slice(0, 200)}`);
  }
  out.push(`[capture] warnings   ${col.warnings.length}`);
  for (const w of col.warnings.slice(0, 10)) {
    out.push(`[capture]   - [${w.source}] ${w.text.split('\n')[0].slice(0, 200)}`);
  }
  out.push(`[capture] shader/gl  ${col.shaderWarnings.length}`);
  out.push(`[capture] requests   ${col.failedRequestList.length} failed`);
  for (const f of col.failedRequestList.slice(0, 10)) {
    out.push(`[capture]   - ${f.status || f.errorText || f.kind} ${f.url}`);
  }
  out.push(`[capture] logs       ${col.logs.length} total (report keeps first ${Math.min(col.logs.length, LOG_CAP)})`);
  for (const w of warnings.slice(0, 5)) out.push(`[capture] harness!   ${w}`);
  if (jsonPath) out.push(`[capture] json       ${jsonPath}`);
  out.push(`[capture] exit       ${exitCode}`);
  process.stdout.write(`${out.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);

  return exitCode;
}

/* ========================================================================== */
/* Entry point                                                                */
/* ========================================================================== */

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}
process.on('uncaughtException', (err) => {
  process.stderr.write(`[capture] uncaught exception: ${err && err.stack ? err.stack : err}\n`);
  hardExit(1);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[capture] unhandled rejection: ${err && err.stack ? err.stack : err}\n`);
  hardExit(1);
});

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[capture] ${err.message}\n${USAGE}\n`);
  hardExit(1);
}

if (opts.help) {
  process.stdout.write(`${USAGE}\n`);
  hardExit(0);
} else {
  main(opts)
    .then((code) => hardExit(code))
    .catch((err) => {
      process.stderr.write(`[capture] fatal: ${err && err.stack ? err.stack : err}\n`);
      hardExit(1);
    });
}
