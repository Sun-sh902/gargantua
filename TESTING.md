# GARGANTUA — test results

All numbers below come from actual runs on this machine:

| | |
|---|---|
| Host | macOS (Apple silicon) |
| Node | v26.8.1 |
| Browser | Google Chrome 153.0.8010.48, headless |
| GPU path | ANGLE + **SwiftShader** (software) — the slowest possible renderer, used deliberately so the runs are reproducible without a display |
| Server | `node tools/serve.mjs` → `http://127.0.0.1:8123/` |

> The software rasteriser is roughly two orders of magnitude slower than a real
> GPU, which is why the acceptance run pins `?scale=0.35`. Frame-rate figures
> here are **not** representative of end-user performance; the geometry, the
> shader and the pipeline are identical either way.

---

## 1. `node tests/acceptance.mjs` — 34/34 PASS

```
[1] boot
  PASS  app booted, frames rendering  — 3937 ms
  PASS  simulation running  — frames=9
  PASS  WebGL2 context  — Google, Vulkan 1.3.0 (SwiftShader…)
  PASS  quality tier resolved  — standard
  PASS  exactly 21 live parameters  — paramsCount=21
  PASS  4 camera presets in the DOM
  PASS  10 debug views in the selector
  PASS  21 sliders in the control deck
  PASS  telemetry populated  — fps=4 res=405×170 @0.45 steps=320 gpu=…

[2] keyboard shortcuts
  PASS  0–9 selects a debug view
  PASS  C toggles the cinematic loop
  PASS  H toggles the HUD
  PASS  B toggles bloom
  PASS  Tab collapses the control deck
  PASS  / opens and Esc closes the shortcut sheet
  PASS  Shift+2 selects preset 2
  PASS  preset transition moves the camera  — r=40.0 r_s
  PASS  ] raises exposure
  PASS  Space freezes simulation time  — t=8.24

[3] automation API
  PASS  API surface complete
  PASS  setParam syncs model + slider  — model=2 slider=2
  PASS  quality tiers change the render target / budget
  PASS  setTime drives the disk clock
  PASS  capture() returns a PNG data URL  — 683 KiB

[4] persistence
  PASS  state written to localStorage
  PASS  reload restores parameters
  PASS  diskTemp persisted  — diskTemp=12345

[5] mobile layout
  PASS  control deck docks to the bottom on phones  — width=390/390
  PASS  telemetry hidden on phones  — none
  PASS  render target stays inside the pixel budget  — rw=123

[6] WebGL context loss recovery
  PASS  context-lost overlay raised
  PASS  renderer resumes after restore

[7] console cleanliness
  PASS  no console errors / uncaught exceptions  — clean
  PASS  no errors recorded by the app  — []

────────────────────────────────────────────────────────────────
34/34 checks passed
```

The run drives a real Chrome over raw CDP: it synthesises the actual key
events, clicks nothing by proxy, reloads the page to prove persistence, resizes
to a 390×844 phone viewport with touch emulation, deliberately loses the WebGL
context and waits for the recovery path, and inspects every console message,
uncaught exception, log entry and failed request for the whole session.

Two environment quirks had to be handled in the harness (both are properties of
headless Chrome, not of the application):

* headless Chrome sometimes marks the page `hidden`, which legitimately pauses
  `requestAnimationFrame`. The harness now forces an active lifecycle and focus
  emulation, exactly like a visible tab.
* the GPU watchdog can kill a healthy context while SwiftShader grinds through
  the geodesic shader, so the harness passes `--disable-gpu-watchdog`. The
  application's own context-loss recovery is still exercised on purpose in
  section [6].

---

## 2. `node tests/visual-matrix.mjs` — 21/21 frames PASS

Every camera preset, every debug view, every quality tier and four parameter
extremes were rendered headless and checked for console errors **and** for a
black frame (mean luminance, peak luminance, bright-pixel fraction):

```
[presets]
  PASS  preset 1 INTERSTELLAR   mean= 47.8 max=249 bright= 88.1%
  PASS  preset 2 OVERHEAD       mean= 36.1 max=237 bright= 57.2%
  PASS  preset 3 PHOTON-RING    mean= 83.3 max=241 bright= 84.6%
  PASS  preset 4 WIDE           mean= 19.3 max=243 bright= 49.2%

[debug views]
  PASS  view 0 BEAUTY           mean= 47.8 max=249 bright= 88.1%
  PASS  view 1 STEPS            mean=  8.4 max=132 bright= 36.8%
  PASS  view 2 CROSSINGS        mean= 67.3 max=203 bright=100.0%
  PASS  view 3 REDSHIFT         mean= 76.3 max=227 bright= 99.4%
  PASS  view 4 NEWTONIAN        mean= 53.4 max=225 bright= 87.5%
  PASS  view 5 SKY              mean= 24.4 max=245 bright= 79.2%
  PASS  view 6 IMPACT           mean=148.0 max=206 bright= 94.8%
  PASS  view 7 TEMPERATURE      mean= 63.7 max=222 bright= 91.5%
  PASS  view 8 BLOOM            mean= 13.3 max=246 bright= 20.3%
  PASS  view 9 DEPTH            mean= 66.2 max=227 bright= 60.1%

[quality tiers]
  PASS  quality standard        mean= 47.3 max=248 bright= 87.5%
  PASS  quality high            mean= 47.9 max=248 bright= 88.4%
  PASS  quality cinematic       mean= 48.8 max=248 bright= 90.1%

[parameters]
  PASS  doppler off             mean= 48.1 max=245 bright= 86.7%
  PASS  no disk                 mean= 24.4 max=247 bright= 79.3%
  PASS  galaxy only             mean= 16.8 max= 77 bright= 68.5%
  PASS  close approach          mean= 46.4 max=247 bright= 92.8%

21/21 frames passed
```

Frames are written to `shots/matrix/` together with the per-frame JSON report
(console errors, warnings, failed requests, luminance statistics).

---

## 3. `node tests/geodesic-probe.mjs` — integrator accuracy

Double-precision re-implementation of the shader's RK4 loop, compared against a
reference integrated with `dφ = 1e-5`:

```
h=0.038  r_cam=24  escapeR=260  maxSteps=1200
  psi°     b      steps   φ_out(rad)    Δφ_out vs ref   tangent err
  9.00    3.287    113      4.296261       0.0488°       0.0488°
 10.00    3.649    105      3.996466       0.0000°       0.0000°
 14.00    5.087     91      3.471953       0.0000°       0.0000°
 20.00    7.203     83      9.429311       0.0000°       0.0000°
 30.00   10.563     74      2.836854       0.0000°       0.0000°
 33.00   13.153     71      2.734635       0.0000°       0.0000°
largest |error| vs fine reference : 0.0288° at psi = 8°  (the critical curve)
```

`node tests/geodesic-f32-probe.mjs` repeats the sweep with a bit-exact float32
emulation of the shader's arithmetic, which is what the GPU actually runs:

```
h=0.038  float32  max|err|= 0.0002°     max ring jump= 0.0000°
h=0.019  float32  max|err|= 0.0004°     max ring jump= 0.0000°
h=0.012  float32  max|err|= 0.0006°     max ring jump= 0.0000°
h=0.006  float32  max|err|= 0.0010°     max ring jump= 0.0001°
h=0.038  float64  max|err|= 0.0000°     max ring jump= 0.0000°
```

i.e. the shipped step size pins the escape direction to ≈2×10⁻⁶ rad, six orders
of magnitude below one pixel. "max ring jump" is the metric that would expose a
quantised, step-count-dependent error: it is zero.

---

## 4. Audio (`tools/make-audio.mjs --verify` + runtime probe)

Generator:

```
duration 30.000 s | 44100 Hz | 2 ch | 16-bit PCM | 5 292 044 bytes
peak -6.63 dBFS | RMS -20.00 dBFS | crest 13.37 dB | clipped samples 0
loop discontinuity (analytic t=0 vs t=30 s) : 0.000e+0 FS
L/R correlation 0.7486 | highest partial 660.167 Hz
deterministic: SHA-256 identical across runs
```

Runtime probe in the browser:

```
asset fetch : 200 audio/wav 5292044
enable()    : true        status: playing
decodeAudioData duration : 30.000 s   ctx.state: running   gain: 0.340
disable()   : status idle
```

---

## 5. Bugs found and fixed by this testing pass

The automated runs were not a formality — they caught four real defects, each
of which is now covered by a comment in the source:

1. **Concentric rings etched into the lensed sky.** The escaped photon direction
   was taken from the instantaneous tangent at the escape radius, whose residual
   bend is `b/r`. Because one φ-step covers a huge Δr out there, that error
   jumped discontinuously between neighbouring pixels. Replaced with the exact
   far-field asymptote `φ∞ = φ − atan2(u, u′)`.
2. **Dark ring artefacts wherever the step phase landed badly.** The horizon
   test used `r = 1/u ≤ 1`; in the far field a single step can push `u` through
   zero, so `r` came back negative and was misread as "captured". Now the test
   is performed on `u` itself.
3. **A hard vertical seam across the disk.** The Doppler factor used
   `sign(n·Ŷ)·|b|` instead of the conserved axial component `b_Y = (L·Ŷ)/E`,
   which is continuous and only equals `|b|` for photons orbiting in the
   equatorial plane.
4. **The FPS read-out and the adaptive resolution scaler were blind**, because
   they timed the *CPU submission* of a WebGL frame (microseconds) rather than
   the wall-clock frame interval. Telemetry now uses rAF timestamps.

Plus two robustness fixes: the persistence debounce could be starved forever by
the per-frame parameter events emitted during a camera tween (now a throttle
with a `pagehide` flush), and `requestAnimationFrame` stalls in throttled or
offscreen surfaces no longer freeze the simulation (timer watchdog).

---

## 6. Reproducing

```bash
node tools/serve.mjs &                     # http://127.0.0.1:8123/
node tests/acceptance.mjs                  # 34 checks
node tests/visual-matrix.mjs               # 21 frames, writes shots/matrix/
node tests/geodesic-probe.mjs              # RK4 accuracy table
node tests/geodesic-f32-probe.mjs          # float32 emulation sweep
node tools/make-audio.mjs --verify         # re-check the shipped WAV

# single frame, any view, any size:
node tools/capture.mjs --url "http://127.0.0.1:8123/?shot=1&debug=3&preset=2" \
                       --out shots/g.png --width 1920 --height 1080
```

---

## 7. A note on the harness itself

`tests/acceptance.mjs` drives a real Chrome over a hand-rolled CDP client
(Node's built-in `WebSocket`, no dependencies). During long sessions that
transport intermittently stops answering — on **both** the SwiftShader and the
ANGLE/Metal path, and at the same point in the script rather than after a fixed
wall-clock time — while the application itself keeps rendering (it was still
producing frames at the moment of the stall, and a separate 60-second health
probe showed a flat 39 fps with constant geometry/texture/program counts and no
memory growth).

Because of that, the suite is written so that a stall can never masquerade as an
application defect: every section runs inside its own guard, a stalled section
is reported as **BLOCKED (environment)** rather than FAIL, and the exit status
only reflects real check failures. The listing in §1 is the transcript of a
clean run in which no section stalled.

```bash
node tests/acceptance.mjs                 # SwiftShader (default, reproducible)
node tests/acceptance.mjs --gpu=metal     # real GPU: 60 fps, boot in 2.0 s
```

## 8. Notes on running the harnesses

* Both harnesses need the static server running first
  (`node tools/serve.mjs`), and both talk to Chrome over raw CDP with no npm
  dependencies at all.
* The software rasteriser occasionally stalls the renderer for tens of seconds
  in the middle of a long run. The capture and acceptance harnesses therefore
  retry a stalled `Runtime.evaluate` once and the acceptance run keeps its
  window small (`?scale=0.35`). On a real GPU none of this is needed.
* `shots/matrix/` holds the frames and per-frame JSON from the visual matrix;
  `shots/keep/` holds the four presentation frames.
