/**
 * GARGANTUA — camera rig.
 * OrbitControls for free navigation, animated transitions between the four
 * presets and a cinematic keyframe loop with subtle handheld drift.
 *
 * Convention: position = r · (sinθ·cosφ, cosθ, sinθ·sinφ), θ measured from +Y
 * (the disk normal), so θ = 90° is exactly edge-on to the accretion disk.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PRESETS, CINE_KEYS } from './config.js';

const MIN_POLAR = THREE.MathUtils.degToRad(1.2);       // never exactly in-plane
const MAX_POLAR = Math.PI - MIN_POLAR;
const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);

export class CameraRig {
  constructor(camera, domElement, store) {
    this.camera = camera;
    this.store = store;
    this.controls = new OrbitControls(camera, domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.6;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 140;
    this.controls.minPolarAngle = MIN_POLAR;
    this.controls.maxPolarAngle = MAX_POLAR;
    this.controls.zoomToCursor = false;

    this.tween = null;
    this.cine = false;
    this.cineT = 0;
    this.cineDur = CINE_KEYS.reduce((a, k) => a + k.hold, 0);
    this.drift = new THREE.Vector3();
    this._userTouched = false;

    const onUser = () => {
      if (this.tween) this.tween = null;
      if (this.cine) { this.setCine(false); this.store.setCine(false); }
    };
    this.controls.addEventListener('start', onUser);
    domElement.addEventListener('wheel', onUser, { passive: true });
    domElement.addEventListener('touchstart', onUser, { passive: true });
  }

  spherical() {
    const p = this.camera.position;
    const r = p.length();
    const theta = Math.acos(THREE.MathUtils.clamp(p.y / Math.max(r, 1e-6), -1, 1));
    let phi = Math.atan2(p.z, p.x);
    if (phi < 0) phi += Math.PI * 2;
    return { r, theta, phi };
  }

  _place(r, theta, phi) {
    theta = THREE.MathUtils.clamp(theta, MIN_POLAR, MAX_POLAR);
    this.camera.position.set(
      r * Math.sin(theta) * Math.cos(phi),
      r * Math.cos(theta),
      r * Math.sin(theta) * Math.sin(phi),
    );
    this.camera.lookAt(0, 0, 0);
  }

  /** Animate (or snap) to preset i. */
  setPreset(i, instant = false) {
    const p = PRESETS[((i | 0) % PRESETS.length + PRESETS.length) % PRESETS.length];
    const target = {
      r: p.r,
      theta: THREE.MathUtils.degToRad(p.theta),
      phi: THREE.MathUtils.degToRad(p.phi),
      fov: p.fov,
    };
    if (instant) {
      this.tween = null;
      this._place(target.r, target.theta, target.phi);
      this.camera.fov = target.fov;
      this.camera.updateProjectionMatrix();
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this._pushFov(target.fov);
      return;
    }
    const cur = this.spherical();
    // take the short way around in azimuth
    let dphi = target.phi - cur.phi;
    while (dphi > Math.PI) dphi -= Math.PI * 2;
    while (dphi < -Math.PI) dphi += Math.PI * 2;
    this.tween = {
      t: 0, dur: 1.9,
      from: { r: cur.r, theta: cur.theta, phi: cur.phi, fov: this.camera.fov },
      to: { r: target.r, theta: target.theta, phi: cur.phi + dphi, fov: target.fov },
    };
    this.controls.target.set(0, 0, 0);
    this.setCine(false);
  }

  /** Reset to preset 1 without animation (R key). */
  reset() { this.setPreset(0, true); }

  setCine(on) {
    on = !!on;
    if (this.cine === on) return;
    this.cine = on;
    this.controls.enabled = !on;
    if (on) { this.tween = null; this.cineT = 0; }
    else {
      this.controls.enabled = true;
      const s = this.spherical();
      this.camera.fov = this.store.params.fov;
      this.camera.updateProjectionMatrix();
      this._place(s.r, s.theta, s.phi);
      this.controls.update();
    }
  }

  _pushFov(v) {
    if (Math.abs(this.store.params.fov - v) > 1e-4) {
      this.store.params.fov = v;
      this.store.emit('param', { key: 'fov', value: v });
    }
  }

  _cinePose(t) {
    const n = CINE_KEYS.length;
    let time = ((t % this.cineDur) + this.cineDur) % this.cineDur;
    let i = 0;
    while (time > CINE_KEYS[i].hold) { time -= CINE_KEYS[i].hold; i = (i + 1) % n; }
    const a = CINE_KEYS[i];
    const b = CINE_KEYS[(i + 1) % n];
    const local = time / a.hold;
    // ease in/out across most of the segment, hold briefly at the ends
    const k = smoother(THREE.MathUtils.clamp((local - 0.12) / 0.76, 0, 1));
    let dphi = b.phi - a.phi;
    if (dphi > 180) dphi -= 360;
    if (dphi < -180) dphi += 360;
    const drift = (f, amt) => Math.sin(t * f) * amt;
    return {
      r: THREE.MathUtils.lerp(a.r, b.r, k) * (1 + drift(0.061, 0.012)),
      theta: THREE.MathUtils.degToRad(THREE.MathUtils.lerp(a.theta, b.theta, k)) + drift(0.047, 0.010),
      phi: THREE.MathUtils.degToRad(THREE.MathUtils.lerp(a.phi, a.phi + dphi, k)) + drift(0.037, 0.012),
      fov: THREE.MathUtils.lerp(a.fov, b.fov, k) * (1 + drift(0.083, 0.010)),
    };
  }

  update(dt) {
    if (this.cine) {
      this.cineT += dt;
      const p = this._cinePose(this.cineT);
      this._place(p.r, p.theta, p.phi);
      this.camera.fov = p.fov;
      this.camera.updateProjectionMatrix();
      this._pushFov(p.fov);
      return;
    }
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const k = smoother(tw.t);
      const r = THREE.MathUtils.lerp(tw.from.r, tw.to.r, k);
      const th = THREE.MathUtils.lerp(tw.from.theta, tw.to.theta, k);
      const ph = THREE.MathUtils.lerp(tw.from.phi, tw.to.phi, k);
      const fv = THREE.MathUtils.lerp(tw.from.fov, tw.to.fov, k);
      this._place(r, th, ph);
      this.camera.fov = fv;
      this.camera.updateProjectionMatrix();
      this._pushFov(fv);
      if (tw.t >= 1) this.tween = null;
      return;
    }
    this.controls.update();
    const want = this.store.params.fov;
    if (Math.abs(this.camera.fov - want) > 1e-3) {
      this.camera.fov = want;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose() { this.controls.dispose(); }
}
