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
    """Take a conservatively-flattened cassette-a.svg and produce an anatomy-
    only SVG that keeps the cassette's viewBox.  The anatomy in the result
    is positioned exactly where it was relative to the cassette in Figma,
    so the HUD can overlay it on top of the photo cassette using the
    per-exam cassetteMeta (vbW/H + activeCx/Cy/Frac)."""
    text = cassette_text
    # 1) Replace outside-mask anatomy paths with stroked silhouettes
    #    (in case caller passed the raw original).
    _, replace_outer = _silhouette_replacer(text)
    text = OUTER_MASKED_PATH_RE.sub(replace_outer, text)
    text = MASK_BLOCK_RE.sub("", text)
    # 2) Strip all white-fill paths (the cassette outline) and white-fill rects
    #    (the active-area inner rect + handle bumpers).
    text = re.sub(r'<path\b[^>]*?fill="white"[^>]*?/>', "", text, flags=re.IGNORECASE)
    text = re.sub(r'<rect\b[^>]*?fill="white"[^>]*?/?>', "", text, flags=re.IGNORECASE)
    # 3) Strip filter blocks, filter attrs (drop shadows), and clip-paths.
    text = FILTER_BLOCK_RE.sub("", text)
    text = FILTER_ATTR_RE.sub("", text)
    text = re.sub(r'\sclip-path="url\(#[^"]*\)"', "", text, flags=re.IGNORECASE)
    text = re.sub(r"<clipPath\b[\s\S]*?</clipPath>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<defs>\s*</defs>", "", text, flags=re.IGNORECASE)
    return text


def flatten_cassette_svg(text: str) -> str:
    """Conservative: cassette+anatomy combined.  Only replace the anatomy
    outside-mask path with a stroked silhouette; leave the cassette
    outline (white fills, clip-paths) entirely intact."""
    _, replace_outer = _silhouette_replacer(text)
    text = OUTER_MASKED_PATH_RE.sub(replace_outer, text)
    text = MASK_BLOCK_RE.sub("", text)
    return text


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
        # Always re-process from the backup if it exists, so re-runs are idempotent.
        # Guard against Windows-mount ghost entries where bak.exists() is True
        # but the file is unreadable.
        original = None
        if bak.exists():
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
