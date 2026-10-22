/**
 * GARGANTUA — configuration surface.
 *
 * Everything the HUD, the shader and the URL automation layer agree on lives
 * here: the 21 live parameters, the four camera presets, the three quality
 * tiers and the ten debug views.
 *
 * Geometry convention (identical in the shader and in JS):
 *   • the black hole sits at the origin, r = 1 equals one Schwarzschild radius
 *   • the accretion disk lies in the y = 0 plane and rotates about +Y
 *   • the camera orbits the origin, polar angle θ measured from +Y
 */

export const RS = 1.0;              // Schwarzschild radius in world units
export const ISCO = 3.0 * RS;       // innermost stable circular orbit (6M)
export const B_CRIT = 3 * Math.sqrt(3) * 0.5 * RS; // critical impact parameter 3√3 M

/* ────────────────────────────────────────────────────────────────────────── *
 *  21 live parameters.  `default` is the shipped look; the HUD is generated
 *  from this table, persistence stores exactly these keys.
 * ────────────────────────────────────────────────────────────────────────── */
export const PARAMS = [
  // ── image ───────────────────────────────────────────────────────────────
  { key:'exposure',       label:'Exposure',            group:'Image',      min:0.05, max:4,    step:0.01, def:1.00, fmt:v=>v.toFixed(2)+'×' },
  { key:'fov',            label:'Field of View',       group:'Image',      min:12,   max:85,   step:0.5,  def:42,   fmt:v=>v.toFixed(1)+'°' },
  // ── accretion disk ──────────────────────────────────────────────────────
  { key:'diskInner',      label:'Disk Inner Edge',     group:'Accretion Disk', min:2.0, max:9,   step:0.02, def:3.0,  fmt:v=>v.toFixed(2)+' r\u209B' },
  { key:'diskOuter',      label:'Disk Outer Edge',     group:'Accretion Disk', min:6,   max:40,  step:0.1,  def:14.5, fmt:v=>v.toFixed(1)+' r\u209B' },
  { key:'diskThickness',  label:'Disk Scale Height',   group:'Accretion Disk', min:0.02,max:1.2, step:0.005,def:0.34, fmt:v=>v.toFixed(3)+' r\u209B' },
  { key:'diskDensity',    label:'Disk Optical Depth',  group:'Accretion Disk', min:0,   max:3,   step:0.01, def:0.62, fmt:v=>v.toFixed(2) },
  { key:'diskBrightness', label:'Disk Emissivity',     group:'Accretion Disk', min:0,   max:8,   step:0.01, def:1.10,  fmt:v=>v.toFixed(2) },
  { key:'diskTemp',       label:'Peak Temperature',    group:'Accretion Disk', min:2000,max:20000,step:50,  def:7600, fmt:v=>Math.round(v)+' K' },
  // ── relativity ──────────────────────────────────────────────────────────
  { key:'doppler',        label:'Doppler Beaming',     group:'Relativity', min:0,   max:1.5,  step:0.01, def:1.0,  fmt:v=>v.toFixed(2)+'×' },
  { key:'redshift',       label:'Gravitational Redshift', group:'Relativity', min:0, max:1.5, step:0.01, def:1.0, fmt:v=>v.toFixed(2)+'×' },
  // ── turbulence ──────────────────────────────────────────────────────────
  { key:'turbScale',      label:'Turbulence Scale',    group:'Turbulence', min:0.05, max:1.4,  step:0.005,def:0.42, fmt:v=>v.toFixed(3) },
  { key:'turbSpeed',      label:'Turbulence Speed',    group:'Turbulence', min:0,    max:2.5,  step:0.01, def:1.0,  fmt:v=>v.toFixed(2)+'×' },
  { key:'turbContrast',   label:'Turbulence Contrast', group:'Turbulence', min:0,    max:1.5,  step:0.01, def:1.00, fmt:v=>v.toFixed(2) },
  // ── sky ─────────────────────────────────────────────────────────────────
  { key:'starDensity',    label:'Star Density',        group:'Deep Sky',   min:0,    max:2,    step:0.01, def:1.0,  fmt:v=>v.toFixed(2)+'×' },
  { key:'starBrightness', label:'Star Brightness',     group:'Deep Sky',   min:0,    max:3,    step:0.01, def:1.0,  fmt:v=>v.toFixed(2)+'×' },
  { key:'galaxyBrightness',label:'Galaxy Luminance',   group:'Deep Sky',   min:0,    max:2.5,  step:0.01, def:1.00, fmt:v=>v.toFixed(2)+'×' },
  { key:'nebula',         label:'Nebula Emission',     group:'Deep Sky',   min:0,    max:2.5,  step:0.01, def:1.00, fmt:v=>v.toFixed(2)+'×' },
  // ── post ────────────────────────────────────────────────────────────────
  { key:'bloomStrength',  label:'Bloom Strength',      group:'Post Processing', min:0, max:2.5, step:0.01, def:0.45, fmt:v=>v.toFixed(2) },
  { key:'bloomThreshold', label:'Bloom Threshold',     group:'Post Processing', min:0, max:3,   step:0.01, def:1.10, fmt:v=>v.toFixed(2) },
  { key:'vignette',       label:'Vignette',            group:'Post Processing', min:0, max:1.4, step:0.01, def:0.55, fmt:v=>v.toFixed(2) },
  { key:'grain',          label:'Film Grain',          group:'Post Processing', min:0, max:0.25,step:0.002,def:0.05, fmt:v=>v.toFixed(3) },
];

export const PARAM_COUNT = PARAMS.length; // 21 — exactly the sliders shown in the HUD

/* Numeric controls that live outside the 21 sliders (rendered as buttons). */
export const EXTRAS = [
  { key:'diskSpin', label:'Orbital Direction', min:-1, max:1, step:2, def:1, fmt:v => (v > 0 ? 'prograde' : 'retrograde') },
];
export const ALL_PARAMS = [...PARAMS, ...EXTRAS];

/* Boolean / enumerated extras (not part of the 21 numeric parameters). */
export const TOGGLES = [
  { key:'bloom',      label:'Bloom',        def:true  },
  { key:'chromatic',  label:'Dispersion',   def:true  },
  { key:'adaptive',   label:'Adaptive Res', def:true  },
  { key:'disk',       label:'Disk',         def:true  },
  { key:'stars',      label:'Starfield',    def:true  },
  { key:'timeFlow',   label:'Time',         def:true  },
];

/* ────────────────────────────────────────────────────────────────────────── *
 *  Quality tiers.
 * ────────────────────────────────────────────────────────────────────────── */
export const QUALITY = {
  standard: {
    id:'standard', label:'STANDARD', steps:320,  stepSize:0.055, escapeR:220,
    renderScale:0.72, maxDpr:1.5, bloomMips:4, bloomRadius:0.72, chromatic:0.25,
    targetPixels:1.25e6,
  },
  high: {
    id:'high', label:'HIGH', steps:640, stepSize:0.038, escapeR:260,
    renderScale:1.0, maxDpr:2.0, bloomMips:5, bloomRadius:0.85, chromatic:0.45,
    targetPixels:2.6e6,
  },
  cinematic: {
    id:'cinematic', label:'CINEMATIC', steps:1150, stepSize:0.024, escapeR:320,
    renderScale:1.0, maxDpr:2.0, bloomMips:6, bloomRadius:1.0, chromatic:0.7,
    targetPixels:4.6e6,
  },
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  Debug views 0…9  (digit key selects, uDebug uniform drives the shader,
 *  view 8 = bloom buffer is composited by the post pipeline).
 * ────────────────────────────────────────────────────────────────────────── */
export const DEBUG_VIEWS = [
  { id:0, name:'BEAUTY',            desc:'Full relativistic render — HDR bloom, ACES, vignette, grain and dispersion.' },
  { id:1, name:'INTEGRATION COST',  desc:'Geodesic steps consumed per ray. Red = full budget: the winding region around the photon sphere.' },
  { id:2, name:'DISK CROSSINGS',    desc:'How many times each photon crossed the equatorial plane. Multiple crossings = higher-order disk images.' },
  { id:3, name:'REDSHIFT FACTOR g', desc:'Total frequency ratio ν_obs/ν_emit at the last disk crossing — blue approaching, red receding.' },
  { id:4, name:'NEWTONIAN DISK',    desc:'Accretion disk with gravitational redshift and beaming switched off — pure lensing geometry.' },
  { id:5, name:'LENSED SKY',        desc:'Background sky only: procedural stars and Milky Way warped by the metric. Einstein rings of the galactic band.' },
  { id:6, name:'IMPACT PARAMETER',  desc:'Photon impact parameter b against the critical value 3√3 M = 2.598 r\u209B. The critical curve is the bright rim.' },
  { id:7, name:'TEMPERATURE MAP',   desc:'Observed blackbody temperature of the disk surface in Kelvin (false colour).' },
  { id:8, name:'BLOOM BUFFER',      desc:'The HDR bloom pyramid alone — threshold, mip chain and tent reconstruction.' },
  { id:9, name:'OPTICAL DEPTH',     desc:'Accumulated disk absorption 1−T plus the pure-black capture mask of the event horizon.' },
];

/* ────────────────────────────────────────────────────────────────────────── *
 *  Four camera presets (spherical: radius, polar θ°, azimuth φ°, field of view).
 * ────────────────────────────────────────────────────────────────────────── */
export const PRESETS = [
  { name:'INTERSTELLAR', r:24.0, theta:84.5, phi:38,  fov:40, desc:'Near edge-on. The disk wraps above and below the shadow — the classic lensed double image.' },
  { name:'OVERHEAD',     r:40.0, theta:14.0, phi:-24, fov:40, desc:'Looking down the rotation axis: a clean Einstein ring and the far side of the disk bent over the top.' },
  { name:'PHOTON RING',  r:8.5,  theta:78.0, phi:12,  fov:58, desc:'Close approach at 6.6 r\u209B. The photon ring and the chaotic higher-order images fill the frame.' },
  { name:'WIDE CINE',    r:52.0, theta:66.0, phi:118, fov:50, desc:'Wide establishing shot — the lensed galaxy field and the full extent of the accretion flow.' },
];

/* ────────────────────────────────────────────────────────────────────────── *
 *  Cinematic camera loop: keyframes blending presets with slow drift.
 * ────────────────────────────────────────────────────────────────────────── */
export const CINE_KEYS = [
  { r:44.0, theta:66.0, phi:118.0, fov:52, hold:7.0 },
  { r:22.0, theta:87.5, phi:150.0, fov:44, hold:9.0 },
  { r:9.5,  theta:79.0, phi:196.0, fov:30, hold:8.0 },
  { r:6.6,  theta:71.0, phi:238.0, fov:24, hold:7.0 },
  { r:14.0, theta:14.0, phi:284.0, fov:36, hold:8.0 },
  { r:30.0, theta:38.0, phi:330.0, fov:46, hold:7.0 },
];

export const SHORTCUTS = [
  { group:'Views', rows:[
    ['0 – 9', 'debug view (beauty … optical depth)'],
    ['⇧ + 1 – 4', 'camera preset 1 – 4'],
    ['C', 'cinematic camera loop'],
    ['drag / wheel / pinch', 'orbit · zoom (OrbitControls)'],
  ]},
  { group:'Playback', rows:[
    ['space', 'pause / resume simulation time'],
    [', / .', 'time scale −/+'],
    ['R', 'reset camera to preset 1'],
    ['⇧ + R', 'reset all parameters'],
  ]},
  { group:'Image', rows:[
    ['[ / ]', 'exposure −/+'],
    ['- / =', 'field of view −/+'],
    ['B', 'bloom on / off'],
    ['S', 'save PNG frame'],
  ]},
  { group:'Interface', rows:[
    ['H', 'hide / show HUD'],
    ['Tab', 'collapse control deck'],
    ['M', 'ambient music'],
    ['T', 'cycle quality tier (Standard/High/Cinematic)'],
    ['F', 'fullscreen'],
    ['/ or ?', 'this sheet'],
  ]},
];

/* URL automation defaults (see README → "Screenshot automation"). */
export const URL_PARAM_KEYS = new Set([
  ...ALL_PARAMS.map(p => p.key),
  'quality','debug','preset','shot','t','time','hud','cine','music','fov','pause','frames','dpr','scale',
]);
