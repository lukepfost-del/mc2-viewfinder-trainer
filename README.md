# MC2 Viewfinder Trainer 2.0

Phone-based aiming simulator for the OXOS MC2 emitter, with a video-game-style
tutorial and a free-practice mode. Pairs with a printed QR target card.

Successor to `mc2-trainer/` (v1). Pose math is a verbatim port; the tutorial
shell and rep mechanics are new in 2.0.

## What's new vs v1

- **Two routes at the start:** Tutorial or Play.
- **Five gated tutorial levels.** Each is a SKILL the user practices THREE times:
  1. **Aim** — land the crosshair on the cassette
  2. **Center** — fine-tune to the bullseye
  3. **Perpendicular** — flatten tilt under 3°
  4. **SID** — set distance to 60 cm ± 5 cm
  5. **Safe Exposure** — keep all four green simultaneously
- **EXPOSE button is the lock action.** No hold-to-pass meter, no time boxes.
  When the pose is in spec the button arms green; the user presses EXPOSE
  to lock that rep. Deliberate, not auto-passed.
- **Rearm gating.** After a rep is locked, the pose must drift OUT of spec
  before the next rep can arm. Stops EXPOSE-spamming while still in position.
- **Continue button between levels.** No auto-advance — user paces themselves.
- **Auto-transition to Play mode** after the final level's last rep.
- **Layered HUD** — only the chrome relevant to the current lesson is shown.
- **Subtle sound + haptics.** Soft sine tones, low master gain, brief.
- **Camera profile picker** on the start screen — different phone cameras
  have different fields of view, so the trainer ships with presets:
  - Default phone (~75° FOV) — main camera on most phones
  - Wide phone (~85° FOV)
  - Ultra-wide (~110° FOV)
  - Telephoto (~50° FOV)
  Selection persists in `localStorage`. If SID readings feel consistently
  off, swap profiles.
- **Removed:** the QR-size input on the start screen — printed cards are
  fixed at 9 cm, calibration is always correct.

## Files

- `index.html` — UI shell, start screen, app shell
- `styles.css` — all styling
- `app.js` — main entry: camera, ArUco detection, pose math, render loop,
  mode router, tutorial state machine (rep-based), Play mode HUD
- `levels.js` — 5 level definitions, tunable thresholds, camera profiles
- `audio.js` — subtle WebAudio synth + haptics (no asset deps)
- `assets/` — copied verbatim from v1 (chrome SVGs, ArUco JS, cassette image)
- `qr-target.pdf` / `qr-target.png` — the printable cassette target

## How to use

1. **Print** `qr-target.pdf` at 100% scale on letter paper (NOT "fit to page").
2. **Lay** the page flat — that's your cassette.
3. **Open** the live demo URL on your phone (HTTPS required for camera).
4. Pick a **camera profile** if SID readings look consistently off.
5. Tap **Tutorial** to learn, or **Play** for free practice.

## Tuning

Game-feel knobs are at the top of `levels.js` in the `TUNING` object:

```js
const TUNING = {
  defaultReps:        3,        // reps per skill
  aimRadiusCm:        12.0,     // L1 tolerance
  centerRadiusCm:     2.5,      // L2 tolerance
  perpTiltDeg:        3.0,      // L3 — tighter than device default of 5°
  sidTargetCm:        60.0,
  sidToleranceCm:     5.0,
  ssdMinCm:           30.0,
  patientThicknessCm: 5.0,
  resetMultiplier:    1.5,      // how far out-of-spec to allow next rep
};
```

Camera profile presets (focal length proxies) are in `CAMERA_PROFILES` in
the same file — easy to add new ones.

## Device-side reference

The pose pipeline mirrors what `mcx-monorepo/mcx-common-libs/viewfinder-lib`
does on the actual MC2 hardware:

- **Detection:** ArUco DICT_4X4_1000 ID 0 (`AR.Detector` in the trainer;
  device uses OpenCV's ArUco detector with the same dictionary).
- **Pose recovery:** the trainer estimates a 4-point homography and decomposes
  for tilt; the device runs `cv::solvePnP(objectPts, imgPts, K, D, rvec, tvec,
  ITERATIVE)` with **factory-calibrated K and D per camera** (see
  `mcx-common-libs/tracking-system-lib/lib/src/PositionManager.cpp`). Phones
  don't ship with calibrated K/D, so the trainer assumes near-zero distortion
  and approximates focal length via the camera profile setting.
- **Crosshair behavior:** matches `TiltGuideOverlay::render` —
  `if (|tilt.x| >= snapAngle || |tilt.y| >= snapAngle) draw cross OFFSET
  by tilt; else draw at center` (the "completed" state). Device default
  `snapAngle = 5°` (configurable via `xr.general.tilt_snap_angle`); trainer
  uses 3° for tighter feel.
- **Camera-cassette warp:** device runs a VPI polynomial undistortion warp
  per pipeline (`ViewfinderPipeline::initVpiPayloads`), then projects overlays
  via `cv::projectPoints`. The trainer skips undistortion (assumed minimal
  on phone main cameras) and uses a 4-point similarity warp for the cassette
  image overlay.

## Local development

```bash
cd mc2-trainer-v2
python3 -m http.server 8080
# then open http://localhost:8080 on the same machine
```

Phone testing without GitHub Pages — use an HTTPS tunnel:

```bash
npx serve -l 5173 &
ngrok http 5173
```

## Self-test

```bash
node --check app.js
node --check levels.js
node --check audio.js
```
