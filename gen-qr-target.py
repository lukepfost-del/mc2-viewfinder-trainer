"""Generate qr-target.pdf with a 5 cm ArUco DICT_4X4_1000 ID 0 marker on letter paper."""
import cv2
import cv2.aruco as aruco
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import cm, mm
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import black, gray, red
from PIL import Image
import io, os

OUT = "qr-target.pdf"
PNG_OUT = "qr-target.png"
MARKER_CM = 5.0
ACTIVE_AREA_CM = 21.35   # cassette active area edge length (matches SETTINGS.activeAreaCm)

# 1. Generate ArUco marker bitmap
dictionary = aruco.getPredefinedDictionary(aruco.DICT_4X4_1000)
img_size_px = 600
marker_img = aruco.generateImageMarker(dictionary, 0, img_size_px)
# Save the raw PNG as well (handy reference)
cv2.imwrite(PNG_OUT, marker_img)

pil = Image.fromarray(marker_img).convert("RGB")
buf = io.BytesIO()
pil.save(buf, format="PNG")
buf.seek(0)

# 2. Build the PDF
W, H = LETTER  # in points (1 pt = 1/72 inch)
c = canvas.Canvas(OUT, pagesize=LETTER)

# Title
c.setFont("Helvetica-Bold", 16)
c.drawCentredString(W/2, H - 1.2*cm, "MC2 Viewfinder Trainer — 5 cm QR Target")
c.setFont("Helvetica", 10)
c.drawCentredString(W/2, H - 1.7*cm, "Print at 100% scale (NOT 'fit to page'). Verify rulers below with a real ruler.")

# Place the marker centered horizontally, top half of page
marker_size_pt = MARKER_CM * cm
mx = (W - marker_size_pt) / 2
my = H - 8.5 * cm
c.drawImage(ImageReader(io.BytesIO(buf.getvalue())), mx, my, marker_size_pt, marker_size_pt,
            preserveAspectRatio=True, mask='auto')
# Crop ticks at the marker corners so it's obvious where the marker boundary is
c.setStrokeColor(red)
c.setLineWidth(0.8)
tick = 0.4 * cm
for x, y in [(mx, my), (mx+marker_size_pt, my), (mx, my+marker_size_pt), (mx+marker_size_pt, my+marker_size_pt)]:
    c.line(x - tick, y, x + tick, y)
    c.line(x, y - tick, x, y + tick)

# Label marker size
c.setStrokeColor(black)
c.setFont("Helvetica-Bold", 11)
c.drawCentredString(W/2, my - 0.55*cm, f"{MARKER_CM:.0f} cm × {MARKER_CM:.0f} cm marker")

# 3. Calibration ruler — 5 cm horizontal, below the marker
ruler_w = MARKER_CM * cm
ruler_x = (W - ruler_w) / 2
ruler_y = my - 2.2*cm
c.setLineWidth(1.2)
c.line(ruler_x, ruler_y, ruler_x + ruler_w, ruler_y)
# 1 cm major ticks
for i in range(int(MARKER_CM) + 1):
    x = ruler_x + i*cm
    c.line(x, ruler_y - 0.15*cm, x, ruler_y + 0.15*cm)
    c.setFont("Helvetica", 8)
    c.drawCentredString(x, ruler_y - 0.45*cm, str(i))
c.setFont("Helvetica", 9)
c.drawCentredString(W/2, ruler_y + 0.45*cm, f"verify ruler is {MARKER_CM:.0f} cm")

# 4. Active-area outline — dashed square representing cassette imaging area.
# Letter paper is ~21.59 cm wide, active area 21.35 cm — just barely fits.
aa_pt = ACTIVE_AREA_CM * cm
aa_x = (W - aa_pt) / 2
aa_y = my + (marker_size_pt - aa_pt) / 2   # vertically center on the marker
c.setStrokeColor(gray)
c.setDash(4, 4)
c.setLineWidth(1)
c.rect(aa_x, aa_y, aa_pt, aa_pt, stroke=1, fill=0)
c.setDash()
c.setStrokeColor(black)
c.setFont("Helvetica", 8)
c.setFillColor(gray)
c.drawString(aa_x + 0.1*cm, aa_y + aa_pt + 0.1*cm,
             f"Cassette active area ({ACTIVE_AREA_CM:.2f} cm)")
c.setFillColor(black)

# 5. Footer with instructions
y_foot = 2.5*cm
c.setFont("Helvetica-Bold", 11)
c.drawCentredString(W/2, y_foot + 1.0*cm, "How to use")
c.setFont("Helvetica", 9.5)
c.drawCentredString(W/2, y_foot + 0.4*cm,
    "Lay this sheet flat. Open the trainer on your phone. Point camera at the marker.")
c.drawCentredString(W/2, y_foot - 0.05*cm,
    "Trainer expects exactly a 5 cm marker — make sure your printer didn't shrink the page.")

c.showPage()
c.save()

print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")
print(f"wrote {PNG_OUT} ({os.path.getsize(PNG_OUT)} bytes)")
