/**
 * GARGANTUA — optional ambient audio.
 *
 * Primary source is the shipped 30 s seamless loop
 * (assets/audio/ambient-drone.wav, 55 Hz drone + fifth/octave partials).
 * If the asset cannot be fetched or decoded (file:// origin, restricted
 * codec, offline) we synthesise an equivalent drone live with WebAudio, so
 * the toggle always does something.
 *
 * Browsers require a user gesture before audio may start: `enable()` is safe
 * to call at any time and will simply wait for the first interaction.
 */

const VOLUME = 0.34;

export class Ambience {
  constructor(url = './assets/audio/ambient-drone.wav') {
    this.url = url;
    this.ctx = null;
    this.master = null;
    this.source = null;
    this.buffer = null;
    this.fallbackNodes = [];
    this.wanted = false;
    this.status = 'idle';   // idle | loading | playing | error
    this._gestureHandler = null;
    this.onStatus = null;
  }

  _notify() { if (this.onStatus) { try { this.onStatus(this.status); } catch (e) {} } }

  _ctx() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('WebAudio unavailable');
    this.ctx = new AC({ latencyHint: 'playback' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Ask for audio; resolves to true when sound is actually running. */
  async enable() {
    this.wanted = true;
    this._notify();
    if (this.status === 'playing') return true;
    try {
      const ctx = this._ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      if (ctx.state !== 'running') { this._waitForGesture(); return false; }
      await this._start();
      return this.status === 'playing';
    } catch (e) {
      console.warn('[gargantua] audio unavailable:', e && e.message);
      this.status = 'error';
      this._notify();
      return false;
    }
  }

  _waitForGesture() {
    if (this._gestureHandler) return;
    this._gestureHandler = () => {
      window.removeEventListener('pointerdown', this._gestureHandler);
      window.removeEventListener('keydown', this._gestureHandler);
      this._gestureHandler = null;
      if (this.wanted) this.enable();
    };
    window.addEventListener('pointerdown', this._gestureHandler, { once: false });
    window.addEventListener('keydown', this._gestureHandler, { once: false });
  }

  async _start() {
    if (this.status === 'playing') return;
    this.status = 'loading'; this._notify();
    const ctx = this._ctx();
    let buf = this.buffer;
    if (!buf) {
      try {
        const res = await fetch(this.url, { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const ab = await res.arrayBuffer();
        buf = await new Promise((ok, no) => {
          const p = ctx.decodeAudioData(ab, ok, no);
          if (p && p.then) p.then(ok, no);
        });
        this.buffer = buf;
      } catch (e) {
        console.warn('[gargantua] ambient file unavailable — synthesising drone:', e && e.message);
        buf = this._synthBuffer(ctx);
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.Q.value = 0.4;
    src.connect(lp).connect(this.master);
    src.start(0);
    this.source = src;
    this.status = 'playing';
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(this.master.gain.value, ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(VOLUME, ctx.currentTime + 2.5);
    this._notify();
  }

  /** Live fallback: 30 s of looped additive drone built in an AudioBuffer. */
  _synthBuffer(ctx) {
    const dur = 12;
    const sr = ctx.sampleRate;
    const len = Math.floor(dur * sr);
    const buf = ctx.createBuffer(2, len, sr);
    const partials = [
      [55, 0.50], [82.5, 0.28], [110, 0.24], [165, 0.13], [220, 0.10], [440, 0.02],
    ];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        let s = 0;
        for (let k = 0; k < partials.length; k++) {
          const f = partials[k][0] * (1 + (ch ? 0.0016 : -0.0016) * (k + 1));
          const lfo = 0.72 + 0.28 * Math.sin(2 * Math.PI * (0.5 / (k + 2)) * t);
          s += partials[k][1] * lfo * Math.sin(2 * Math.PI * f * t);
        }
        d[i] = s * 0.5;
      }
    }
    return buf;
  }

  disable() {
    this.wanted = false;
    if (this._gestureHandler) {
      window.removeEventListener('pointerdown', this._gestureHandler);
      window.removeEventListener('keydown', this._gestureHandler);
      this._gestureHandler = null;
    }
    if (this.ctx && this.source) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0.0001, now + 1.2);
      const src = this.source;
      this.source = null;
      setTimeout(() => { try { src.stop(); } catch (e) {} }, 1500);
    }
    this.status = 'idle';
    this._notify();
  }

  toggle() {
    if (this.wanted) { this.disable(); return false; }
    this.enable();
    return true;
  }
}
