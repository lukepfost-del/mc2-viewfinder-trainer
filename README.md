# MC2 Viewfinder Trainer 2.0

A video-game-style tutorial for learning the MC2 emitter aiming controls,
plus a free-practice "Play" mode. Uses your phone camera and a printed
QR target card.

Successor to `mc2-trainer/` (v1). Same pose math; new tutorial shell.

## What's new vs v1

- **Two routes at the start:** Tutorial or Play.
- **Five gated tutorial levels** (must pass each to unlock the next):
  1. **Aim** — land the crosshair on the cassette
  2. **Center** — fine-tune to the bullseye
  3. **Perpendicular** — flatten tilt under 8°
  4. **SID** — set distance to 60 cm
  5. **Safe Exposure** — keep all four green, then press EXPOSE
- **Hold-to-pass meter** that fills while you stay in spec and resets if you drift.
- **Star rating per level** (1–3 stars based on drift count) saved to `localStorage`.
- **Layered HUD** — only the chrome relevant to the current lesson is shown,
  so you aren't drowning in numbers while learning to point the camera.
- **Sound + haptics** — synthesized lock-on tick, hold-progress ramp,
  level-complete chime, error tick. Mute toggle in the top bar.
- **Prompt strip above** the viewfinder for the lesson instruction.
- **Feedback strip below** the viewfinder for the live hold meter and
  numeric readouts (only the metrics being taught).
- **Removed:** the QR-size input on the start screen. The trainer now
  assumes a fixed 9 cm QR — print `qr-target.pdf` at 100% scale on letter
  paper and the calibration is always correct.

## Files

- `index.html` — UI shell, start screen, app shell
- `styles.css` — all styling
- `app.js` — main entry: camera, ArUco detection, pose math, render loop,
  mode router, tutorial state machine, Play mode HUD
- `levels.js` — 5 level definitions + tunable thresholds at the top
- `audio.js` — WebAudio synth + haptic helpers (no asset deps)
- `assets/` — copied verbatim from v1 (chrome SVGs, ArUco JS, cassette image)
- `qr-target.pdf` / `qr-target.png` — the printable cassette target

## How to use

1. **Print** `qr-target.pdf` at 100% scale on letter paper (NOT "fit to page").
2. **Lay** the page flat — that's your cassette.
3. **Open** the live demo URL on your phone (HTTPS required for camera).
4. Pick **Tutorial** to learn, or **Play** for free practice.

## Tuning

Game feel knobs are at the top of `levels.js` in `TUNING`:

```js
const TUNING = {
  aimRadiusCm:        12.0,   // L1 tolerance
  aimHoldMs:          1200,
  centerRadiusCm:     2.5,    // L2 tolerance — looser/tighter for "snap" feel
  centerHoldMs:       1800,
  perpTiltDeg:        8.0,    // L3 — matches IFU "external cross completes"
  perpHoldMs:         1500,
  sidTargetCm:        60.0,
  sidToleranceCm:     5.0,
  sidHoldMs:          1500,
  ssdMinCm:           30.0,
  patientThicknessCm: 5.0,
  finalHoldMs:        1500,
};
```

Bump `holdMs` values up to make levels feel tougher. Tighten the
tolerances (radius, deg, cm) to make the snap feel sharper.

## Local development

```bash
cd mc2-trainer-v2
python3 -m http.server 8080
# then open http://localhost:8080 on the same machine
```

For phone testing without GitHub Pages, use a HTTPS tunnel:

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

## Architecture notes

- `app.js` is intentionally one file; logic is grouped by clearly-marked
  section dividers (camera / linear algebra / pose / render / tutorial /
  routing). Keeps the script-tag wiring trivial.
- The pose math (`detectQR`, `buildPose`, `buildLocalToScreen`,
  `applyCassetteTransform`) is a verbatim port from v1's `app.js` —
  same physics, same thresholds, same stability. If you change the math,
  diff against `../mc2-trainer/app.js`.
- Tutorial gating runs in `tickTutorial(dtMs)` once per RAF tick. Each
  level's `check(pose)` returns `{ pass, progress, reason }`. While
  `pass` is continuously true, `holdMs` accumulates; any frame with
  `pass=false` resets it and increments `driftCount` (used for stars).
- HUD layering is pure CSS: the viewfinder root gets `layer-aim`,
  `layer-center`, `layer-perp`, or `layer-sid`, each of which hides
  HUD elements past that lesson via grouped selectors in `styles.css`.
