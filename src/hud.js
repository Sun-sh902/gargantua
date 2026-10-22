/**
 * GARGANTUA — heads-up display.
 * Built entirely from config.js so the 21 parameters, the 4 presets, the 10
 * debug views and the shortcut sheet can never drift out of sync with the
 * renderer.
 */

import { PARAMS, EXTRAS, TOGGLES, PRESETS, DEBUG_VIEWS, QUALITY, SHORTCUTS } from './config.js';

const $ = sel => document.querySelector(sel);

export class HUD {
  constructor(store, actions) {
    this.store = store;
    this.actions = actions;
    this.sliders = new Map();
    this.toggleBtns = new Map();
    this.extraBtns = new Map();
    this.presetBtns = [];
    this.collapsed = false;
    this.toastTimer = 0;
    this._lastCaption = -1;
  }

  build() {
    /* ── presets ── */
    const pc = $('#presets');
    PRESETS.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'btn chip';
      b.textContent = `${i + 1} · ${p.name}`;
      b.title = p.desc;
      b.addEventListener('click', () => this.actions.setPreset(i));
      pc.appendChild(b);
      this.presetBtns.push(b);
    });

    /* ── debug view select ── */
    const sd = $('#selDebug');
    for (const v of DEBUG_VIEWS) {
      const o = document.createElement('option');
      o.value = String(v.id);
      o.textContent = `${v.id} · ${v.name}`;
      sd.appendChild(o);
    }
    sd.addEventListener('change', () => this.actions.setDebug(parseInt(sd.value, 10)));

    /* ── quality select ── */
    const sq = $('#selQuality');
    sq.addEventListener('change', () => this.actions.setQuality(sq.value));

    /* ── toggles ── */
    const tg = $('#toggles');
    for (const t of TOGGLES) {
      const b = document.createElement('button');
      b.className = 'btn tiny';
      b.textContent = t.label;
      b.addEventListener('click', () => {
        this.store.toggle(t.key);
        this.actions.onToggle && this.actions.onToggle(t.key, this.store.toggles[t.key]);
        this.syncToggles();
      });
      tg.appendChild(b);
      this.toggleBtns.set(t.key, b);
    }

    /* ── 21 parameter sliders, grouped ── */
    const host = $('#sliders');
    let currentGroup = null;
    let groupEl = null;
    for (const def of PARAMS) {
      if (def.group !== currentGroup) {
        currentGroup = def.group;
        groupEl = document.createElement('div');
        groupEl.className = 'group';
        const t = document.createElement('div');
        t.className = 'group-title';
        t.textContent = currentGroup.toUpperCase();
        groupEl.appendChild(t);
        host.appendChild(groupEl);
      }
      const row = document.createElement('div');
      row.className = 'slider';
      const top = document.createElement('div');
      top.className = 'sl-top';
      const name = document.createElement('span');
      name.className = 'sl-name';
      name.textContent = def.label;
      const val = document.createElement('span');
      val.className = 'sl-val';
      top.appendChild(name); top.appendChild(val);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      input.value = String(this.store.params[def.key]);
      input.setAttribute('aria-label', def.label);
      const paint = () => {
        const f = (input.value - def.min) / (def.max - def.min);
        input.style.setProperty('--fill', (f * 100).toFixed(2) + '%');
      };
      input.addEventListener('input', () => {
        this.store.set(def.key, parseFloat(input.value));
        val.textContent = def.fmt(parseFloat(input.value));
        paint();
      });
      row.appendChild(top); row.appendChild(input);
      groupEl.appendChild(row);
      this.sliders.set(def.key, { def, input, val, paint });
      val.textContent = def.fmt(this.store.params[def.key]);
      paint();
    }

    /* ── extras: numeric controls rendered as buttons, not sliders ── */
    for (const def of EXTRAS) {
      const g = document.createElement('div');
      g.className = 'field';
      const lab = document.createElement('label');
      lab.textContent = def.label;
      const b = document.createElement('button');
      b.className = 'btn tiny';
      const paint = () => {
        b.textContent = def.fmt(this.store.params[def.key]);
        b.classList.toggle('active', this.store.params[def.key] > 0);
      };
      b.addEventListener('click', () => {
        const next = this.store.params[def.key] > 0 ? def.min : def.max;
        this.store.set(def.key, next);
        paint();
        this.actions.onToggle && this.actions.onToggle(def.key, next);
      });
      g.appendChild(lab); g.appendChild(b);
      host.appendChild(g);
      paint();
      this.extraBtns.set(def.key, b);
    }

    /* ── chrome buttons ── */
    $('#btnPanel').addEventListener('click', () => this.togglePanel());
    $('#btnHelp').addEventListener('click', () => this.toggleKeys());
    $('#btnCollapse').addEventListener('click', () => this.togglePanel(true));
    $('#btnCine').addEventListener('click', () => this.actions.toggleCine());
    $('#btnMusic').addEventListener('click', () => this.actions.toggleMusic());
    $('#btnPause').addEventListener('click', () => this.actions.togglePause());
    $('#btnShot').addEventListener('click', () => this.actions.screenshot());
    $('#btnReset').addEventListener('click', () => this.actions.reset());

    /* ── shortcut sheet ── */
    const kb = $('#keysBody');
    for (const col of SHORTCUTS) {
      const c = document.createElement('div');
      c.className = 'sheet-col';
      const h = document.createElement('h3');
      h.textContent = col.group;
      c.appendChild(h);
      for (const [k, d] of col.rows) {
        const r = document.createElement('div');
        r.className = 'sheet-row';
        const a = document.createElement('span');
        const keys = k.split(' ').map(x => x === '/' ? '<kbd>/</kbd>' : `<kbd>${x}</kbd>`).join(' ');
        a.innerHTML = keys;
        const b = document.createElement('span');
        b.textContent = d;
        r.appendChild(a); r.appendChild(b);
        c.appendChild(r);
      }
      kb.appendChild(c);
    }

    $('#keys').addEventListener('click', e => { if (e.target.id === 'keys') this.toggleKeys(false); });

    this.syncToggles();
    this.setDebug(this.store.debug);
    this.setQuality(this.store.quality);
    this.setPreset(this.store.preset);
    this.setHud(this.store.hud);
  }

  /* ── state sync ─────────────────────────────────────────────────────── */
  syncToggles() {
    for (const t of TOGGLES) {
      const b = this.toggleBtns.get(t.key);
      if (b) b.classList.toggle('active', !!this.store.toggles[t.key]);
    }
    const c = $('#btnCine'); if (c) c.classList.toggle('active', this.store.cine);
    const p = $('#btnPause'); if (p) p.classList.toggle('active', !this.store.toggles.timeFlow);
  }
  syncParams(only = null) {
    for (const [key, b] of this.extraBtns) {
      if (only && only !== key) continue;
      const d = EXTRAS.find(e => e.key === key);
      b.textContent = d.fmt(this.store.params[key]);
      b.classList.toggle('active', this.store.params[key] > 0);
    }
    const list = only ? [[only, this.sliders.get(only)]] : this.sliders;
    for (const [key, s] of list) {
      if (!s) continue;
      const v = this.store.params[key];
      if (Math.abs(parseFloat(s.input.value) - v) > 1e-9) {
        s.input.value = String(v);
        s.val.textContent = s.def.fmt(v);
        s.paint();
      }
    }
  }
  setDebug(i) {
    const v = DEBUG_VIEWS.find(d => d.id === i) || DEBUG_VIEWS[0];
    $('#badgeView').textContent = `VIEW ${v.id} · ${v.name}`;
    $('#selDebug').value = String(v.id);
    if (this._lastCaption !== v.id) {
      $('#viewDesc').innerHTML = `<b>${v.id} · ${v.name}</b> — ${v.desc}`;
      this._lastCaption = v.id;
    }
  }
  setQuality(q) {
    const k = q || 'auto';
    $('#selQuality').value = q || 'standard';
    $('#badgeQuality').textContent = k === 'auto' ? 'AUTO' : (QUALITY[q] ? QUALITY[q].label : String(q).toUpperCase());
  }
  setPreset(i) {
    this.presetBtns.forEach((b, k) => b.classList.toggle('active', k === i));
  }
  setHud(on) {
    $('#hud').classList.toggle('hidden', !on);
  }
  setMusic(on, status) {
    const b = $('#btnMusic');
    b.classList.toggle('active', !!on);
    b.textContent = on ? (status === 'playing' ? 'music ♪' : 'music …') : 'music';
    const k = document.createElement('kbd'); k.textContent = 'M';
    b.appendChild(document.createTextNode(' '));
    b.appendChild(k);
  }
  togglePanel(force) {
    const p = $('#panel');
    this.collapsed = force === undefined ? !p.classList.contains('collapsed') : !!force;
    p.classList.toggle('collapsed', this.collapsed);
  }
  toggleKeys(force) {
    const k = $('#keys');
    const show = force === undefined ? k.classList.contains('hidden') : !!force;
    k.classList.toggle('hidden', !show);
  }
  keysOpen() { return !$('#keys').classList.contains('hidden'); }

  /* ── telemetry ──────────────────────────────────────────────────────── */
  updateStats(s) {
    $('#tFps').textContent = s.fps.toFixed(0);
    $('#tFps').className = s.fps < 24 ? 'hot' : '';
    $('#tMs').textContent = s.ms.toFixed(1) + ' ms';
    $('#tRes').textContent = `${s.rw}×${s.rh} @${s.dpr.toFixed(2)}`;
    $('#tSteps').textContent = `${s.steps}`;
    $('#tMode').textContent = s.mode;
    $('#tR').textContent = s.r.toFixed(2) + ' r\u209B';
    $('#tIncl').textContent = s.incl.toFixed(1) + '°';
    $('#tDisk').textContent = s.temp > 0 ? Math.round(s.temp).toLocaleString() + ' K' : '—';
    $('#tTime').textContent = s.time.toFixed(1) + ' s';
    $('#tGpu').textContent = s.gpu;
  }

  toast(msg, ms = 1600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  setBoot(pct, text) {
    const bar = $('#bootBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    const st = $('#bootStatus');
    if (st && text) st.textContent = text;
  }
  hideBoot() { $('#boot').classList.add('hidden'); setTimeout(() => { const b = $('#boot'); if (b) b.style.display = 'none'; }, 700); }

  fatal(msg) {
    const f = $('#fatal');
    $('#fatalMsg').textContent = String(msg || 'unknown error');
    f.classList.remove('hidden');
  }
  clearFatal() { $('#fatal').classList.add('hidden'); }

  contextLost(on) { $('#contextLost').classList.toggle('hidden', !on); }
}
