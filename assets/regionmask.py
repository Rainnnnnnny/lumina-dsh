"""Generate soft-alpha region masks from colour ranges or image channels.

Used by lumina-dsh layered recipes: mask.mode "color" (hue/sat/lum ranges) or
"channel" (R/G/B/lum soft threshold) -> RGBA PNG whose alpha is the selection.
High-resolution matting/tone separation runs on the ORIGINAL pixels, never a
thumbnail.

CLI:
  python regionmask.py --input in.png --output mask.png --mode color|channel
      [--ranges '[[h1,h2,smin,smax,lmin,lmax], ...]']   (hue 0-360)
      [--channel r|g|b|lum] [--low 0.2] [--high 0.8]
      [--feather 20] [--invert] [--crop l,t,r,b]
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image, ImageFilter

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def color_mask(rgb, ranges):
    hsv = np.asarray(Image.fromarray((rgb * 255).astype(np.uint8)).convert("HSV")).astype(np.float32) / 255.0
    hue = hsv[..., 0] * 360.0
    sat = hsv[..., 1]
    val = hsv[..., 2]
    mask = np.zeros(hue.shape, dtype=np.float32)
    for item in ranges:
        h1, h2, s1, s2, l1, l2 = [float(v) for v in item[:6]]
        hsel = ((hue >= h1) & (hue <= h2)) if h1 <= h2 else ((hue >= h1) | (hue <= h2))
        sel = hsel & (sat >= s1) & (sat <= s2) & (val >= l1) & (val <= l2)
        mask = np.maximum(mask, sel.astype(np.float32))
    return mask


def channel_mask(rgb, channel, low, high):
    if channel in ("lum", "l", "y"):
        data = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    else:
        data = rgb[..., {"r": 0, "g": 1, "b": 2}[channel]]
    return smoothstep(low, high, data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", choices=["color", "channel"], default="color")
    parser.add_argument("--ranges", default="[]")
    parser.add_argument("--channel", default="lum")
    parser.add_argument("--low", type=float, default=0.2)
    parser.add_argument("--high", type=float, default=0.8)
    parser.add_argument("--feather", type=float, default=0.0)
    parser.add_argument("--invert", action="store_true")
    parser.add_argument("--crop", default="")
    parser.add_argument("--exclude", default="", help="RGBA PNG whose alpha is subtracted pixel-wise (person matte)")
    args = parser.parse_args()

    image = Image.open(args.input).convert("RGB")
    if args.crop:
        left, top, right, bottom = [int(round(float(v))) for v in args.crop.split(",")]
        image = image.crop((left, top, right, bottom))
    rgb = np.asarray(image).astype(np.float32) / 255.0

    if args.mode == "color":
        mask = color_mask(rgb, json.loads(args.ranges or "[]"))
    else:
        mask = channel_mask(rgb, args.channel, args.low, args.high)
    if args.exclude:
        ex = Image.open(args.exclude).convert("RGBA")
        if ex.size != image.size:
            ex = ex.resize(image.size, Image.LANCZOS)
        ex_alpha = np.asarray(ex.getchannel("A")).astype(np.float32) / 255.0
        mask = mask * (1.0 - ex_alpha)
    if args.invert:
        mask = 1.0 - mask
    alpha = Image.fromarray((np.clip(mask, 0.0, 1.0) * 255.0).round().astype(np.uint8), "L")
    if args.feather > 0:
        alpha = alpha.filter(ImageFilter.GaussianBlur(radius=float(args.feather)))
    out = Image.new("RGBA", alpha.size, (255, 255, 255, 0))
    out.putalpha(alpha)
    out.save(args.output, "PNG")
    coverage = float((np.asarray(alpha).astype(np.float32) / 255.0).mean() * 100.0)
    print(json.dumps({"ok": True, "mode": args.mode, "width": alpha.width, "height": alpha.height,
                      "coveragePct": round(coverage, 2), "output": args.output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
