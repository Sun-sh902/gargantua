/**
 * GARGANTUA — application state.
 *
 *  • one flat parameter bag (the 21 shader parameters) + a few extras
 *  • localStorage persistence (versioned, defensive against junk)
 *  • URL query parsing that doubles as the screenshot-automation surface
 *  • a tiny event bus the HUD, renderer and automation API share
 */

import { PARAMS, EXTRAS, ALL_PARAMS, TOGGLES } from './config.js';

const STORAGE_KEY = 'gargantua.state.v1';

export const defaults = () => {
  const p = {};
  for (const d of ALL_PARAMS) p[d.key] = d.def;
  const t = {};
  for (const d of TOGGLES) t[d.key] = d.def;
  return { params:p, toggles:t, quality:null, debug:0, preset:0, hud:true, cine:false, music:false };
};

export const clampParam = (def, v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def.def;
  return Math.min(def.max, Math.max(def.min, n));
};

export class Store {
  constructor() {
    const d = defaults();
    this.params = d.params;
    this.toggles = d.toggles;
    this.quality = d.quality;   // null → auto-detect
    this.debug = 0;
    this.preset = 0;
    this.hud = true;
    this.cine = false;
    this.music = false;
    this.time = 0;              // simulation clock (seconds)
    this._listeners = new Map();
    this.autoDetectedQuality = null;
  }

  /* ── events ─────────────────────────────────────────────────────────── */
  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(fn);
    return () => this._listeners.get(evt)?.delete(fn);
  }
  emit(evt, payload) {
    const set = this._listeners.get(evt);
    if (set) for (const fn of set) { try { fn(payload); } catch (e) { console.warn('[gargantua] listener', evt, e); } }
    const any = this._listeners.get('*');
    if (any) for (const fn of any) { try { fn(evt, payload); } catch (e) { /* noop */ } }
  }

  /* ── parameters ─────────────────────────────────────────────────────── */
  get(key) { return this.params[key]; }
  set(key, value, silent = false) {
    const def = ALL_PARAMS.find(p => p.key === key);
    if (!def) return;
    const v = clampParam(def, value);
    if (this.params[key] === v) return;
    this.params[key] = v;
    if (!silent) this.emit('param', { key, value:v });
  }
  setMany(obj, silent = false) {
    if (!obj) return;
    const changed = [];
    for (const [k, v] of Object.entries(obj)) {
      const def = ALL_PARAMS.find(p => p.key === k);
      if (!def) continue;
      const nv = clampParam(def, v);
      if (this.params[k] !== nv) { this.params[k] = nv; changed.push(k); }
    }
    if (changed.length && !silent) this.emit('params', changed);
  }
  toggle(key) {
    if (!(key in this.toggles)) return;
    this.toggles[key] = !this.toggles[key];
    this.emit('toggle', { key, value:this.toggles[key] });
  }
  setToggle(key, value, silent = false) {
    if (!(key in this.toggles)) return;
    const v = !!value;
    if (this.toggles[key] === v) return;
    this.toggles[key] = v;
    if (!silent) this.emit('toggle', { key, value:v });
  }
  resetParams() {
    for (const d of ALL_PARAMS) this.params[d.key] = d.def;
    for (const d of TOGGLES) this.toggles[d.key] = d.def;
    this.emit('params', ALL_PARAMS.map(p => p.key));
  }
  setDebug(i, silent = false) {
    const v = Math.max(0, Math.min(9, i | 0));
    if (this.debug === v) return;
    this.debug = v;
    if (!silent) this.emit('debug', v);
  }
  setQuality(q, silent = false) {
    if (this.quality === q) return;
    this.quality = q;
    if (!silent) this.emit('quality', q);
  }
  setPreset(i, silent = false) {
    const v = ((i | 0) % 4 + 4) % 4;
    if (this.preset === v) return;
    this.preset = v;
    if (!silent) this.emit('preset', v);
  }
  setHud(on, silent = false) {
    on = !!on;
    if (this.hud === on) return;
    this.hud = on;
    if (!silent) this.emit('hud', on);
  }
  setCine(on, silent = false) {
    on = !!on;
    if (this.cine === on) return;
    this.cine = on;
    if (!silent) this.emit('cine', on);
  }

  /* ── persistence ────────────────────────────────────────────────────── */
  save() {
    try {
      const payload = {
        v:1,
        params:this.params,
        toggles:this.toggles,
        quality:this.quality,
        debug:this.debug,
        preset:this.preset,
        hud:this.hud,
        cine:false,           // never auto-start the camera loop
        music:this.music,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) { /* private mode / quota — non fatal */ }
  }
  load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || typeof data !== 'object') return false;
    if (data.params) {
      for (const d of ALL_PARAMS) if (d.key in data.params) this.params[d.key] = clampParam(d, data.params[d.key]);
    }
    if (data.toggles) for (const d of TOGGLES) if (d.key in data.toggles) this.toggles[d.key] = !!data.toggles[d.key];
    if (typeof data.quality === 'string' && data.quality) this.quality = data.quality;
    if (Number.isFinite(data.debug)) this.debug = Math.max(0, Math.min(9, data.debug | 0));
    if (Number.isFinite(data.preset)) this.preset = ((data.preset | 0) % 4 + 4) % 4;
    if (typeof data.hud === 'boolean') this.hud = data.hud;
    if (typeof data.music === 'boolean') this.music = data.music;
    return true;
  }
  clearStorage() { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} }

  /* ── URL automation ─────────────────────────────────────────────────── */
  /**
   * Parses the query string.  Returns an object with everything the boot
   * sequence needs; unknown keys are ignored, every numeric key is clamped.
   *
   *   ?shot=1&preset=2&quality=cinematic&t=3.5&hud=0&debug=3&w=1920&h=1080
   */
  applyURL(search = location.search) {
    const out = {
      present:false, shot:false, params:{}, toggleOverrides:{},
      quality:null, debug:null, preset:null, hud:null, cine:null, music:null,
      time:null, frames:null, dpr:null, scale:null, pause:null, unknown:[],
    };
    let q;
    try { q = new URLSearchParams(search || ''); } catch (e) { return out; }
    if (![...q.keys()].length) return out;
    out.present = true;

    const bool = (v, dflt) => {
      if (v === null || v === '') return true;
      const s = String(v).toLowerCase();
      if (['1','true','yes','on'].includes(s)) return true;
      if (['0','false','no','off'].includes(s)) return false;
      return dflt;
    };

    for (const [k, v] of q.entries()) {
      switch (k) {
        case 'shot': case 'screenshot': out.shot = bool(v, true); break;
        case 'quality': if (v) out.quality = v.toLowerCase(); break;
        case 'debug': case 'view': out.debug = parseInt(v, 10); break;
        case 'preset': case 'p': out.preset = parseInt(v, 10); break;
        case 'hud': out.hud = bool(v, true); break;
        case 'cine': out.cine = bool(v, true); break;
        case 'music': out.music = bool(v, true); break;
        case 't': case 'time': out.time = parseFloat(v); break;
        case 'frames': out.frames = parseInt(v, 10); break;
        case 'dpr': out.dpr = parseFloat(v); break;
        case 'scale': out.scale = parseFloat(v); break;
        case 'pause': out.pause = bool(v, true); break;
        default: {
          const def = ALL_PARAMS.find(p => p.key === k);
          if (def) { out.params[k] = parseFloat(v); break; }
          const tg = TOGGLES.find(t => t.key === k);
          if (tg) { out.toggleOverrides[k] = bool(v, true); break; }
          out.unknown.push(k);
        }
      }
    }
    return out;
  }
}
