#!/usr/bin/env python3
"""
Flatten Figma "outside-mask" outline SVGs into plain stroked paths.

How Figma exports an outline drawing:

    <mask id="path-1-outside-N" fill="black">
      <rect fill="white" .../>
      <path d="<SILHOUETTE>"/>   <-- the actual finger / hand / etc. shape
    </mask>
    <path d="<EXPANDED_STROKE_GEOMETRY>"
          mask="url(#path-1-outside-N)" fill="brand"/>

The OUTER path's d is a 30-50 KB precomputed "expanded stroke" geometry that
only renders meaningfully when filled AND masked.  Stripping the mask and
filling the outer path produces a giant blob; stroking it with fill=none
produces nonsense (it traces stroke-extension polygons).

The INNER mask path's d is the actual silhouette (~2-3 KB) — a normal SVG
path you can stroke.

Fix:
  - Extract the silhouette path from inside each <mask id="path-1-outside-N">
  - Emit it as a plain `<path d="…" fill="none" stroke="brand" stroke-width=…/>`
  - Remove the original <mask> block AND the outer <path mask="url(#path-1-outside-N)" .../>
  - Also strip <filter> blocks and filter= refs (drop-shadow defs)

Usage:
  python3 flatten-anatomy-svgs.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent / "assets" / "exams"
BRAND = "#595CFF"
OUTLINE_STROKE_W = 5

# Match a complete <mask id="path-1-outside-N" ...>...</mask> block.
# We extract the inner silhouette path's d="..." inside.
MASK_BLOCK_RE = re.compile(
    r'<mask\s+id="(path-\d+-outside-[^"]+)"[^>]*>([\s\S]*?)</mask>',
    re.IGNORECASE,
)
# The silhouette path inside the mask (no fill/stroke attrs, just d).
INNER_PATH_RE = re.compile(r'<path\s+d="([^"]+)"\s*/>', re.IGNORECASE)
# The outer path that uses mask="url(#path-1-outside-N)" — we strip this.
OUTER_MASKED_PATH_RE = re.compile(
    r'<path\b[^>]*?\bmask="url\(#(path-\d+-outside-[^)]+)\)"[^>]*?/>',
    re.IGNORECASE,
)
# Other Figma decoration: filter defs and filter= refs
FILTER_BLOCK_RE = re.compile(r"<filter\b[\s\S]*?</filter>", re.IGNORECASE)
FILTER_ATTR_RE = re.compile(r'\sfilter="url\(#[^"]*\)"', re.IGNORECASE)


def _silhouette_replacer(text: str):
    """Return (silhouettes_dict, replacer_fn) for outside-mask paths."""
    silhouettes: dict[str, str] = {}
    for m in MASK_BLOCK_RE.finditer(text):
        mask_id = m.group(1)
        inner_path = INNER_PATH_RE.search(m.group(2))
        if inner_path:
            silhouettes[mask_id] = inner_path.group(1)
    def replace_outer(match):
        outer = match.group(0)
        id_m = re.search(r'mask="url\(#(path-\d+-outside-[^)]+)\)"', outer)
        if not id_m:
            return outer
        mask_id = id_m.group(1)
        d = silhouettes.get(mask_id)
        if not d:
            return ""
        return (
            f'<path d="{d}" fill="none" stroke="{BRAND}" '
            f'stroke-width="{OUTLINE_STROKE_W}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
        )
    return silhouettes, replace_outer


def flatten_svg(text: str) -> str:
    """Aggressive: anatomy-only.  Strip everything that isn't needed for
    the stroke outline (filters, white silhouettes, clip-paths, masks)."""
    _, replace_outer = _silhouette_replacer(text)
    text = FILTER_BLOCK_RE.sub("", text)
    text = FILTER_ATTR_RE.sub("", text)
    text = OUTER_MASKED_PATH_RE.sub(replace_outer, text)
    text = MASK_BLOCK_RE.sub("", text)
    # Strip the background white silhouette (it duplicates the outline shape
    # on standalone anatomy files; on a white cassette background it's
    # invisible, on dark it looks like a sticker).
    text = re.sub(r'<path\b[^>]*?fill="white"[^>]*?/>', "", text, flags=re.IGNORECASE)
    # Strip clip-path wrappers + defs — fragile across renderers.
    text = re.sub(r'\sclip-path="url\(#[^"]*\)"', "", text, flags=re.IGNORECASE)
    text = re.sub(r"<clipPath\b[\s\S]*?</clipPath>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<defs>\s*</defs>", "", text, flags=re.IGNORECASE)
    return text


def derive_positioned_anatomy(cassette_text: str) -> str:
    """Take cassette-a.svg and produce an anatomy-only SVG that keeps the
    cassette's viewBox.

    Strategy:
      - Identify the cassette mask: it's the mask with the SMALLEST
        numeric prefix (Figma assigns these in drawing order, and the
        cassette is always drawn first).
      - DROP the cassette mask block AND its outer-masked path entirely.
      - For any other masks (anatomy outline in some exam styles),
        convert their outer path to a brand-stroked silhouette.
      - Keep ALL <path> elements whose fill OR stroke uses the brand
        color (this captures both the fill-style anatomy and the
        silhouette-converted anatomy).
    """
    text = cassette_text
    # 1) Find all mask IDs with their numeric prefix.  The smallest = cassette.
    mask_re = re.compile(r'<mask\s+id="(path-(\d+)-outside-[^"]+)"', re.IGNORECASE)
    all_masks = [(int(m.group(2)), m.group(1)) for m in mask_re.finditer(text)]
    cassette_mask_id = min(all_masks)[1] if all_masks else None
    # 2) Build silhouettes for OTHER masks (anatomy when in mask form).
    silhouettes = {}
    for m in MASK_BLOCK_RE.finditer(text):
        mid = m.group(1)
        if mid == cassette_mask_id:
            continue  # skip the cassette mask
        inner_path = INNER_PATH_RE.search(m.group(2))
        if inner_path:
            silhouettes[mid] = inner_path.group(1)
    # 3) Replace outer-masked paths: cassette → drop, anatomy → silhouette.
    def replace_outer(match):
        outer = match.group(0)
        id_m = re.search(r'mask="url\(#([^)]+)\)"', outer)
        if not id_m: return ""
        mid = id_m.group(1)
        if mid == cassette_mask_id:
            return ""  # drop the cassette outline path
        d = silhouettes.get(mid)
        if not d: return ""
        return (
            f'<path d="{d}" fill="none" stroke="{BRAND}" '
            f'stroke-width="{OUTLINE_STROKE_W}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
        )
    text = OUTER_MASKED_PATH_RE.sub(replace_outer, text)
    text = MASK_BLOCK_RE.sub("", text)
    # 4) Get root <svg> tag, keep <path>s with brand color (fill or stroke).
    root_match = re.search(r'<svg\b[^>]*>', text)
    if not root_match:
        return text
    svg_open = root_match.group(0)
    brand_lc = BRAND.lower()
    kept = []
    for m in re.finditer(r'<path\b[^>]*?/>', text):
        elem = m.group(0)
        if re.search(r'(fill|stroke)="' + re.escape(brand_lc) + r'"', elem, re.IGNORECASE):
            kept.append(elem)
    body = "\n".join(kept)
    return svg_open + "\n" + body + "\n</svg>\n"


def flatten_cassette_svg(text: str) -> str:
    """Conservative: cassette+anatomy combined.  Replace each outside-mask
    with a stroked silhouette.  v28.9: the cassette mask (smallest path-N
    number = drawn first by Figma) gets stroked BLACK; all other masks
    (anatomy) keep the brand-blue stroke.
    v28.11: ALSO strip Figma filter blocks/refs (drop-shadow defs) — they
    cause iOS rasterization blur (see v25.0 fix for anatomy.svg).
    """
    # Strip filters first — same as flatten_svg does for anatomy files.
    text = FILTER_BLOCK_RE.sub("", text)
    text = FILTER_ATTR_RE.sub("", text)
    # Identify the cassette mask: smallest path-N number.
    mask_re = re.compile(r'<mask\s+id="(path-(\d+)-outside-[^"]+)"', re.IGNORECASE)
    all_masks = [(int(m.group(2)), m.group(1)) for m in mask_re.finditer(text)]
    cassette_mask_id = min(all_masks)[1] if all_masks else None
    # Build silhouette table.
    silhouettes = {}
    for m in MASK_BLOCK_RE.finditer(text):
        mid = m.group(1)
        inner_path = INNER_PATH_RE.search(m.group(2))
        if inner_path:
            silhouettes[mid] = inner_path.group(1)
    # Replace outer-masked paths: cassette → black stroke, anatomy → brand.
    def replace_outer(match):
        outer = match.group(0)
        id_m = re.search(r'mask="url\(#([^)]+)\)"', outer)
        if not id_m:
            return outer
        mid = id_m.group(1)
        d = silhouettes.get(mid)
        if not d:
            return ""
        color = "#000000" if mid == cassette_mask_id else BRAND
        return (
            f'<path d="{d}" fill="none" stroke="{color}" '
            f'stroke-width="{OUTLINE_STROKE_W}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
        )
    text = OUTER_MASKED_PATH_RE.sub(replace_outer, text)
    text = MASK_BLOCK_RE.sub("", text)
    return text



# Section dir mapping: assets/exams subdir → Exam Assets section folder
EXAM_SECTIONS = {
    "hands-fingers": "Hands & Fingers",
    "wrist-elbow": "Wrist & Elbow",
    "arm-shoulder": "Arm & Shoulder",
    "feet-toes": "Feet & Toes",
    "ankle-leg-knee": "Ankle, Leg & Knee",
}


def _find_exam_assets_source(svg: Path):
    """Given a path to an assets/exams/<section>/<exam>/cassette-{a,b}.svg,
    locate the corresponding source SVG inside Exam Assets/.  Returns the
    Path or None if no match."""
    try:
        section_id = svg.parent.parent.name
        exam_id    = svg.parent.name
        letter     = svg.stem.split("-")[-1]  # "a" or "b"
        section_label = EXAM_SECTIONS.get(section_id)
        if not section_label:
            return None
        # Walk Exam Assets/Positioning Assets/<Section>/<exam>/Anatomy + Cassette/
        exam_assets_root = Path(__file__).parent / "Exam Assets" / "Positioning Assets" / section_label
        if not exam_assets_root.is_dir():
            return None
        for ed in exam_assets_root.iterdir():
            if not ed.is_dir():
                continue
            # match exam folder by slug
            slug = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-",
                ed.name.lower().replace("\'", "").replace('"', "")))
            if slug != exam_id:
                continue
            ac_dir = ed / "Anatomy + Cassette"
            if not ac_dir.is_dir():
                continue
            svgs = sorted([f for f in ac_dir.iterdir() if f.suffix.lower() == ".svg"])
            idx = "ab".index(letter) if letter in "ab" else 0
            if idx < len(svgs):
                return svgs[idx]
        return None
    except Exception:
        return None


def main() -> int:
    if not ROOT.is_dir():
        print(f"ERROR: assets/exams/ not found at {ROOT}", file=sys.stderr)
        return 1
    processed = 0
    skipped = 0
    targets = sorted(list(ROOT.rglob("anatomy.svg"))
                     + list(ROOT.rglob("cassette-a.svg"))
                     + list(ROOT.rglob("cassette-b.svg")))
    for svg in targets:
        bak = svg.with_suffix(".svg.bak")
        # For cassette-{a,b}.svg, read the canonical source directly from
        # Exam Assets/ — the .bak shadow on the Windows mount is unreliable.
        original = None
        if svg.name.startswith("cassette"):
            src = _find_exam_assets_source(svg)
            if src and src.is_file():
                try:
                    original = src.read_text(encoding="utf-8")
                except OSError:
                    original = None
        # Otherwise use .bak if readable, else current svg content.
        if original is None and bak.exists():
            try:
                original = bak.read_text(encoding="utf-8")
            except (OSError, FileNotFoundError):
                original = None
        if original is None:
            original = svg.read_text(encoding="utf-8")
        # Anatomy gets the aggressive flatten; cassette+anatomy combined files
        # get the conservative flatten (preserves cassette outline + plate).
        if svg.name.startswith("cassette"):
            flat = flatten_cassette_svg(original)
        else:
            flat = flatten_svg(original)
        if not bak.exists():
            bak.write_text(original, encoding="utf-8")
        if flat != svg.read_text(encoding="utf-8"):
            svg.write_text(flat, encoding="utf-8")
            print(f"  flattened: {svg.relative_to(ROOT)}")
            processed += 1
        else:
            print(f"  unchanged: {svg.relative_to(ROOT)}")
            skipped += 1
            # v28: from each cassette-a.svg, derive the positioned anatomy and
        # overwrite the sibling anatomy.svg.
        if svg.name == "cassette-a.svg":
            positioned = derive_positioned_anatomy(original)
            anatomy_target = svg.parent / "anatomy.svg"
            if not anatomy_target.with_suffix(".svg.bak").exists() and anatomy_target.exists():
                try:
                    anatomy_target.with_suffix(".svg.bak").write_text(
                        anatomy_target.read_text(encoding="utf-8"), encoding="utf-8")
                except OSError:
                                        pass
            anatomy_target.write_text(positioned, encoding="utf-8")
            print(f"  derived positioned anatomy: {anatomy_target.relative_to(ROOT)}")
    print(f"\nDone. {processed} flattened, {skipped} unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
sette-a.svg, derive the positioned anatomy and
        # overwrite the sibling anatomy.svg.  This makes the HUD's anatomy
        # overlay inherit the cassette-a's viewBox (so it can be transformed
        # using the per-exam cassetteMeta to match the preview position).
        if svg.name == "cassette-a.svg":
            positioned = derive_positioned_anatomy(original)
            anatomy_target = svg.parent / "anatomy.svg"
            if not anatomy_target.with_suffix(".svg.bak").exists() and anatomy_target.exists():
                # snapshot the original standalone anatomy as bak before we overwrite
                try:
                    anatomy_target.with_suffix(".svg.bak").write_text(
                        anatomy_target.read_text(encoding="utf-8"), encoding="utf-8")
                except OSError:
                    pass
            anatomy_target.write_text(positioned, encoding="utf-8")
            print(f"  derived positioned anatomy: {anatomy_target.relative_to(ROOT)}")
    print(f"\nDone. {processed} flattened, {skipped} unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
