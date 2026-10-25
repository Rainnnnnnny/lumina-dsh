"""Hybrid matte generation for lumina-dsh.

Pipeline:
  1. rasterize a hand-authored polygon (trimap core)
  2. estimate local foreground/background colour models by normalized convolution
  3. per-pixel soft alpha from colour distance ratio (inside unknown band)
  4. suppress interior background holes that match the bg model closely
  5. output: cutout RGBA PNG (for Photoshop paste) + matte PNG + debug overlay

Commands (print one JSON object to stdout):
  cutout --input <png> [--crop-bottom N] --polygon <json-file-or-inline>
         --out-cutout <png> --out-matte <png> [--out-debug <png>]
         [--feather 18] [--erode 24] [--dilate 44]
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def _load(path):
    im = Image.open(path).convert("RGB")
    return np.asarray(im).astype(np.float32) / 255.0


def _box_blur(a, r):
    """Separable box blur via cumulative sums (edge padded, any trailing dims)."""
    if r <= 0:
        return a.copy()
    k = 2 * r + 1
    pad_spec = ((r, r), (r, r)) + ((0, 0),) * (a.ndim - 2)
    pad = np.pad(a, pad_spec, mode="edge")
    c = np.cumsum(pad, axis=0, dtype=np.float64)
    c = np.concatenate([np.zeros((1,) + c.shape[1:], dtype=np.float64), c], axis=0)
    out = (c[k:, ...] - c[:-k, ...]) / k
    c2 = np.cumsum(out, axis=1, dtype=np.float64)
    c2 = np.concatenate([np.zeros(c2.shape[:1] + (1,) + c2.shape[2:], dtype=np.float64), c2], axis=1)
    return (c2[:, k:, ...] - c2[:, :-k, ...]) / k


def _dilate(mask, iterations):
    m = mask.copy()
    for _ in range(int(iterations)):
        m = (m | np.roll(m, 1, 0) | np.roll(m, -1, 0)
             | np.roll(m, 1, 1) | np.roll(m, -1, 1)
             | np.roll(np.roll(m, 1, 0), 1, 1) | np.roll(np.roll(m, 1, 0), -1, 1)
             | np.roll(np.roll(m, -1, 0), 1, 1) | np.roll(np.roll(m, -1, 0), -1, 1))
    return m


def _erode(mask, iterations):
    return ~_dilate(~mask, iterations)


def _norm(a):
    return np.sqrt((a ** 2).sum(axis=-1))


def cmd_cutout(args):
    src = _load(args["input"])
    crop_bottom = int(args.get("crop-bottom", 0) or 0)
    if crop_bottom > 0:
        src = src[:max(1, src.shape[0] - crop_bottom)]
    h, w = src.shape[:2]

    poly_arg = args["polygon"]
    if os.path.exists(poly_arg):
        with open(poly_arg, "r", encoding="utf-8") as fh:
            polygon = json.load(fh)
    else:
        polygon = json.loads(poly_arg)
    if len(polygon) < 3:
        raise ValueError("polygon needs at least 3 points")

    # normalized points -> pixels
    if all(0.0 <= float(p[0]) <= 1.5 and 0.0 <= float(p[1]) <= 1.5 for p in polygon):
        pts = [(float(p[0]) * w, float(p[1]) * h) for p in polygon]
    else:
        pts = [(float(p[0]), float(p[1])) for p in polygon]

    poly_img = Image.new("L", (w, h), 0)
    ImageDraw.Draw(poly_img).polygon(pts, fill=255)
    poly = np.asarray(poly_img) > 127

    erode_px = int(args.get("erode", 20))
    dilate_px = int(args.get("dilate", 18))
    core = _erode(poly, erode_px)
    outer = _dilate(poly, dilate_px)
    unknown = outer & ~core

    # --- local colour models (normalized convolution) ---------------------
    # Only a narrow band around the outline is refined; the polygon interior is
    # kept as subject (it is the hand-authored decision) so complex interiors
    # cannot be misclassified by a colour model.
    r_fg = max(12, int(args.get("r-fg", 30)))
    r_bg = max(12, int(args.get("r-bg", 60)))
    img = src.astype(np.float32)

    fg_w = core.astype(np.float32)
    fg_num = _box_blur(img * fg_w[..., None], r_fg)
    fg_den = _box_blur(fg_w, r_fg)
    global_fg = (img * fg_w[..., None]).reshape(-1, 3).sum(axis=0) / max(1.0, fg_w.sum())
    fg_local = fg_num / np.maximum(fg_den[..., None], 1e-4)
    fg_weak = fg_den < 0.02
    fg_local[fg_weak] = global_fg

    bg_w = (~outer).astype(np.float32)
    bg_num = _box_blur(img * bg_w[..., None], r_bg)
    bg_den = _box_blur(bg_w, r_bg)
    global_bg = (img * bg_w[..., None]).reshape(-1, 3).sum(axis=0) / max(1.0, bg_w.sum())
    bg_local = bg_num / np.maximum(bg_den[..., None], 1e-4)
    bg_weak = bg_den < 0.02
    bg_local[bg_weak] = global_bg

    d_bg = _norm(img - bg_local)
    d_fg = _norm(img - fg_local)
    band_alpha = d_bg / (d_bg + d_fg + 1e-4)

    # soft-threshold the band alpha (classic matting shortcut)
    lo = float(args.get("lo", 0.35))
    hi = float(args.get("hi", 0.68))
    band_alpha = np.clip((band_alpha - lo) / max(1e-4, hi - lo), 0.0, 1.0)
    band_alpha = _box_blur(band_alpha, int(args.get("smooth", 2)))
    band_alpha = np.clip(band_alpha, 0.0, 1.0)

    alpha = np.zeros_like(band_alpha)
    alpha[core] = 1.0
    alpha[unknown] = band_alpha[unknown]
    alpha[~outer] = 0.0

    # optional: punch out bg-like holes inside the polygon (off by default)
    if args.get("punch-holes", "0") in ("1", "true", "yes"):
        hole_thr = float(args.get("hole-threshold", 0.045))
        holes = poly & (d_bg < hole_thr) & (d_fg > hole_thr * 2)
        holes = _erode(holes, int(args.get("hole-erode", 6)))
        alpha[holes] = 0.0

    feather = int(args.get("feather", 0) or 0)
    if feather > 0:
        alpha = _box_blur(alpha, feather // 2)

    # --- outputs ---
    matte_img = Image.fromarray((alpha * 255).astype(np.uint8))
    matte_img.save(args["out-matte"])

    rgba = np.dstack([(src * 255.0).astype(np.uint8), (alpha * 255).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(args["out-cutout"])

    if args.get("out-debug"):
        dbg = (src * 0.55).copy()
        tint = np.array([1.0, 0.25, 0.25], dtype=np.float32)
        m = alpha > 0.5
        dbg[m] = dbg[m] * 0.45 + tint * 0.55
        Image.fromarray((np.clip(dbg, 0, 1) * 255).astype(np.uint8)).save(args["out-debug"])

    selected = float((alpha > 0.5).mean())
    return {
        "ok": True,
        "width": w,
        "height": h,
        "polygonPoints": len(pts),
        "alphaCoverage": round(selected, 4),
        "corePx": int(core.sum()),
        "bandPx": int(unknown.sum()),
    }


def main(argv):
    if len(argv) < 2 or argv[1] != "cutout":
        print(json.dumps({"ok": False, "error": "usage: matte.py cutout ..."}))
        return 2
    args = {}
    i = 2
    while i < len(argv) - 1:
        if argv[i].startswith("--"):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    try:
        result = cmd_cutout(args)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
