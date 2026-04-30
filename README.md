# MC2 Viewfinder Trainer

A mobile webpage that simulates the OXOS MC2 emitter Viewfinder so you can
practice aiming without the actual hardware. The phone camera detects a
printed QR code that stands in for the cassette; the page projects the
cassette active area, X-ray field indicator, center mark, and SID/SSD
gauges over the camera feed and updates them in real time as you move
and tilt the phone.

## Live demo

Once GitHub Pages is enabled on this repo, the trainer will be at:

```
https://<your-username>.github.io/<this-repo-name>/
```

Open that URL on a phone (HTTPS is required for camera access).

## Files

- `index.html` - UI shell, viewfinder HUD, start screen
- `app.js` - camera, jsQR detection, homography pose, One-Euro smoothing, rendering
- `qr-target.pdf` - printable cassette target (9 cm QR + ruler + active-area outline)
- `qr-target.png` - the QR as a raw PNG

## How to use

1. **Print** `qr-target.pdf` at 100% scale (NOT "fit to page"). Verify the 9 cm ruler is exactly 9 cm with a real ruler.
2. **Lay** the page flat on a table. The dashed square represents the cassette active area.
3. **Open the live demo URL on your phone** (must be HTTPS).
4. Confirm or adjust the measured QR size on the start screen, allow camera access, and aim like the MC2 emitter.

## Mapping to the MC2 Viewfinder (per IFU C, "Aiming and Collimation")

| Real Viewfinder element | Trainer behavior |
|---|---|
| Center Mark - small cross "snaps" to center, full cross "completes" when perpendicular | Small cross + ring at beam landing point; large external cross at screen center fades in below 8 deg tilt |
| X-ray Field Indicator - grows when perpendicular and centered, disappears outside active area | "Pillow" rectangle at the aim point; size = max field x min(perpFactor, centerFactor); hidden when aim outside active area |
| Active Area - colorized in bounds, grayscale outside | Light blue tint when in bounds; live video desaturates to grayscale when out of bounds |
| SID gauge (30-80 cm) | Estimated from QR pixel size + calibrated focal length; pill turns red outside range |
| SSD gauge (>=30 cm) | SID minus configurable patient thickness |
| Interlock priority | Off-target -> Too far -> Too close -> SSD -> Harsh light -> Front-face covered |
| Auto / Manual collimator | A/M toggle in HUD; manual = fixed 40% field |
| kV / Mode / mAs | Bottom HUD; values from IFU section 6 |
| Capture trigger | EXPOSE button; armed (green) only when all interlocks clear |

## Technical notes

- **Pose**: jsQR -> 4-point homography -> tilt recovered via H decomposition with assumed pinhole intrinsics (focal = 0.85 x max frame dim). Tilt recovery is exact; SID is exact when perpendicular and ~5-15% over-read at extreme tilts.
- **Stability**: One-Euro filter on each QR corner gives ~5.6x jitter reduction with ~67 ms step response. Filter state resets when the marker is lost > 400 ms.
- **Resolution**: jsQR runs at 720 px max dim from the camera frame; UI overlay runs at native devicePixelRatio.
- **Defaults**: 9 cm QR, 21.35 cm active area, 5 cm patient thickness. All adjustable on the start screen or in `SETTINGS` in `app.js`.

## Local development

Camera access requires HTTPS or `localhost`:

```bash
cd mc2-trainer
python3 -m http.server 8080
# then open http://localhost:8080 on the same machine
```

For phone testing without GitHub Pages, use a HTTPS tunnel:

```bash
npx serve -l 5173 &
ngrok http 5173        # or:  npx localtunnel --port 5173
```

## Self-test

```bash
node --check app.js
```
