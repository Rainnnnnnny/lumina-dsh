"""Hair-aware soft alpha matte around a hard subject mask.

Hard polygons cut 2-4 px hair strands, and the subject layer's bloom then
paints halos. A plain difference matte also captures bright background objects
(stone, orange foliage). This script only uses the luminance matte where the
boundary belongs to *dark hair*, and keeps the hard mask (with a 1 px ramp)
elsewhere (skin/dress edges).

  band pixels:  alpha_lum = smoothstep((bg_lum - lum) / (bg_lum - hair_lum))
                gated off for pixels brighter than `bright_cut`
  hair_weight:  from the blurred luminance just inside the hard mask
                (dark inside -> trust the luminance matte)
  core:         alpha = 1
  far outside:  alpha = 0

Usage:
  python alphamatte.py --input orig.png --mask mask-final.png --out alpha.png
      [--band 16] [--core 2] [--blur 12] [--hair-lum 0.30] [--bright-cut 0.6]
"""
import json
import sys

import numpy as np
from PIL import Image

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def box_blur(a, r):
    if r < 1:
        return a.astype(np.float32)
    k = 2 * r + 1
    out = a.astype(np.float32)
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r + 1, r)
        p = np.pad(out, pad, mode='edge')
        cs = np.cumsum(p, axis=axis)
        sl_hi = [slice(None)] * out.ndim
        sl_lo = [slice(None)] * out.ndim
        sl_hi[axis] = slice(k, k + out.shape[axis])
        sl_lo[axis] = slice(0, out.shape[axis])
        out = (cs[tuple(sl_hi)] - cs[tuple(sl_lo)]) / k
    return out


def dilate(m, n=1):
    out = m.copy()
    for _ in range(n):
        p = np.pad(out, 1, mode='constant')
        out = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return out


def erode(m, n=1):
    out = m.copy()
    for _ in range(n):
        p = np.pad(out, 1, mode='constant')
        out = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return out


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def main(argv):
    args = {}
    i = 1
    while i < len(argv) - 1:
        if argv[i].startswith('--'):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1

    rgb = np.asarray(Image.open(args['input']).convert('RGB')).astype(np.float32) / 255.0
    mask = np.asarray(Image.open(args['mask']).convert('L')) > 127
    H, W = mask.shape
    rgb = rgb[:H, :W]
    lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]

    band = int(args.get('band', 12))
    core = int(args.get('core', 2))
    blur_r = int(args.get('blur', 12))
    hair_lum = float(args.get('hair-lum', 0.18))
    bright_cut = float(args.get('bright-cut', 0.45))

    inner = erode(mask, core)
    inside = dilate(mask, 2)
    outside = ~dilate(mask, band)
    band_px = inside & ~inner

    # local "what is just inside the boundary" luminance -> is this hair?
    fg_w = inner.astype(np.float32)
    fg_lum = box_blur(lum * fg_w, 8) / np.maximum(box_blur(fg_w, 8), 1e-4)

    # local background brightness (from outside the mask) and local bg colour
    bg_w = (~dilate(mask, 6)).astype(np.float32)
    bg_lum = box_blur(lum * bg_w, blur_r) / np.maximum(box_blur(bg_w, blur_r), 1e-4)
    bg_rgb = np.stack([box_blur(rgb[..., c] * bg_w, blur_r) for c in range(3)], axis=2) / \
        np.maximum(box_blur(bg_w, blur_r)[..., None], 1e-4)
    bg_lum = 0.2126 * bg_rgb[..., 0] + 0.7152 * bg_rgb[..., 1] + 0.0722 * bg_rgb[..., 2]

    # luminance-based hair alpha: how much darker than local background
    denom = np.maximum(bg_lum - hair_lum, 0.08)
    a_lum = smoothstep((bg_lum - lum) / denom)
    # only "clearly dark" pixels over a "clearly bright" background may join the
    # matte; this keeps stone/foliage/grass out of it
    a_lum = np.where((lum > bright_cut) | (bg_lum < bright_cut), 0.0, a_lum)
    # require a real margin so mid-grey background objects do not leak in
    a_lum = np.where((bg_lum - lum) < 0.12, 0.0, a_lum)

    hair_weight = smoothstep((0.52 - fg_lum) / 0.22)  # 1 where boundary is hair
    hard = smoothstep(np.clip((dilate(mask, 1).astype(np.float32) - mask.astype(np.float32)) * -0.0 + 1.0, 0, 1)) * 0.0
    # hard core with a 2 px linear ramp outside the boundary
    dist_in = box_blur(mask.astype(np.float32), 2)
    hard = smoothstep((dist_in - 0.15) / 0.7)

    alpha = np.where(inner, 1.0, 0.0)
    alpha = np.where(band_px, np.maximum(alpha, np.where(hair_weight > 0.5, a_lum, hard)), alpha)
    # outside band stays 0; inside non-core uses the hard ramp or the hair matte
    alpha = np.where(outside, 0.0, alpha)
    alpha = np.where(inside & ~band_px & ~inner, np.maximum(alpha, hard), alpha)
    sm = int(args.get('smooth', 1))
    if sm > 0:
        alpha = box_blur(alpha, sm)
    alpha = np.clip(alpha, 0, 1)

    Image.fromarray((alpha * 255).astype(np.uint8)).save(args['out'])
    print(json.dumps({
        'ok': True,
        'file': args['out'],
        'recoveredOutsideMask': int(((alpha > 0.5) & ~mask).sum()),
        'coreLostPixels': int(((alpha < 0.5) & inner).sum()),
        'softPixels': int(((alpha > 0.02) & (alpha < 0.98)).sum()),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
