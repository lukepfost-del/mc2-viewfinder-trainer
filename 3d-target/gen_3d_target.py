"""Generate dual-color 3D-printable QR/ArUco target tile.

Builds a 60mm x 60mm x 5mm tile:
  - Top face: OXOS logo + QR code (black-on-white)
  - Bottom face: ArUco marker (DICT_4X4_1000 ID 0)

Black features sit flush with the surface (recessed 0.6mm into the white
base), so the printed part is exactly 5mm thick. Two STL files are emitted
that share the same coordinate system; import both into your slicer and
assign each to a different filament for a clean dual-material print.
"""
import io, os, sys
import numpy as np
import cv2
from cv2 import aruco
import qrcode
import cairosvg
from PIL import Image
import trimesh
from shapely.geometry import Polygon, box, MultiPolygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.environ.get("ASSETS_DIR", os.path.join(HERE, "assets"))
OUT_DIR = os.environ.get("OUT_DIR", HERE)

LOGO_SVG = os.path.join(ASSETS_DIR, "oxos-logo.svg")
TRAINER_URL = "https://lukepfost-del.github.io/mc2-viewfinder-trainer/"

TILE_MM        = 80.0
THICKNESS_MM   = 5.0
FEATURE_DEPTH  = 0.6

LOGO_WIDTH_MM       = 32.0
LOGO_TOP_MARGIN_MM  = 6.0
QR_TARGET_SIZE_MM   = 38.0
QR_LOGO_GAP_MM      = 5.0

ARUCO_SIZE_MM   = 60.0   # marker stays 60mm to match the paper version; 10mm white border


def render_logo_mask(svg_path, target_height_px=1200):
    with open(svg_path, "r", encoding="utf-8") as f:
        svg_text = f.read()
    svg_text = svg_text.replace("#fff", "#000").replace("fill:#fff", "fill:#000")
    png_bytes = cairosvg.svg2png(bytestring=svg_text.encode("utf-8"),
                                 output_width=target_height_px)
    img = np.array(Image.open(io.BytesIO(png_bytes)).convert("RGBA"))
    alpha = img[:, :, 3]
    gray = img[:, :, :3].mean(axis=2)
    mask = ((alpha > 100) & (gray < 100)).astype(np.uint8)
    return mask


def mask_contours_to_mm_polygon(mask, mm_w, mm_h, x0, y0):
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP,
                                           cv2.CHAIN_APPROX_TC89_KCOS)
    if hierarchy is None:
        return None
    h_px, w_px = mask.shape
    polys = []
    h_arr = hierarchy[0]
    for i, cnt in enumerate(contours):
        if h_arr[i][3] != -1:
            continue
        outer_px = cnt[:, 0, :]
        if len(outer_px) < 3:
            continue
        holes_px = []
        child = h_arr[i][2]
        while child != -1:
            hpts = contours[child][:, 0, :]
            if len(hpts) >= 3:
                holes_px.append(hpts)
            child = h_arr[child][0]

        def to_mm(pts):
            xs = pts[:, 0].astype(float) / w_px * mm_w + x0
            ys = (h_px - pts[:, 1].astype(float)) / h_px * mm_h + y0
            return list(zip(xs.tolist(), ys.tolist()))

        try:
            p = Polygon(to_mm(outer_px), holes=[to_mm(h) for h in holes_px])
            if not p.is_valid:
                p = p.buffer(0)
            if p.is_empty or p.area <= 0:
                continue
            polys.append(p)
        except Exception as e:
            print(f"  contour skipped: {e}")
    if not polys:
        return None
    return unary_union(polys)


def matrix_to_polygon(matrix, module_mm, x0, y0):
    rows, cols = matrix.shape
    boxes = []
    for r in range(rows):
        for c in range(cols):
            if matrix[r, c]:
                x = x0 + c * module_mm
                y = y0 + (rows - 1 - r) * module_mm
                boxes.append(box(x, y, x + module_mm, y + module_mm))
    return unary_union(boxes) if boxes else None


def extrude_to_mesh(poly, height, z_base):
    if poly is None or poly.is_empty:
        return None
    geoms = poly.geoms if isinstance(poly, MultiPolygon) else [poly]
    pieces = []
    for g in geoms:
        if g.is_empty or g.area <= 0:
            continue
        m = trimesh.creation.extrude_polygon(g, height)
        m.apply_translation([0, 0, z_base])
        pieces.append(m)
    if not pieces:
        return None
    return trimesh.util.concatenate(pieces)


# ----- 1. Top face: QR + logo -----
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                   box_size=1, border=0)
qr.add_data(TRAINER_URL)
qr.make(fit=True)
qr_matrix_full = np.array(qr.get_matrix(), dtype=bool)
qr_modules = qr_matrix_full.shape[0]
qr_module_mm = QR_TARGET_SIZE_MM / qr_modules
qr_size_mm = qr_modules * qr_module_mm
print(f"QR: {qr_modules}x{qr_modules} modules, {qr_module_mm:.3f}mm/module -> {qr_size_mm:.2f}mm")

logo_mask = render_logo_mask(LOGO_SVG)
mh, mw = logo_mask.shape
logo_aspect = mh / mw
logo_height_mm = LOGO_WIDTH_MM * logo_aspect
print(f"Logo: {LOGO_WIDTH_MM:.2f} x {logo_height_mm:.2f} mm")

logo_y_top = TILE_MM - LOGO_TOP_MARGIN_MM
logo_y_bot = logo_y_top - logo_height_mm
logo_x_left = (TILE_MM - LOGO_WIDTH_MM) / 2

qr_y_top = logo_y_bot - QR_LOGO_GAP_MM
qr_y_bot = qr_y_top - qr_size_mm
qr_x_left = (TILE_MM - qr_size_mm) / 2

print(f"Logo box: x[{logo_x_left:.2f}-{logo_x_left+LOGO_WIDTH_MM:.2f}] y[{logo_y_bot:.2f}-{logo_y_top:.2f}]")
print(f"QR box:   x[{qr_x_left:.2f}-{qr_x_left+qr_size_mm:.2f}] y[{qr_y_bot:.2f}-{qr_y_top:.2f}]")
assert qr_y_bot > 1.0, f"QR overflows tile (y_bot={qr_y_bot})"

logo_poly = mask_contours_to_mm_polygon(logo_mask, LOGO_WIDTH_MM, logo_height_mm, logo_x_left, logo_y_bot)
qr_poly = matrix_to_polygon(qr_matrix_full, qr_module_mm, qr_x_left, qr_y_bot)

top_polys = [p for p in (logo_poly, qr_poly) if p is not None]
top_face_poly = unary_union(top_polys)
print(f"Top face black area = {top_face_poly.area:.1f} mm^2")

# ----- 2. Bottom face: ArUco -----
aruco_dict = aruco.getPredefinedDictionary(aruco.DICT_4X4_1000)
aruco_modules = 6
aruco_img = aruco.generateImageMarker(aruco_dict, 0, aruco_modules)
aruco_matrix = (aruco_img == 0)
# Mirror horizontally: when the user flips the printed tile to view the
# bottom (ArUco) face, the camera sees a left-right mirror of the polygon
# orientation. Pre-mirroring here makes the camera-view canonical.
aruco_matrix = aruco_matrix[:, ::-1]
aruco_size_mm = ARUCO_SIZE_MM
aruco_module_mm = aruco_size_mm / aruco_modules
aruco_x0 = (TILE_MM - aruco_size_mm) / 2
aruco_y0 = (TILE_MM - aruco_size_mm) / 2
print(f"ArUco: {aruco_modules}x{aruco_modules}, {aruco_module_mm:.2f}mm/module -> {aruco_size_mm:.2f}mm")

bottom_face_poly = matrix_to_polygon(aruco_matrix, aruco_module_mm, aruco_x0, aruco_y0)
print(f"Bottom face black area = {bottom_face_poly.area:.1f} mm^2")


# ----- 3. Build meshes -----
top_black = extrude_to_mesh(top_face_poly, FEATURE_DEPTH, THICKNESS_MM - FEATURE_DEPTH)
bot_black = extrude_to_mesh(bottom_face_poly, FEATURE_DEPTH, 0.0)
black_pieces = [m for m in (top_black, bot_black) if m is not None]
black_mesh = trimesh.util.concatenate(black_pieces)
print(f"Black mesh: {len(black_mesh.faces)} faces, {black_mesh.volume:.1f} mm^3")

tile_poly = box(0, 0, TILE_MM, TILE_MM)
top_white_poly = tile_poly.difference(top_face_poly)
bot_white_poly = tile_poly.difference(bottom_face_poly)

top_white_slab = extrude_to_mesh(top_white_poly, FEATURE_DEPTH, THICKNESS_MM - FEATURE_DEPTH)
bot_white_slab = extrude_to_mesh(bot_white_poly, FEATURE_DEPTH, 0.0)
core_height = THICKNESS_MM - 2 * FEATURE_DEPTH
core = trimesh.creation.box(extents=[TILE_MM, TILE_MM, core_height])
core.apply_translation([TILE_MM / 2, TILE_MM / 2, FEATURE_DEPTH + core_height / 2])
white_pieces = [m for m in (top_white_slab, core, bot_white_slab) if m is not None]
white_mesh = trimesh.util.concatenate(white_pieces)
print(f"White mesh: {len(white_mesh.faces)} faces, {white_mesh.volume:.1f} mm^3")

total = black_mesh.volume + white_mesh.volume
expected = TILE_MM * TILE_MM * THICKNESS_MM
print(f"Total volume: {total:.1f} mm^3 (expected {expected:.1f}, diff {total - expected:+.2f})")


# ----- 4. Export -----
white_path = os.path.join(OUT_DIR, "MC2_target_white.stl")
black_path = os.path.join(OUT_DIR, "MC2_target_black.stl")
combined_path = os.path.join(OUT_DIR, "MC2_target_combined.glb")
white_mesh.export(white_path)
black_mesh.export(black_path)

try:
    wp = white_mesh.copy()
    wp.visual.vertex_colors = np.tile(np.array([240, 240, 240, 255], dtype=np.uint8), (len(wp.vertices), 1))
    bp = black_mesh.copy()
    bp.visual.vertex_colors = np.tile(np.array([25, 25, 25, 255], dtype=np.uint8), (len(bp.vertices), 1))
    trimesh.Scene([wp, bp]).export(combined_path)
except Exception as e:
    print(f"(GLB preview skipped: {e})")

print(f"\nWrote: {white_path}")
print(f"Wrote: {black_path}")
print(f"Wrote: {combined_path}")
