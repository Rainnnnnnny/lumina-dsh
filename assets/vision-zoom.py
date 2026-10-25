"""Zoom / annotate / probe image regions for high-resolution inspection.

Commands (print one JSON object to stdout):
  zoom  --input <path> [--x --y --w --h] [--zoom 1] [--max-dim 2048]
        [--grid 0] [--edge] [--points "x,y;x,y"] [--out <png>]
  probe --input <path> --points "x,y;x,y" | --line x1,y1,x2,y2 [--step 4]
        [--radius 1]
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def _font(size):
    for name in ("msyh.ttc", "segoeui.ttf"):
        try:
            return ImageFont.truetype(r"C:\Windows\Fonts\\" + name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _rgb(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255.0


def cmd_zoom(args):
    src = Image.open(args["input"]).convert("RGB")
    W, H = src.size
    x = int(args.get("x", 0))
    y = int(args.get("y", 0))
    w = int(args.get("w", W - x))
    h = int(args.get("h", H - y))
    x = max(0, min(x, W - 1))
    y = max(0, min(y, H - 1))
    w = max(1, min(w, W - x))
    h = max(1, min(h, H - y))
    crop = src.crop((x, y, x + w, y + h))

    zoom = float(args.get("zoom", 1.0))
    native = str(args.get("native", "")).lower() in ("1", "true", "yes")
    max_pixels = int(args.get("max-pixels", 0) or 0)
    if native:
        # 1:1 inspection of original pixels: no zoom-out, no max-dim downscale
        scale = 1.0
    else:
        max_dim = int(args.get("max-dim", 2048))
        scale = zoom
        if max(w, h) * scale > max_dim:
            scale = max_dim / max(w, h)
    if max_pixels > 0 and w * h * scale * scale > max_pixels:
        scale = (max_pixels / max(1, w * h)) ** 0.5
    out_w = max(1, int(round(w * scale)))
    out_h = max(1, int(round(h * scale)))
    view = crop.resize((out_w, out_h), Image.LANCZOS).convert("RGB")
    draw = ImageDraw.Draw(view)
    denom = max(1.0, scale)
    font = _font(max(12, min(20, int(13 * denom))))

    # edge overlay: strong Sobel edges drawn in red so the true boundary is visible
    if args.get("edge") in ("1", "true", "yes"):
        a = np.asarray(crop).astype(np.float32) / 255.0
        lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
        gx = np.zeros_like(lum)
        gy = np.zeros_like(lum)
        gx[:, 1:-1] = (lum[:, 2:] - lum[:, :-2]) * 0.5
        gy[1:-1, :] = (lum[2:, :] - lum[:-2, :]) * 0.5
        mag = np.hypot(gx, gy)
        thr = np.percentile(mag, 97) if mag.size else 1
        edge = mag >= max(thr, 0.02)
        edge_img = Image.fromarray((edge * 255).astype(np.uint8)).resize((out_w, out_h), Image.NEAREST)
        ea = np.asarray(edge_img) > 127
        va = np.asarray(view).copy()
        va[ea] = (va[ea] * 0.25 + np.array([255, 40, 40]) * 0.75).astype(np.uint8)
        view = Image.fromarray(va)
        draw = ImageDraw.Draw(view)

    grid = float(args.get("grid", 0) or 0)
    if grid > 0:
        major = grid * 5
        gx0 = int((x // grid) * grid)
        gy0 = int((y // grid) * grid)
        g = gx0
        while g <= x + w:
            if g >= x:
                px = (g - x) * scale
                is_major = (g % major) == 0
                draw.line([(px, 0), (px, out_h)], fill=(255, 80, 80) if is_major else (90, 140, 255), width=1)
                if is_major:
                    draw.text((px + 2, 2), str(int(g)), fill=(255, 100, 100), font=font)
            g += grid
        g = gy0
        while g <= y + h:
            if g >= y:
                py = (g - y) * scale
                is_major = (g % major) == 0
                draw.line([(0, py), (out_w, py)], fill=(255, 80, 80) if is_major else (90, 140, 255), width=1)
                if is_major:
                    draw.text((2, py + 1), str(int(g)), fill=(255, 100, 100), font=font)
            g += grid

    points = args.get("points")
    if points:
        for item in str(points).split(";"):
            item = item.strip()
            if not item:
                continue
            parts = item.split(",")
            if len(parts) != 2:
                continue
            px = (float(parts[0]) - x) * scale
            py = (float(parts[1]) - y) * scale
            if 0 <= px < out_w and 0 <= py < out_h:
                r = max(4, int(6 * denom))
                draw.line([(px - r, py), (px + r, py)], fill=(60, 255, 90), width=2)
                draw.line([(px, py - r), (px, py + r)], fill=(60, 255, 90), width=2)
                draw.text((px + r + 2, py - r), item, fill=(60, 255, 90), font=font)

    out = args["out"]
    view.save(out)
    return {
        "ok": True,
        "file": out,
        "source": {"x": x, "y": y, "w": w, "h": h},
        "view": {"width": out_w, "height": out_h},
        "scale": round(scale, 4),
        "sourceRect": [x, y, x + w, y + h],
    }


def _sample(arr, px, py, radius):
    h, w = arr.shape[:2]
    x0 = max(0, int(px) - radius)
    x1 = min(w, int(px) + radius + 1)
    y0 = max(0, int(py) - radius)
    y1 = min(h, int(py) + radius + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    return arr[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)


def cmd_probe(args):
    arr = _rgb(args["input"])
    h, w = arr.shape[:2]
    radius = int(args.get("radius", 1))
    lum = 0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]
    gx = np.zeros_like(lum)
    gy = np.zeros_like(lum)
    gx[:, 1:-1] = (lum[:, 2:] - lum[:, :-2]) * 0.5
    gy[1:-1, :] = (lum[2:, :] - lum[:-2, :]) * 0.5
    mag = np.hypot(gx, gy)

    rows = []
    points_arg = args.get("points")
    samples = []
    if points_arg:
        for item in str(points_arg).split(";"):
            item = item.strip()
            if not item:
                continue
            parts = item.split(",")
            if len(parts) == 2:
                samples.append((float(parts[0]), float(parts[1])))
    if args.get("line"):
        p = [float(v) for v in str(args["line"]).split(",")]
        n = int(args.get("step", 4))
        length = max(1.0, np.hypot(p[2] - p[0], p[3] - p[1]))
        count = max(2, int(length / max(1, n)) + 1)
        for i in range(count):
            t = i / (count - 1)
            samples.append((p[0] + (p[2] - p[0]) * t, p[1] + (p[3] - p[1]) * t))
    for (px, py) in samples:
        if not (0 <= px < w and 0 <= py < h):
            rows.append({"x": round(px, 1), "y": round(py, 1), "out": True})
            continue
        c = _sample(arr, px, py, radius)
        rows.append({
            "x": round(px, 1),
            "y": round(py, 1),
            "rgb": [int(round(v * 255)) for v in c],
            "lum": round(float(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]), 4),
            "edge": round(float(mag[int(py), int(px)]), 4),
        })
    return {"ok": True, "samples": rows, "count": len(rows)}


def main(argv):
    if len(argv) < 2 or argv[1] not in ("zoom", "probe"):
        print(json.dumps({"ok": False, "error": "usage: zoom.py zoom|probe ..."}))
        return 2
    cmd = argv[1]
    args = {}
    i = 2
    while i < len(argv) - 1:
        if argv[i].startswith("--"):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    try:
        result = cmd_zoom(args) if cmd == "zoom" else cmd_probe(args)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
