"""Generate qr-target.pdf — clean printable target for the trainer.

Layout (letter portrait, top → bottom):
  - OXOS logo at top, with clearance equal to its own height all around.
  - Title + subtitle
  - ArUco marker dead-centered on the page
  - "How to use" + access QR pinned to the bottom
  - Footer credit line
"""
import io, os
import cv2
import cv2.aruco as aruco
import qrcode
import cairosvg
from PIL import Image
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import cm
from reportlab.lib.colors import black, HexColor
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

OUT      = "qr-target.pdf"
PNG_OUT  = "qr-target.png"
LOGO_SVG = "assets/oxos-logo.svg"
TRAINER_URL = "https://lukepfost-del.github.io/mc2-viewfinder-trainer/"
MARKER_CM = 6.0

# ArUco marker
dictionary = aruco.getPredefinedDictionary(aruco.DICT_4X4_1000)
marker_img = aruco.generateImageMarker(dictionary, 0, 720)
cv2.imwrite(PNG_OUT, marker_img)
marker_pil = Image.fromarray(marker_img).convert("RGB")
marker_buf = io.BytesIO()
marker_pil.save(marker_buf, format="PNG")
marker_buf.seek(0)

# OXOS logo (white SVG -> black PNG for print)
with open(LOGO_SVG, "r", encoding="utf-8") as f:
    svg_text = f.read()
svg_text = svg_text.replace("#fff", "#000").replace("fill:#fff", "fill:#000")
logo_png_bytes = cairosvg.svg2png(bytestring=svg_text.encode("utf-8"), output_width=900)

# Access QR
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
qr.add_data(TRAINER_URL)
qr.make(fit=True)
qr_pil = qr.make_image(fill_color="black", back_color="white").convert("RGB")
qr_buf = io.BytesIO()
qr_pil.save(qr_buf, format="PNG")
qr_buf.seek(0)

# PDF
W, H = LETTER
c = canvas.Canvas(OUT, pagesize=LETTER)

# ---- Logo, top-centered with logo-height clearance on all sides ----
logo_w  = 4.4 * cm
logo_h  = logo_w * (101.25 / 464.07)
clear_v = logo_h            # vertical breathing room == logo height
clear_h = logo_h            # horizontal breathing room == logo height
logo_x  = (W - logo_w) / 2
logo_y  = H - clear_v - logo_h
c.drawImage(ImageReader(io.BytesIO(logo_png_bytes)),
            logo_x, logo_y, logo_w, logo_h,
            preserveAspectRatio=True, mask='auto')

# Title sits below the logo's lower clearance bubble
title_y = logo_y - clear_v - 0.55 * cm
c.setFillColor(black)
c.setFont("Helvetica-Bold", 18)
c.drawCentredString(W / 2, title_y, "MC2 Viewfinder Trainer")
c.setFont("Helvetica", 10.5)
c.setFillColor(HexColor("#555555"))
c.drawCentredString(W / 2, title_y - 0.55 * cm,
                    "Practice aiming the MC2 emitter with your phone.")

# ---- Marker dead-centered on page ----
marker_pt = MARKER_CM * cm
mx = (W - marker_pt) / 2
my = (H - marker_pt) / 2
c.setFillColor(black)
c.drawImage(ImageReader(marker_buf), mx, my, marker_pt, marker_pt,
            preserveAspectRatio=True, mask='auto')

# ---- Bottom block: instructions on left, access QR on right ----
# Anchor the block near the bottom of the page, just above the footer credits.
bottom_block_top = 6.2 * cm

qr_size = 3.2 * cm
qr_x = W - 2.5 * cm - qr_size
qr_y = bottom_block_top - qr_size
c.drawImage(ImageReader(qr_buf), qr_x, qr_y, qr_size, qr_size,
            preserveAspectRatio=True, mask='auto')
c.setFont("Helvetica-Bold", 9)
c.setFillColor(black)
c.drawCentredString(qr_x + qr_size / 2, qr_y - 0.45 * cm, "Open the trainer")
c.setFont("Helvetica", 8)
c.setFillColor(HexColor("#666666"))
c.drawCentredString(qr_x + qr_size / 2, qr_y - 0.85 * cm, "(scan with your phone)")

inst_x = 2.5 * cm
inst_y = bottom_block_top - 0.2 * cm
c.setFillColor(black)
c.setFont("Helvetica-Bold", 12)
c.drawString(inst_x, inst_y, "How to use")
c.setFont("Helvetica", 10.5)
c.setFillColor(HexColor("#333333"))
lines = [
    "1.  Lay this page flat on a table.",
    "2.  Open the trainer (scan the QR on the right).",
    "3.  Allow camera access when prompted.",
    "4.  Point your phone at the marker like the MC2 emitter.",
    "5.  Tap Tutorial to learn, or Play to free-practice.",
]
for i, ln in enumerate(lines):
    c.drawString(inst_x, inst_y - 0.7 * cm - i * 0.55 * cm, ln)

# ---- Footer credits, anchored at very bottom ----
c.setFont("Helvetica", 8)
c.setFillColor(HexColor("#888888"))
c.drawCentredString(W / 2, 1.6 * cm,
    "ArUco DICT_4X4_1000 ID 0  -  marker " + str(int(MARKER_CM)) + " cm x " + str(int(MARKER_CM)) + " cm")
c.setFont("Helvetica-Bold", 8.5)
c.setFillColor(HexColor("#444444"))
c.drawCentredString(W / 2, 1.0 * cm,
    "Built by the Advanced Concepts team  -  OXOS Medical")

c.showPage()
c.save()

print("wrote", OUT, os.path.getsize(OUT), "bytes")
print("wrote", PNG_OUT, os.path.getsize(PNG_OUT), "bytes")
