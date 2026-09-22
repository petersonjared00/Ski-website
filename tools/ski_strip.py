#!/usr/bin/env python3
"""Turn AI-generated images into a print-ready ski topsheet sheet.

  crop   one wide image  -> a 10:1 strip (simplest test)
  stitch several panels  -> a 10:1 strip, cross-fading the overlaps
  sheet  one strip       -> the 5:1 pair sheet (16 x 80 in at 200 dpi)

Examples
  python ski_strip.py crop wide.png strip.png --band 0.5
  python ski_strip.py stitch tail.png mid1.png mid2.png tip.png -o strip.png --overlap 0.2
  python ski_strip.py sheet strip.png sheet.tif --mirror --cmyk

Needs: pip install pillow numpy
"""
import argparse
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
RATIO = 10            # strip length : width for one ski, bleed included
SHEET = (16000, 3200) # 80 x 16 in at 200 dpi


def crop(args):
    im = Image.open(args.src).convert("RGB")
    w, h = im.size
    band = w / RATIO                      # strip height at full image width
    if band > h:
        raise SystemExit(f"Image is already narrower than {RATIO}:1")
    top = (h - band) * args.band          # 0 = top of image, 1 = bottom
    im.crop((0, round(top), w, round(top + band))).save(args.out)
    print(f"strip {w}x{round(band)} px. Needs {SHEET[0] / w:.1f}x upscale for print.")


def stitch(args):
    """Panels are listed tail -> tip. Each overlaps the next by `overlap` of its width."""
    panels = [Image.open(p).convert("RGB") for p in args.panels]
    h = min(p.height for p in panels)
    panels = [np.asarray(p.resize((round(p.width * h / p.height), h), Image.LANCZOS), dtype=np.float32) for p in panels]
    out = panels[0]
    for nxt in panels[1:]:
        ov = round(min(out.shape[1], nxt.shape[1]) * args.overlap)
        ramp = np.linspace(0, 1, ov, dtype=np.float32)[None, :, None]
        blend = out[:, -ov:] * (1 - ramp) + nxt[:, :ov] * ramp
        out = np.concatenate([out[:, :-ov], blend, nxt[:, ov:]], axis=1)
    strip = Image.fromarray(out.clip(0, 255).astype(np.uint8))
    target_h = round(strip.width / RATIO)
    if target_h < strip.height:           # too tall: take the centre band
        top = (strip.height - target_h) // 2
        strip = strip.crop((0, top, strip.width, top + target_h))
    strip.save(args.out)
    print(f"strip {strip.width}x{strip.height} px ({strip.width / strip.height:.1f}:1)")


def sheet(args):
    strip = Image.open(args.src).convert("RGB").resize((SHEET[0], SHEET[1] // 2), Image.LANCZOS)
    second = strip.transpose(Image.FLIP_TOP_BOTTOM) if args.mirror else strip
    page = Image.new("RGB", SHEET)
    page.paste(strip, (0, 0))
    page.paste(second, (0, SHEET[1] // 2))
    if args.cmyk:                         # naive conversion; use the printer's ICC profile for real jobs
        page = page.convert("CMYK")
    page.save(args.out, dpi=(200, 200))
    print(f"sheet {SHEET[0]}x{SHEET[1]} px at 200 dpi -> {args.out}")


p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = p.add_subparsers(required=True)
c = sub.add_parser("crop"); c.add_argument("src"); c.add_argument("out")
c.add_argument("--band", type=float, default=0.5, help="vertical position of the strip, 0 top to 1 bottom")
c.set_defaults(fn=crop)
s = sub.add_parser("stitch"); s.add_argument("panels", nargs="+"); s.add_argument("-o", "--out", required=True)
s.add_argument("--overlap", type=float, default=0.2); s.set_defaults(fn=stitch)
t = sub.add_parser("sheet"); t.add_argument("src"); t.add_argument("out")
t.add_argument("--mirror", action="store_true"); t.add_argument("--cmyk", action="store_true"); t.set_defaults(fn=sheet)
a = p.parse_args(); a.fn(a)
