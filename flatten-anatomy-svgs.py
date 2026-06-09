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
    r'<mask\s+id="(path-1-outside-[^"]+)"[^>]*>([\s\S]*?)</mask>',
    re.IGNORECASE,
)
# The silhouette path inside the mask (no fill/stroke attrs, just d).
INNER_PATH_RE = re.compile(r'<path\s+d="([^"]+)"\s*/>', re.IGNORECASE)
# The outer path that uses mask="url(#path-1-outside-N)" — we strip this.
OUTER_MASKED_PATH_RE = re.compile(
    r'<path\b[^>]*?\bmask="url\(#(path-1-outside-[^)]+)\)"[^>]*?/>',
    re.IGNORECASE,
)
# Other Figma decoration: filter defs and filter= refs
FILTER_BLOCK_RE = re.compile(r"<filter\b[\s\S]*?</filter>", re.IGNORECASE)
FILTER_ATTR_RE = re.compile(r'\sfilter="url\(#[^"]*\)"', re.IGNORECASE)


def flatten_svg(text: str) -> str:
    # 1) Pull every outside-mask's silhouette d into a registry.
    silhouettes: dict[str, str] = {}
    for m in MASK_BLOCK_RE.finditer(text):
        mask_id = m.group(1)
        inner = m.group(2)
        inner_path = INNER_PATH_RE.search(inner)
        if inner_path:
            silhouettes[mask_id] = inner_path.group(1)

    # 2) Build the replacement path for each outer-masked path.
    def replace_outer(match):
        outer = match.group(0)
        id_m = re.search(r'mask="url\(#(path-1-outside-[^)]+)\)"', outer)
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

    # 3) Apply transforms.
    text = FILTER_BLOCK_RE.sub("", text)
    text = FILTER_ATTR_RE.sub("", text)
    text = OUTER_MASKED_PATH_RE.sub(replace_outer, text)
    text = MASK_BLOCK_RE.sub("", text)

    # 4) Also remove the "background white silhouette" path that Figma emits
    #    alongside the outline mask — it's drawn before the outline as a
    #    filled white shape, but on a white-cassette background it's
    #    invisible, and on dark it makes the anatomy look like a paste-on
    #    sticker.  Identify it as any <path fill="white" .../>.
    text = re.sub(r'<path\b[^>]*?fill="white"[^>]*?/>', "", text, flags=re.IGNORECASE)

    # 5) Strip clip-path wrappers + clipPath defs — they vary by renderer
    #    (ImageMagick + some Safari versions) and aren't needed here.
    text = re.sub(r'\sclip-path="url\(#[^"]*\)"', "", text, flags=re.IGNORECASE)
    text = re.sub(r"<clipPath\b[\s\S]*?</clipPath>", "", text, flags=re.IGNORECASE)
    # If <defs> is now empty, drop it for tidiness.
    text = re.sub(r"<defs>\s*</defs>", "", text, flags=re.IGNORECASE)

    return text


def main() -> int:
    if not ROOT.is_dir():
        print(f"ERROR: assets/exams/ not found at {ROOT}", file=sys.stderr)
        return 1
    processed = 0
    skipped = 0
    for svg in sorted(ROOT.rglob("anatomy.svg")):
        bak = svg.with_suffix(".svg.bak")
        # Always re-process from the backup if it exists, so re-runs are idempotent.
        source_path = bak if bak.exists() else svg
        original = source_path.read_text(encoding="utf-8")
        flat = flatten_svg(original)
        if not bak.exists():
            bak.write_text(original, encoding="utf-8")
        if flat == svg.read_text(encoding="utf-8"):
            print(f"  unchanged: {svg.relative_to(ROOT)}")
            skipped += 1
            continue
        svg.write_text(flat, encoding="utf-8")
        print(f"  flattened: {svg.relative_to(ROOT)}")
        processed += 1
    print(f"\nDone. {processed} flattened, {skipped} unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
tf-8")
        print(f"  flattened: {svg.relative_to(ROOT)}")
        processed += 1
    print(f"\nDone. {processed} flattened, {skipped} unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
