"""Hard-trace (magnetic-lasso style) contour refinement.

Starts from a coarse hand-authored polygon, resamples it into a dense ring, then
snaps every point to the strongest image edge along its normal (with a distance
penalty and a displacement cap), iterating a few times and smoothing. The result
is a dense polygon that follows the real silhouette at pixel level, which PS can
consume as a hard polygon selection.

Usage:
  python hardtrace.py --input <original> --polygon <coarse.json>
      --out <dense.json> [--crop-bottom 149] [--step 6] [--radius 10]
      [--iterations 3] [--max-shift 28] [--preview <png>]
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def load_rgb(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255.0


def box_blur(a, r):
    if r <= 0:
        return a
    pad_spec = ((r, r), (r, r)) + ((0, 0),) * (a.ndim - 2)
    pad = np.pad(a, pad_spec, mode="edge")
    k = 2 * r + 1
    c = np.cumsum(pad, axis=0)
    c = np.concatenate([np.zeros((1,) + c.shape[1:]), c], axis=0)
    out = (c[k:] - c[:-k]) / k
    c2 = np.cumsum(out, axis=1)
    c2 = np.concatenate([np.zeros(c2.shape[:1] + (1,) + c2.shape[2:]), c2], axis=1)
    return (c2[:, k:] - c2[:, :-k]) / k


def resample_ring(points, step):
    pts = np.asarray(points, dtype=np.float64)
    n = len(pts)
    ring = []
    for i in range(n):
        a = pts[i]
        b = pts[(i + 1) % n]
        d = np.linalg.norm(b - a)
        count = max(1, int(round(d / step)))
        for t in range(count):
            ring.append(a + (b - a) * (t / count))
    return np.asarray(ring)


def snap(ring, grad, orig, radius, max_shift, weak_threshold=0.025):
    h, w = grad.shape
    out = ring.copy()
    n = len(ring)
    for i in range(n):
        p = ring[i]
        prev = ring[(i - 1) % n]
        nxt = ring[(i + 1) % n]
        t = nxt - prev
        norm = np.linalg.norm(t)
        if norm < 1e-6:
            continue
        nvec = np.array([-t[1], t[0]]) / norm
        best = None
        best_score = -1e9
        for s in range(-radius, radius + 1):
            q = p + nvec * s
            # keep displacement from original polygon bounded
            d0 = np.linalg.norm(q - orig[i % len(orig)])
            if d0 > max_shift:
                continue
            x = int(round(q[0]))
            y = int(round(q[1]))
            if x < 2 or y < 2 or x >= w - 2 or y >= h - 2:
                continue
            g = float(grad[y, x])
            if g < weak_threshold:
                score = g - abs(s) * 0.0008
            else:
                score = g - abs(s) * 0.0008
            if score > best_score:
                best_score = score
                best = q
        if best is not None and best_score > weak_threshold:
            out[i] = best
    return out


def smooth_ring(ring, window=9):
    n = len(ring)
    k = np.ones(window) / window
    out = np.zeros_like(ring)
    for axis in range(2):
        padded = np.concatenate([ring[-window:, axis], ring[:, axis], ring[:window, axis]])
        out[:, axis] = np.convolve(padded, k, mode="same")[window:window + n]
    return out


def main(argv):
    args = {}
    i = 1
    while i < len(argv) - 1:
        if argv[i].startswith("--"):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1

    img = load_rgb(args["input"])
    crop_bottom = int(args.get("crop-bottom", 0) or 0)
    if crop_bottom > 0:
        img = img[: img.shape[0] - crop_bottom]
    h, w = img.shape[:2]

    poly = json.load(open(args["polygon"], encoding="utf-8"))
    if all(0 <= p[0] <= 1.5 and 0 <= p[1] <= 1.5 for p in poly):
        poly = [[p[0] * w, p[1] * h] for p in poly]

    # edge strength: luminance gradient + chroma change
    lum = 0.2126 * img[..., 0] + 0.7152 * img[..., 1] + 0.0722 * img[..., 2]
    gx = np.zeros_like(lum)
    gy = np.zeros_like(lum)
    gx[:, 1:-1] = (lum[:, 2:] - lum[:, :-2]) * 0.5
    gy[1:-1, :] = (lum[2:, :] - lum[:-2, :]) * 0.5
    grad = np.hypot(gx, gy)
    for c in range(3):
        ch = img[..., c]
        cx = np.zeros_like(ch)
        cy = np.zeros_like(ch)
        cx[:, 1:-1] = (ch[:, 2:] - ch[:, :-2]) * 0.5
        cy[1:-1, :] = (ch[2:, :] - ch[:-2, :]) * 0.5
        grad = np.maximum(grad, np.hypot(cx, cy))
    grad = box_blur(grad, 1)

    step = float(args.get("step", 2.0))
    radius = int(args.get("radius", 10))
    iterations = int(args.get("iterations", 3))
    max_shift = float(args.get("max-shift", 26))
    out_step = float(args.get("out-step", 5.0))

    ring = resample_ring(poly, step)
    orig = ring.copy()
    for _ in range(iterations):
        ring = snap(ring, grad, orig, radius, max_shift)
        ring = smooth_ring(ring, 11)

    # final resample; PS polygon selection caps at ~1000 points (measured)
    ring = resample_ring(ring, out_step)
    max_points = int(args.get("max-points", 900))
    if len(ring) > max_points:
        idx = np.linspace(0, len(ring) - 1, max_points).astype(int)
        ring = ring[idx]
    pts = [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in ring]
    json.dump(pts, open(args["out"], "w", encoding="utf-8"), ensure_ascii=False)

    # rasterize result mask
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).polygon([(p[0], p[1]) for p in pts], fill=255)
    m = np.asarray(mask) > 127

    if args.get("preview"):
        im = Image.fromarray((img * 255).astype(np.uint8))
        dr = ImageDraw.Draw(im)
        dr.line([(p[0], p[1]) for p in poly] + [(poly[0][0], poly[0][1])], fill=(0, 255, 80), width=2)
        dr.line([(p[0], p[1]) for p in pts] + [(pts[0][0], pts[0][1])], fill=(255, 60, 60), width=1)
        im.save(args["preview"])

    print(json.dumps({
        "ok": True,
        "points": len(pts),
        "coarsePoints": len(poly),
        "maskAreaPct": round(float(m.mean()) * 100, 3),
        "outFile": args["out"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
