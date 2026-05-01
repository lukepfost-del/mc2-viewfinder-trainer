# MC2 Trainer 3D-Printed Target

Dual-color, double-sided 3D-printable replacement for the paper QR/ArUco
target. 60 mm × 60 mm × 5 mm, exact-fit two-color geometry.

## Files

| File | Purpose |
| --- | --- |
| `MC2_target_white.stl` | Tile body — print in white |
| `MC2_target_black.stl` | QR + logo + ArUco features — print in black |
| `MC2_target_combined.glb` | Tinted preview of both parts together (visual sanity, not for printing) |
| `preview_top.png` | What the QR side looks like |
| `preview_bottom.png` | What the ArUco side looks like (camera-perspective) |
| `gen_3d_target.py` | Source script to regenerate everything |

## Geometry

- **Top face** — OXOS logo at top, QR code below. Decodes as `https://lukepfost-del.github.io/mc2-viewfinder-trainer/v2/`.
- **Bottom face** — ArUco DICT_4X4_1000 ID 0, filling the full 60 mm to match the paper version's marker size (so the trainer's pose math doesn't change).
- Black features are recessed 0.6 mm into each face, ending flush with the surface. Total tile thickness is exactly 5.0 mm.
- ArUco is pre-mirrored so the camera, looking at the bottom face directly, sees the canonical ID 0 pattern.

## Slicing (Bambu / Prusa MMU / dual-extruder)

1. Import `MC2_target_white.stl` and `MC2_target_black.stl` together.
2. Keep their origins aligned (most slicers do this automatically when you import both at once).
3. Assign each STL to a different filament — white plastic for the body, black for the features.
4. Suggested settings: 0.2 mm layer height, 3 perimeters, 15% infill. Layer height ≤ 0.3 mm so the 0.6 mm feature depth gets at least 2 layers of contrasting color.
5. Build orientation: ArUco-side down on the bed gives the cleanest detail on the side that needs the highest readability; QR-side down also works. Use brim if needed.

## Single-color fallback (no MMU)

If you don't have a multi-material printer, you can still use the paper PDF (`../qr-target.pdf`) — the 3D version's selling point is the dual color. With a single-color printer, the QR/ArUco features won't be visually distinct from the body and won't scan.

## Quiet-zone note

The ArUco fills the full tile, so detection requires a light surface around the tile (the paper version's white margin came from the paper itself). Place the tile on a plain light-colored surface for reliable detection. If you'd rather have the quiet zone built in, edit `gen_3d_target.py` and set `ARUCO_FILL_TILE = False` (gives a 50 mm marker on a 60 mm tile with 5 mm white border) — but you'll then need to update the trainer's marker size from 6 cm to 5 cm.

## Regeneration

```sh
cd 3d-target
ASSETS_DIR=../assets python3 gen_3d_target.py
```
