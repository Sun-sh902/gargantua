/**
 * GARGANTUA — Schwarzschild Black Hole Raytracer
 * application entry point: renderer, loop, input, automation API.
 */

import * as THREE from 'three';
import { Store } from './state.js';
import { HUD } from './hud.js';
import { CameraRig } from './camera.js';
import { Ambience } from './audio.js';
import { Raytracer } from './renderer/raytracer.js';
import { PostFX } from './renderer/postfx.js';
import { QUALITY, PRESETS, DEBUG_VIEWS, PARAMS, ISCO, B_CRIT } from './config.js';

const VERSION = '1.0.0';

/* ────────────────────────────────────────────────────────────────────────── *
 *  tiny utilities
 * ────────────────────────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function detectQuality() {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua)
    || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900);
  if (mobile) return 'standard';
  const cores = navigator.hardwareConcurrency || 4;
  const area = window.innerWidth * window.innerHeight;
  if (cores >= 8 && area > 1.1e6) return 'high';
  return cores >= 4 ? 'high' : 'standard';
}

function gpuLabel(renderer) {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    let s = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1');
    s = String(s).replace(/ANGLE \(|\)$/g, '').replace(/Direct3D.*/, 'D3D').trim();
    return s.length > 26 ? s.slice(0, 25) + '…' : s;
  } catch (e) { return 'WebGL'; }
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  App
 * ────────────────────────────────────────────────────────────────────────── */
class App {
  constructor() {
    this.store = new Store();
    this.errors = [];
    this.running = false;
    this.paused = false;
    this.timeScale = 1;
    this.frame = 0;
    this.fps = 0;
    this.lastT = performance.now();
    this.acc = 0;
    this.renderScale = 1;
    this.targetScale = 1;
    this.adaptiveTimer = 0;
    this.frames = 0;
    this.fpsWindow = [];
    this.readyResolve = null;
    this.readyPromise = new Promise(res => { this.readyResolve = res; });
    this.shotMode = false;
    this.shotFrames = 4;
    this.contextLost = false;
  }

  /* ── boot ──────────────────────────────────────────────────────────── */
  async boot() {
    const store = this.store;
    const url = store.applyURL();

    store.load();
    if (url.params) store.setMany(url.params, true);
    if (url.quality && QUALITY[url.quality]) store.setQuality(url.quality, true);
    if (Number.isFinite(url.debug)) store.setDebug(url.debug, true);
    if (Number.isFinite(url.preset)) store.setPreset(url.preset, true);
    if (url.hud !== null) store.setHud(url.hud, true);
    if (url.cine !== null) store.setCine(url.cine, true);
    if (url.music !== null) store.music = url.music;
    if (url.toggleOverrides) for (const [k, v] of Object.entries(url.toggleOverrides)) store.setToggle(k, v, true);
    if (Number.isFinite(url.time)) store.time = url.time;
    if (url.pause !== null) store.toggles.timeFlow = !url.pause;
    this.shotMode = !!url.shot;
    if (Number.isFinite(url.scale) && url.scale > 0.1 && url.scale <= 4) this.userScale = url.scale;
    if (Number.isFinite(url.frames)) this.shotFrames = Math.max(1, Math.min(240, url.frames | 0));

    const hud = this.hud = new HUD(store, {
      setPreset: i => this.applyPreset(i),
      setDebug: i => this.setDebug(i),
      setQuality: q => this.setQuality(q),
      toggleCine: () => this.toggleCine(),
      toggleMusic: () => this.toggleMusic(),
      togglePause: () => this.togglePause(),
      screenshot: () => this.downloadShot(),
      reset: () => this.resetAll(),
      onToggle: (k, v) => this.onToggle(k, v),
    });
    hud.build();
    hud.setBoot(10, 'compiling geodesic integrator…');

    /* renderer ------------------------------------------------------- */
    const canvas = document.getElementById('gl');
    this.canvas = canvas;
    const gl2 = !!document.createElement('canvas').getContext('webgl2');
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });
    const renderer = this.renderer;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the final pass encodes sRGB itself
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.debug.checkShaderErrors = true;
    this.gl2 = gl2;
    this.gpu = gpuLabel(renderer);

    if (!url.quality) store.quality = store.quality && QUALITY[store.quality] ? store.quality : detectQuality();
    hud.setQuality(store.quality);
    hud.setBoot(30, 'building HDR pipeline…');

    /* scene ---------------------------------------------------------- */
    this.camera = new THREE.PerspectiveCamera(store.params.fov, 1, 0.1, 4000);
    this.rig = new CameraRig(this.camera, canvas, store);
    this.rig.setPreset(store.preset, true);
    this.raytracer = new Raytracer();
    this.postfx = new PostFX(renderer, QUALITY[store.quality]);
    this.audio = new Ambience();
    this.audio.onStatus = s => hud.setMusic(this.audio.wanted && s !== 'idle', s);
    hud.setMusic(false, 'idle');

    hud.setBoot(55, 'allocating render targets…');
    this.resize(true);

    /* events --------------------------------------------------------- */
    this.bindEvents();
    store.on('param', e => { hud.syncParams(e && e.key); this.persist(); });
    store.on('params', () => { hud.syncParams(); this.persist(); });
    store.on('toggle', () => { hud.syncToggles(); this.persist(); });
    store.on('debug', v => { hud.setDebug(v); this.persist(); });
    store.on('quality', q => { hud.setQuality(q); this.postfx.setQuality(QUALITY[q]); this.resize(true); this.persist(); });
    store.on('preset', i => { hud.setPreset(i); this.persist(); });
    store.on('cine', v => { hud.syncToggles(); this.persist(); });

    hud.setBoot(70, 'warm-up render…');
    /* one synchronous frame so any shader error surfaces before we start */
    this.renderOnce();
    await sleep(16);
    this.renderOnce();

    hud.setBoot(100, 'ready');
    this.running = true;
    this.lastT = performance.now();
    this._tick();

    /* automation + optional music autoplay ---------------------------- */
    this.exposeAPI();
    if (store.music) { this.audio.enable(); }
    if (this.shotMode) {
      store.setHud(url.hud === null ? false : store.hud, true);
      hud.setHud(store.hud);
      store.setCine(false, true);
      store.toggles.timeFlow = false;
    }

    setTimeout(() => hud.hideBoot(), 380);
    if (!gl2) hud.toast('WebGL2 unavailable — running in compatibility mode', 3200);
    return true;
  }

  /* ── events ────────────────────────────────────────────────────────── */
  bindEvents() {
    const store = this.store;
    const hud = this.hud;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(this._onResize, 250));

    document.addEventListener('visibilitychange', () => { this.lastT = performance.now(); });

    /* never lose a change that has not reached the throttle window yet */
    const flush = () => { clearTimeout(this._persistTimer); this._persistTimer = 0; this.store.save(); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);

    this.canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this.contextLost = true;
      this.running = false;
      hud.contextLost(true);
      console.warn('[gargantua] WebGL context lost');
    }, false);

    this.canvas.addEventListener('webglcontextrestored', () => {
      try {
        this.postfx.dispose(true);
        this.postfx = new PostFX(this.renderer, QUALITY[store.quality]);
        this.resize(true);
        this.contextLost = false;
        this.running = true;
        this.lastT = performance.now();
        hud.contextLost(false);
        hud.toast('GPU context restored', 2000);
      } catch (err) {
        hud.fatal('Context restore failed: ' + (err && err.message));
      }
    }, false);

    document.addEventListener('keydown', e => this.onKey(e));

    window.addEventListener('error', e => this.recordError(e.message || 'script error'));
    window.addEventListener('unhandledrejection', e => this.recordError('unhandled rejection: ' + (e.reason && e.reason.message || e.reason)));
  }

  recordError(msg) {
    this.errors.push(String(msg));
    if (this.errors.length < 12) console.warn('[gargantua] recorded:', msg);
  }

  onKey(e) {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.code !== 'Escape') return;
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    const hud = this.hud, store = this.store;
    const shift = e.shiftKey;

    if (e.code === 'Escape') { hud.toggleKeys(false); return; }
    if (e.key === '/' || e.key === '?') { hud.toggleKeys(); e.preventDefault(); return; }

    /* digits: debug views, shift+digit: presets */
    if (/^Digit[0-9]$/.test(e.code)) {
      const n = parseInt(e.code.slice(5), 10);
      if (shift && n >= 1 && n <= 4) this.applyPreset(n - 1);
      else if (!shift) this.setDebug(n);
      return;
    }
    if (/^Numpad[0-9]$/.test(e.code)) {
      const n = parseInt(e.code.slice(6), 10);
      if (!shift) this.setDebug(n);
      return;
    }

    switch (e.code) {
      case 'KeyC': this.toggleCine(); break;
      case 'KeyM': this.toggleMusic(); break;
      case 'KeyH': store.setHud(!store.hud); hud.setHud(store.hud); break;
      case 'KeyB': store.toggle('bloom'); break;
      case 'KeyT': this.cycleQuality(); break;
      case 'KeyF': this.toggleFullscreen(); break;
      case 'KeyS': this.downloadShot(); break;
      case 'KeyR': shift ? this.resetAll() : this.rig.reset(); break;
      case 'Space': this.togglePause(); e.preventDefault(); break;
      case 'Tab': hud.togglePanel(); e.preventDefault(); break;
      case 'BracketLeft': store.set('exposure', store.params.exposure * 0.9); hud.toast('exposure ' + store.params.exposure.toFixed(2)); break;
      case 'BracketRight': store.set('exposure', store.params.exposure * 1.1); hud.toast('exposure ' + store.params.exposure.toFixed(2)); break;
      case 'Minus': case 'NumpadSubtract': store.set('fov', store.params.fov + 2); hud.toast('fov ' + store.params.fov.toFixed(1) + '°'); break;
      case 'Equal': case 'NumpadAdd': store.set('fov', store.params.fov - 2); hud.toast('fov ' + store.params.fov.toFixed(1) + '°'); break;
      case 'Comma': this.timeScale = Math.max(0.05, this.timeScale / 1.5); hud.toast('time ×' + this.timeScale.toFixed(2)); break;
      case 'Period': this.timeScale = Math.min(6, this.timeScale * 1.5); hud.toast('time ×' + this.timeScale.toFixed(2)); break;
      default: break;
    }
  }

  onToggle(key) {
    if (key === 'chromatic' || key === 'bloom') return;
    if (key === 'timeFlow') this.hud.setMusic(this.audio.wanted, this.audio.status);
  }

  applyPreset(i) {
    this.store.setPreset(i);
    this.store.setCine(false);
    this.rig.setCine(false);
    this.rig.setPreset(i);
    this.hud.toast(PRESETS[i].name + ' — ' + PRESETS[i].desc.slice(0, 46) + '…', 2600);
  }
  setDebug(i) {
    this.store.setDebug(i);
    this.hud.setDebug(this.store.debug);
    const v = DEBUG_VIEWS.find(d => d.id === this.store.debug);
    if (v) this.hud.toast(`${v.id} · ${v.name}`, 1500);
  }
  setQuality(q) {
    if (!QUALITY[q]) return;
    this.store.setQuality(q);
    this.hud.toast('quality: ' + QUALITY[q].label, 1400);
  }
  cycleQuality() {
    const order = ['standard', 'high', 'cinematic'];
    const i = order.indexOf(this.store.quality);
    this.setQuality(order[(i + 1) % order.length]);
  }
  toggleCine() {
    const on = !this.store.cine;
    this.store.setCine(on);
    this.rig.setCine(on);
    this.hud.toast(on ? 'cinematic camera loop — engaged' : 'cinematic loop off', 1500);
  }
  async toggleMusic() {
    const on = await this.audio.toggle();
    this.store.music = !!on;
    this.hud.setMusic(!!on, this.audio.status);
    this.hud.toast(on ? 'ambient drone on' : 'ambient drone off', 1400);
    this.persist();
  }
  togglePause() {
    this.store.toggles.timeFlow = !this.store.toggles.timeFlow;
    this.hud.syncToggles();
    this.hud.toast(this.store.toggles.timeFlow ? 'time running' : 'time paused', 1200);
  }
  resetAll() {
    this.store.resetParams();
    this.hud.syncParams();
    this.hud.syncToggles();
    this.resize(true);
    this.hud.toast('parameters reset', 1400);
  }
  toggleFullscreen() {
    const d = document;
    if (!d.fullscreenElement) (d.documentElement.requestFullscreen || (() => {})).call(d.documentElement);
    else if (d.exitFullscreen) d.exitFullscreen();
  }

  /* ── sizing ────────────────────────────────────────────────────────── */
  resize(force = false) {
    const q = QUALITY[this.store.quality] || QUALITY.high;
    const w = Math.max(2, window.innerWidth);
    const h = Math.max(2, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, q.maxDpr);

    let scale = q.renderScale * dpr;
    const px = w * h * scale * scale;
    if (px > q.targetPixels) scale *= Math.sqrt(q.targetPixels / px);
    if (this.userScale) scale = Math.min(scale, this.userScale);   // ?scale= pin
    this.targetScale = Math.max(0.32, scale);
    if (force || !this.renderScale) this.renderScale = this.targetScale;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx.setSize(w, h, this.renderScale, dpr);
    this.cssW = w; this.cssH = h; this.dpr = dpr;
  }

  /* ── render ────────────────────────────────────────────────────────── */
  renderOnce() {
    const store = this.store;
    const q = QUALITY[store.quality] || QUALITY.high;
    const rw = this.postfx.width, rh = this.postfx.height;

    this.raytracer.update({
      params: store.params,
      toggles: store.toggles,
      quality: q,
      debug: store.debug,
      time: store.time,
      camera: this.camera,
      width: rw,
      height: rh,
    });

    this.postfx.beginScene();
    this.renderer.render(this.raytracer.scene, this.raytracer.camera);
    this.postfx.compose({
      params: store.params,
      debug: store.debug,
      time: store.time,
      bloom: store.toggles.bloom,
      chromatic: store.toggles.chromatic,
      quality: q,
    });
    this.frame++;
  }

  /**
   * Frame scheduling.
   *
   * requestAnimationFrame is the right clock, but it is not guaranteed to be
   * serviced: headless/offscreen surfaces and heavily throttled tabs can stop
   * issuing frames entirely, which would freeze the simulation and any
   * screenshot automation waiting on it.  A timer watchdog drives the loop
   * whenever rAF has gone quiet for longer than the grace window, and stays
   * completely dormant while rAF is healthy.  A hidden tab still pauses.
   */
  _tick() {
    clearTimeout(this._watchdog);
    this._rafId = requestAnimationFrame(t => { this._rafId = 0; this._step(t); });
    this._watchdog = setTimeout(() => {
      if (document.visibilityState === 'hidden') { this._tick(); return; }
      if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
      this._step(performance.now());
    }, 260);
  }

  _step(now) {
    clearTimeout(this._watchdog);
    if (this.running) this.loop(now);
    this._tick();
  }

  loop(now) {
    const dtReal = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    /* Wall-clock frame interval.  Measuring the CPU submit time instead is
       useless: WebGL submission is asynchronous and returns in microseconds,
       so the FPS read-out and the adaptive scaler would never see the real
       frame cost. */
    const frameMs = this._prevNow ? Math.min(4000, now - this._prevNow) : 16.7;
    this._prevNow = now;
    this.lastT = now;

    if (this.store.toggles.timeFlow && !this.shotMode) {
      this.store.time += dtReal * this.timeScale;
    }
    this.rig.update(dtReal);

    this.renderOnce();

    /* telemetry -------------------------------------------------------- */
    this.acc += frameMs;
    this.frames++;
    this.fpsWindow.push(frameMs);
    if (this.fpsWindow.length > 90) this.fpsWindow.shift();
    if (this.acc > 320) {
      const avgMs = this.acc / Math.max(1, this.frames);
      this.fps = 1000 / Math.max(0.5, avgMs);
      this.acc = 0; this.frames = 0;
      this.updateTelemetry(avgMs);
      if (this.store.toggles.adaptive) this.adapt();
    }
    if (this.shotMode && this.frame >= this.shotFrames && this.readyResolve) {
      const r = this.readyResolve; this.readyResolve = null;
      let shot = null;
      try { shot = this.grabDataURL(); } catch (e) { /* ignore */ }
      r(shot || true);
    } else if (!this.shotMode && this.frame >= this.shotFrames && this.readyResolve) {
      const r = this.readyResolve; this.readyResolve = null;
      r(true);
    }
  }

  adapt() {
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / Math.max(1, this.fpsWindow.length);
    let next = this.renderScale;
    if (avg > 27 && this.renderScale > 0.34) next = this.renderScale * 0.90;
    else if (avg < 15 && this.renderScale < this.targetScale) next = Math.min(this.targetScale, this.renderScale * 1.05);
    if (Math.abs(next - this.renderScale) / this.renderScale < 0.03) return;
    this.renderScale = next;
    this.postfx.setSize(this.cssW, this.cssH, this.renderScale, this.dpr);
  }

  updateTelemetry(ms) {
    const s = this.rig.spherical();
    const incl = THREE.MathUtils.radToDeg(s.theta);
    const p = this.store.params;
    this.hud.updateStats({
      fps: this.fps,
      ms,
      rw: Math.round(this.postfx.width),
      rh: Math.round(this.postfx.height),
      dpr: this.renderScale,
      steps: Math.round((QUALITY[this.store.quality] || QUALITY.high).steps),
      mode: this.gl2 ? 'RK4 · geodesic' : 'RK4 · compat',
      r: s.r,
      incl: Math.abs(90 - incl) < 0.05 ? 90 : incl,
      temp: this.peakTemp(),
      time: this.store.time,
      gpu: this.gpu,
    });
  }

  /** Representative observed peak temperature: profile maximum × redshift at r_peak. */
  peakTemp() {
    const p = this.store.params;
    const rpk = Math.max(p.diskInner * 49 / 36, p.diskInner + 1e-3);
    const x = Math.min(p.diskInner / rpk, 0.9995);
    const prof = 2.049 * Math.pow(x, 0.75) * Math.pow(Math.max(1 - Math.sqrt(x), 0), 0.25);
    const grav = Math.sqrt(Math.max(1 - 1 / rpk, 0));
    return p.diskTemp * prof * Math.pow(grav, p.redshift);
  }

  /* ── screenshots ───────────────────────────────────────────────────── */
  grabDataURL() {
    const { buf, width, height } = this.postfx.capture();
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * row;
      img.data.set(buf.subarray(src, src + row), y * row);
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  downloadShot() {
    try {
      const url = this.grabDataURL();
      const a = document.createElement('a');
      const cfg = DEBUG_VIEWS.find(d => d.id === this.store.debug);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `gargantua_${this.store.quality}_${cfg ? cfg.name.toLowerCase().replace(/\W+/g, '-') : 'view'}_${ts}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      this.hud.toast('frame saved', 1600);
      return url;
    } catch (e) {
      this.hud.toast('capture failed: ' + (e && e.message), 2600);
      return null;
    }
  }

  /**
   * Throttled persistence.  A plain debounce is wrong here: the camera tween
   * emits a parameter event on every frame, which would keep pushing the save
   * into the future and quietly lose changes made during a transition.
   * Saves at most once per second, always with a trailing write.
   */
  persist() {
    if (this._persistTimer) return;
    const since = performance.now() - (this._lastSave || 0);
    const wait = Math.max(350, 1100 - since);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = 0;
      this._lastSave = performance.now();
      this.store.save();
    }, wait);
  }

  /* ── public automation API ─────────────────────────────────────────── */
  exposeAPI() {
    const store = this.store;
    const api = {
      version: VERSION,
      ready: this.readyPromise,
      get errors() { return app.errors.slice(); },
      three: THREE,
      get renderer() { return app.renderer; },
      get camera() { return app.camera; },
      get raytracer() { return app.raytracer; },
      get postfx() { return app.postfx; },
      stats: () => {
        const s = app.rig.spherical();
        return {
          fps: app.fps,
          time: store.time,
          r: s.r,
          theta: THREE.MathUtils.radToDeg(s.theta),
          phi: THREE.MathUtils.radToDeg(s.phi),
          fov: store.params.fov,
          quality: store.quality,
          debug: store.debug,
          preset: store.preset,
          renderScale: app.renderScale,
          rw: app.postfx.width,
          rh: app.postfx.height,
          frames: app.frame,
          errors: app.errors.length,
          gpu: app.gpu,
          webgl2: app.gl2,
          params: { ...store.params },
          isco: ISCO,
          bCrit: B_CRIT,
          paramsCount: PARAMS.length,
        };
      },
      setParam: (k, v) => { store.set(k, v); app.hud.syncParams(); return store.params[k]; },
      setParams: o => { store.setMany(o); app.hud.syncParams(); return { ...store.params }; },
      getParams: () => ({ ...store.params }),
      setPreset: i => app.applyPreset(i),
      setDebug: i => app.setDebug(i),
      setQuality: q => app.setQuality(q),
      setTime: t => { store.time = Number(t) || 0; return store.time; },
      setHud: on => { store.setHud(!!on); app.hud.setHud(store.hud); },
      pause: (on = true) => { store.toggles.timeFlow = !on; app.hud.syncToggles(); },
      setCine: on => { store.setCine(!!on); app.rig.setCine(!!on); app.hud.syncToggles(); },
      render: () => app.renderOnce(),
      /** Render N frames then resolve with a PNG data URL (deterministic). */
      capture: async (frames = 3) => {
        const wasRunning = app.running;
        app.running = false;
        for (let i = 0; i < frames; i++) app.renderOnce();
        const url = app.grabDataURL();
        app.running = wasRunning;
        return url;
      },
      screenshot: async (frames = 3) => api.capture(frames),
    };
    const app = this;
    window.GARGANTUA = api;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  start
 * ────────────────────────────────────────────────────────────────────────── */
const app = new App();
window.__GARGANTUA_APP__ = app;

async function start() {
  try {
    await app.boot();
  } catch (err) {
    console.error('[gargantua] boot failed', err);
    const hud = app.hud;
    if (hud) { hud.hideBoot(); hud.fatal((err && err.stack) || String(err)); }
    else {
      const b = document.getElementById('boot');
      if (b) b.innerHTML = '<div class="boot-inner"><div class="boot-title">BOOT FAILED</div><div class="boot-status">' + String(err) + '</div></div>';
    }
    if (!window.GARGANTUA) {
      window.GARGANTUA = { version: VERSION, ready: Promise.resolve(false), errors: [String(err)], stats: () => ({ errors: 1 }) };
    }
  }
}
start();
