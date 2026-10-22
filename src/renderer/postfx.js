/**
 * GARGANTUA — HDR post-processing pipeline (no external addons).
 *
 *   scene (RGBA16F)
 *     └─ soft-knee threshold prefilter ──► mip0
 *          └─ 13-tap downsample chain ──► mip1 … mipN
 *               └─ 9-tap tent upsample (additive) ──► back to mip0
 *   final: HDR + bloom → exposure → ACES → vignette → grain → dispersion → sRGB
 */

import * as THREE from 'three';
import { QUAD_VERT, PREFILTER_FRAG, DOWN_FRAG, UP_FRAG, FINAL_FRAG } from '../glsl/post.js';

const quadGeo = new THREE.PlaneGeometry(2, 2);

function pickHDRType(renderer) {
  try {
    const ext = renderer.extensions;
    if (renderer.capabilities.isWebGL2) {
      if (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')) return THREE.HalfFloatType;
    } else if (ext.has('OES_texture_half_float') && ext.has('WEBGL_color_buffer_float')) {
      return THREE.HalfFloatType;
    }
  } catch (e) { /* fall through */ }
  return THREE.UnsignedByteType;
}

export class PostFX {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.hdrType = pickHDRType(renderer);
    this.hdr = this.hdrType !== THREE.UnsignedByteType;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(quadGeo, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const mk = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      ...extra,
    });

    this.matPre = mk(PREFILTER_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 0.85 },
      uKnee: { value: 0.6 },
      uClamp: { value: 120.0 },
    });
    this.matDown = mk(DOWN_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.matUp = mk(UP_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 0.85 },
      uIntensity: { value: 0.85 },
    }, { transparent: true, blending: THREE.AdditiveBlending });
    this.matFinal = mk(FINAL_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      uExposure: { value: 1.0 },
      uBloomStrength: { value: 0.7 },
      uVignette: { value: 0.55 },
      uGrain: { value: 0.05 },
      uChromatic: { value: 0.4 },
      uTime: { value: 0 },
      uDebug: { value: 0 },
      uBloomOnly: { value: 0 },
    });

    this.rtScene = null;
    this.mips = [];
    this.rtLDR = null;
    this.width = 0; this.height = 0; this.rtScale = 1;
    this._empty = this._makeEmpty();
  }

  _makeEmpty() {
    return new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  }

  _mkRT(w, h, type) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: type || this.hdrType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    return rt;
  }

  /** width/height = CSS pixels, rtScale = extra render-resolution multiplier. */
  setSize(width, height, rtScale, dprFull) {
    this._cssW = width; this._cssH = height; this._dprFull = dprFull;
    this._rtScaleArg = rtScale;
    const rw = Math.max(2, Math.round(width * rtScale));
    const rh = Math.max(2, Math.round(height * rtScale));
    const lw = Math.max(2, Math.round(width * dprFull));
    const lh = Math.max(2, Math.round(height * dprFull));
    if (rw === this.width && rh === this.height && this.rtLDR && this.rtLDR.width === lw && this.rtLDR.height === lh) return false;

    this.width = rw; this.height = rh; this.rtScale = rtScale;
    this.dispose(true);

    this.rtScene = this._mkRT(rw, rh);
    const n = Math.max(2, Math.min(7, this.quality.bloomMips));
    this.mips = [];
    let mw = rw, mh = rh;
    for (let i = 0; i < n; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      this.mips.push(this._mkRT(mw, mh));
    }
    this.rtLDR = this._mkRT(lw, lh, THREE.UnsignedByteType);
    return true;
  }

  setQuality(q) {
    if (this.quality === q) return;
    this.quality = q;
    if (this._cssW) {
      this.width = 0; this.height = 0;
      this.setSize(this._cssW, this._cssH, this._rtScaleArg, this._dprFull);
    }
  }

  _blit(mat, target, clear = true) {
    const r = this.renderer;
    this.quad.material = mat;
    r.setRenderTarget(target || null);
    if (clear) r.clear(true, false, false);
    r.render(this.scene, this.camera);
  }

  /** Bind the HDR scene target (the raytracer renders into it). */
  beginScene() {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.clear(true, false, false);
    return this.rtScene;
  }

  /** Bloom pyramid + tonemapped composite to the screen (or an LDR target). */
  compose(opts) {
    const { params, debug = 0, time = 0, bloom = true, chromatic = true, quality = this.quality } = opts || {};
    this._lastOpts = opts || {};
    const r = this.renderer;
    const tScene = this.rtScene ? this.rtScene.texture : this._empty;

    let tBloom = this._empty;
    if (bloom && this.mips.length >= 1) {
      this.matPre.uniforms.tDiffuse.value = tScene;
      this.matPre.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
      this.matPre.uniforms.uThreshold.value = params.bloomThreshold;
      this._blit(this.matPre, this.mips[0]);

      for (let i = 1; i < this.mips.length; i++) {
        const src = this.mips[i - 1];
        this.matDown.uniforms.tDiffuse.value = src.texture;
        this.matDown.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this._blit(this.matDown, this.mips[i]);
      }
      for (let i = this.mips.length - 1; i > 0; i--) {
        const src = this.mips[i];
        this.matUp.uniforms.tDiffuse.value = src.texture;
        this.matUp.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.matUp.uniforms.uRadius.value = quality.bloomRadius;
        this.matUp.uniforms.uIntensity.value = 0.86;
        this._blit(this.matUp, this.mips[i - 1], false);
      }
      tBloom = this.mips[0].texture;
    }

    const f = this.matFinal.uniforms;
    f.tScene.value = tScene;
    f.tBloom.value = tBloom;
    f.uExposure.value = params.exposure;
    f.uBloomStrength.value = bloom ? params.bloomStrength : 0.0;
    f.uVignette.value = params.vignette;
    f.uGrain.value = params.grain;
    f.uChromatic.value = chromatic ? quality.chromatic : 0.0;
    f.uTime.value = time;
    f.uDebug.value = debug;

    this._blit(this.matFinal, this.target || null);
  }

  /** Render one composited frame into the LDR target and read it back. */
  capture() {
    const r = this.renderer;
    const opts = this._lastOpts || {
      params: { exposure: 1, bloomStrength: 0, vignette: 0, grain: 0, bloomThreshold: 1 },
      debug: 0, bloom: true, chromatic: false,
    };
    const prevTarget = this.target;
    this.target = this.rtLDR;
    this.compose(opts);
    this.target = prevTarget;
    this._lastOpts = opts;
    const w = this.rtLDR.width, h = this.rtLDR.height;
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(this.rtLDR, 0, 0, w, h, buf);
    return { buf, width: w, height: h };
  }

  dispose(targetsOnly = false) {
    if (this.rtScene) { this.rtScene.dispose(); this.rtScene = null; }
    for (const m of this.mips) m.dispose();
    this.mips = [];
    if (this.rtLDR) { this.rtLDR.dispose(); this.rtLDR = null; }
    if (!targetsOnly) {
      this.matPre.dispose(); this.matDown.dispose(); this.matUp.dispose(); this.matFinal.dispose();
      this.scene.remove(this.quad);
    }
  }
}
