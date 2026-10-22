/**
 * GARGANTUA — the raytracer quad.
 * Owns the full-screen ShaderMaterial that integrates the null geodesics and
 * keeps its uniforms in sync with the parameter store.
 */

import * as THREE from 'three';
import { BLACKHOLE_VERT, BLACKHOLE_FRAG } from '../glsl/blackhole.js';

export class Raytracer {
  constructor() {
    this.uniforms = {
      uResolution:      { value: new THREE.Vector2(1280, 720) },
      uCamPos:          { value: new THREE.Vector3(0, 1.5, 17) },
      uCamRight:        { value: new THREE.Vector3(1, 0, 0) },
      uCamUp:           { value: new THREE.Vector3(0, 1, 0) },
      uCamFwd:          { value: new THREE.Vector3(0, 0, -1) },
      uTanHalfFov:      { value: Math.tan(THREE.MathUtils.degToRad(42) * 0.5) },

      uTime:            { value: 0 },
      uMaxSteps:        { value: 640 },
      uStepSize:        { value: 0.038 },
      uEscapeR:         { value: 260 },

      uDiskOn:          { value: 1 },
      uDiskInner:       { value: 3.0 },
      uDiskOuter:       { value: 19.5 },
      uDiskThickness:   { value: 0.34 },
      uDiskDensity:     { value: 0.92 },
      uDiskBrightness:  { value: 2.6 },
      uDiskTemp:        { value: 8600 },
      uDoppler:         { value: 1.0 },
      uRedshift:        { value: 1.0 },
      uDiskSpin:        { value: 1.0 },
      uTurbScale:       { value: 0.34 },
      uTurbSpeed:       { value: 1.0 },
      uTurbContrast:    { value: 0.85 },
      uNewtonian:       { value: 0 },

      uStarOn:          { value: 1 },
      uStarDensity:     { value: 1.0 },
      uStarBrightness:  { value: 1.0 },
      uGalaxyBrightness:{ value: 0.85 },
      uNebula:          { value: 0.75 },

      uDebug:           { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: BLACKHOLE_VERT,
      fragmentShader: BLACKHOLE_FRAG,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      precision: 'highp',
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this._r = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._f = new THREE.Vector3();
  }

  /**
   * @param {object} o
   * @param {object} o.params   the 21 live parameters
   * @param {object} o.toggles  boolean extras
   * @param {object} o.quality  active quality tier
   * @param {number} o.debug    debug view index 0…9
   * @param {number} o.time     simulation time (s)
   * @param {THREE.Camera} o.camera
   * @param {number} o.width    render width in device px
   * @param {number} o.height   render height in device px
   */
  update(o) {
    const u = this.uniforms;
    const { params: p, toggles: t, quality: q, debug, time, camera, width, height } = o;

    u.uResolution.value.set(width, height);
    u.uTime.value = time;

    /* camera basis (the raytracer ignores the projection matrix) */
    const e = camera.matrixWorld.elements;
    this._r.set(e[0], e[1], e[2]).normalize();
    this._u.set(e[4], e[5], e[6]).normalize();
    this._f.set(-e[8], -e[9], -e[10]).normalize();
    u.uCamRight.value.copy(this._r);
    u.uCamUp.value.copy(this._u);
    u.uCamFwd.value.copy(this._f);
    u.uCamPos.value.copy(camera.position);
    u.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(p.fov) * 0.5);

    /* integration budget */
    const stepBoost = height >= 1600 ? 1.0 : 1.0;
    u.uMaxSteps.value = Math.max(96, Math.round(q.steps * stepBoost));
    u.uStepSize.value = q.stepSize;
    u.uEscapeR.value = Math.max(q.escapeR, camera.position.length() * 2.0 + 2.0);

    /* disk */
    u.uDiskOn.value = (t.disk && debug !== 5) ? 1 : 0;
    u.uDiskInner.value = p.diskInner;
    u.uDiskOuter.value = Math.max(p.diskOuter, p.diskInner + 1.0);
    u.uDiskThickness.value = p.diskThickness;
    u.uDiskDensity.value = p.diskDensity;
    u.uDiskBrightness.value = p.diskBrightness;
    u.uDiskTemp.value = p.diskTemp;
    u.uDoppler.value = p.doppler;
    u.uRedshift.value = p.redshift;
    u.uDiskSpin.value = p.diskSpin >= 0 ? 1 : -1;
    u.uTurbScale.value = p.turbScale;
    u.uTurbSpeed.value = p.turbSpeed;
    u.uTurbContrast.value = p.turbContrast;
    u.uNewtonian.value = debug === 4 ? 1 : 0;

    /* sky */
    u.uStarOn.value = t.stars ? 1 : 0;
    u.uStarDensity.value = p.starDensity;
    u.uStarBrightness.value = p.starBrightness;
    u.uGalaxyBrightness.value = p.galaxyBrightness;
    u.uNebula.value = p.nebula;

    u.uDebug.value = debug | 0;
  }

  dispose() {
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.scene.remove(this.mesh);
  }
}
