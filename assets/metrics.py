"""Image quality metrics + project artifacts for lumina-dsh.

Commands (all print one JSON object to stdout):
  info <image>
  assess <image>                       quality assessment for the auto pipeline
  measure <image>
  orient --input <a> --output <b>      write an EXIF-orientation-normalised copy
  compare --before <a> --after <b> --out <png> [--json <file>] [--label-before X] [--label-after Y]
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

# JSON printed to stdout may contain non-ASCII paths (e.g. Chinese project
# folders); the Node side always decodes UTF-8, so never emit the ANSI codepage.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _load(path):
    im = Image.open(path)
    fmt = im.format
    # Phone cameras often store portrait photos as landscape pixels + EXIF
    # orientation; every downstream metric and the PS pipeline expect the
    # upright image, so normalise here.
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    im = im.convert("RGB")
    a = np.asarray(im).astype(np.float32) / 255.0
    return im, a, fmt


def _lum(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def _load_cropped(path, crop_bottom):
    im, a, fmt = _load(path)
    if crop_bottom and crop_bottom > 0:
        h = a.shape[0]
        keep = max(1, h - int(crop_bottom))
        a = a[:keep]
        im = im.crop((0, 0, im.width, keep))
    return im, a, fmt


def _metrics(path, crop_bottom=0):
    im, a, fmt = _load_cropped(path, crop_bottom)
    h, w = a.shape[:2]
    lum = _lum(a)
    mx = a.max(axis=-1)
    mn = a.min(axis=-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    lap = (4 * lum[1:-1, 1:-1] - lum[:-2, 1:-1] - lum[2:, 1:-1]
           - lum[1:-1, :-2] - lum[1:-1, 2:])
    return {
        "path": path,
        "format": fmt,
        "width": w,
        "height": h,
        "mean": round(float(lum.mean()), 4),
        "std": round(float(lum.std()), 4),
        "p1": round(float(np.percentile(lum, 1)), 4),
        "p50": round(float(np.percentile(lum, 50)), 4),
        "p99": round(float(np.percentile(lum, 99)), 4),
        "clipHi": round(float((lum > 0.98).mean() * 100), 2),
        "clipLo": round(float((lum < 0.02).mean() * 100), 2),
        "sat": round(float(sat.mean()), 4),
        "sharp": round(float(np.abs(lap).mean()), 5),
        "rgbMean": [round(float(x), 4) for x in a.reshape(-1, 3).mean(axis=0)],
    }


def _detect_strip_a(a):
    """Guess a bottom UI strip: contiguous bottom rows that are bright and neutral."""
    h, w = a.shape[:2]
    lum = _lum(a)
    mx = a.max(axis=-1)
    mn = a.min(axis=-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    row_mean = lum.mean(axis=1)
    row_sat = sat.mean(axis=1)
    n = 0
    while n < h - 1:
        y = h - 1 - n
        if row_mean[y] > 0.90 and row_sat[y] < 0.06:
            n += 1
        else:
            break
    strip = n if 0 < n < h * 0.3 else 0
    confidence = "high" if strip else "none"
    if strip and strip < 8:
        confidence = "low"
    return {"stripPx": int(strip), "confidence": confidence}


def _detect_strip(path):
    im, a, fmt = _load(path)
    return _detect_strip_a(a)


def _exif_info(path):
    out = {"make": None, "model": None, "orientation": 1, "hasExif": False, "hasCamera": False}
    try:
        im = Image.open(path)
        ex = im.getexif()
        if ex:
            out["hasExif"] = True
            out["orientation"] = int(ex.get(274, 1) or 1)
            make = ex.get(271)
            model = ex.get(272)
            out["make"] = str(make).strip() if make else None
            out["model"] = str(model).strip() if model else None
            out["hasCamera"] = bool(out["make"] or out["model"])
    except Exception:
        pass
    return out


def _work_luma(im, long_edge=1024):
    """Luminance at a fixed working long edge so blur is comparable across sizes."""
    w, h = im.size
    scale = long_edge / max(w, h)
    if scale < 1:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    a = np.asarray(im.convert("RGB")).astype(np.float32) / 255.0
    return _lum(a)


def _blur_noise(l):
    h, w = l.shape
    if h < 4 or w < 4:
        return 0.0, 0.0
    lap = (4 * l[1:-1, 1:-1] - l[:-2, 1:-1] - l[2:, 1:-1]
           - l[1:-1, :-2] - l[1:-1, 2:])
    blur = float(np.abs(lap).mean())
    # noise: typical local std inside low-contrast 8x8 tiles (ignores edges and
    # clipped flat areas, which are content, not noise)
    block = 8
    hb = (h // block) * block
    wb = (w // block) * block
    noise = 0.0
    if hb and wb:
        tiles = l[:hb, :wb].reshape(hb // block, block, wb // block, block)
        tiles = tiles.transpose(0, 2, 1, 3).reshape(-1, block * block)
        stds = tiles.std(axis=1)
        means = tiles.mean(axis=1)
        usable = (stds < 0.03) & (means > 0.03) & (means < 0.97)
        noise = float(stds[usable].mean()) if usable.any() else 0.0
    return blur, noise


def cmd_assess(path):
    """Quality assessment used by the universal auto pipeline.

    Returns resolution/EXIF/blur/noise/tonality signals in one call. Blur is
    measured at a fixed 1024 px working long edge so images of different sizes
    are comparable; UI strip and orientation are already normalised.
    """
    im = Image.open(path)
    fmt = im.format
    raw_size = im.size
    try:
        im_norm = ImageOps.exif_transpose(im)
    except Exception:
        im_norm = im
    im_norm = im_norm.convert("RGB")
    w, h = im_norm.size
    a = np.asarray(im_norm).astype(np.float32) / 255.0
    lum = _lum(a)
    mx = a.max(axis=-1)
    mn = a.min(axis=-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    lap = (4 * lum[1:-1, 1:-1] - lum[:-2, 1:-1] - lum[2:, 1:-1]
           - lum[1:-1, :-2] - lum[1:-1, 2:])
    blur, noise = _blur_noise(_work_luma(im_norm))
    exif = _exif_info(path)
    result = {
        "ok": True,
        "path": path,
        "format": fmt,
        "width": w,
        "height": h,
        "rawWidth": raw_size[0],
        "rawHeight": raw_size[1],
        "longEdge": max(w, h),
        "shortEdge": min(w, h),
        "megapixels": round(w * h / 1e6, 2),
        "aspect": round(max(w, h) / max(1, min(w, h)), 3),
        "orientation": exif["orientation"],
        "exif": exif,
        "blurScore": round(blur, 5),
        "noiseScore": round(noise, 5),
        "workResolution": 1024,
        "mean": round(float(lum.mean()), 4),
        "p50": round(float(np.percentile(lum, 50)), 4),
        "clipHi": round(float((lum > 0.98).mean() * 100), 2),
        "clipLo": round(float((lum < 0.02).mean() * 100), 2),
        "sat": round(float(sat.mean()), 4),
        "sharp": round(float(np.abs(lap).mean()), 5),
    }
    result.update(_detect_strip_a(a))
    return result


def cmd_orient(input_path, output_path):
    """Write an EXIF-orientation-normalised PNG copy (for rotated phone photos)."""
    im = Image.open(input_path)
    orientation = 1
    try:
        ex = im.getexif()
        if ex:
            orientation = int(ex.get(274, 1) or 1)
    except Exception:
        pass
    try:
        out_im = ImageOps.exif_transpose(im).convert("RGB")
    except Exception:
        out_im = im.convert("RGB")
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    out_im.save(output_path, "PNG")
    return {
        "ok": True,
        "input": input_path,
        "output": output_path,
        "orientation": orientation,
        "width": out_im.width,
        "height": out_im.height,
        "sourceWidth": im.width,
        "sourceHeight": im.height,
    }


def cmd_info(path):
    im, a, fmt = _load(path)
    h, w = a.shape[:2]
    out = {"ok": True, "width": w, "height": h, "format": fmt}
    out.update(_detect_strip(path))
    return out


def cmd_measure(path, crop_bottom=0):
    out = _metrics(path, crop_bottom)
    if crop_bottom:
        out["croppedBottom"] = crop_bottom
    out["ok"] = True
    return out


def _font(size):
    for name in ("msyh.ttc", "msyhbd.ttc", "segoeui.ttf"):
        try:
            return ImageFont.truetype(r"C:\Windows\Fonts\\" + name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def cmd_compare(before, after, out_png, out_json=None, label_before="before",
                label_after="after", crop_bottom_before=0):
    b = Image.open(before).convert("RGB")
    b_metrics = _load_cropped(before, crop_bottom_before)[1]
    c = Image.open(after).convert("RGB")
    target_w = 1600
    pad, label_h = 14, 44
    font = _font(26)
    font_small = _font(22)

    # --- overview: downscaled panels, good for tonality/color, NOT for sharpness ---
    overview = []
    for label, im in ((f"{label_before}  ·  整体预览（已缩放）", b),
                      (f"{label_after}  ·  整体预览（已缩放）", c)):
        r = target_w / im.width
        overview.append((label, im.resize((target_w, max(1, int(im.height * r))), Image.LANCZOS)))

    # --- detail: 1:1 crops around the subject, for judging noise/sharpness fairly ---
    detail_size = 760
    content_h_before = (b.height - int(crop_bottom_before)) if crop_bottom_before else b.height

    def detail_crop(im, content_h, cx=0.49, cy=0.68):
        w, h = im.size
        x = int(w * cx)
        y = int(content_h * cy)
        left = max(0, min(w - detail_size, x - detail_size // 2))
        top = max(0, min(content_h - detail_size, y - detail_size // 2))
        return im.crop((left, top, left + detail_size, top + detail_size))

    details = [
        (f"1:1 细节  ·  {label_before}", detail_crop(b, content_h_before)),
        (f"1:1 细节  ·  {label_after}", detail_crop(c, c.height)),
    ]

    width = target_w + pad * 2
    height = (
        pad
        + sum(label_h + t.height + pad for _, t in overview)
        + label_h  # detail section header
        + detail_size
        + pad
    )
    sheet = Image.new("RGB", (width, height), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    y = pad
    for label, t in overview:
        draw.text((pad + 6, y + 8), label, fill=(240, 240, 240), font=font)
        y += label_h
        sheet.paste(t, (pad, y))
        y += t.height + pad
    draw.text((pad + 6, y + 6), "下面为 1:1 原始像素细节（判断噪点与清晰度请看这里）",
              fill=(255, 214, 128), font=font_small)
    y += label_h
    for i, (label, t) in enumerate(details):
        x = pad + i * (detail_size + pad)
        draw.text((x + 4, y + 4), label, fill=(240, 240, 240), font=font_small)
        sheet.paste(t, (x, y + 30))
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    sheet.save(out_png)

    result = {
        "ok": True,
        "before": _metrics(before, crop_bottom_before),
        "after": _metrics(after),
        "comparePath": out_png,
    }
    if crop_bottom_before:
        result["before"]["croppedBottom"] = int(crop_bottom_before)
    if out_json:
        os.makedirs(os.path.dirname(out_json), exist_ok=True)
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    return result


def _laplacian(arr):
    l = _lum(arr)
    return np.abs(4 * l[1:-1, 1:-1] - l[:-2, 1:-1] - l[2:, 1:-1]
                  - l[1:-1, :-2] - l[1:-1, 2:])


def _region_stats(arr, mask):
    lap = _laplacian(arr)
    inner = mask[1:-1, 1:-1]
    if inner.shape != lap.shape:
        h = min(inner.shape[0], lap.shape[0])
        w = min(inner.shape[1], lap.shape[1])
        inner = inner[:h, :w]
        lap = lap[:h, :w]
    lum = _lum(arr)
    if lum.shape != mask.shape:
        h = min(lum.shape[0], mask.shape[0])
        w = min(lum.shape[1], mask.shape[1])
        lum = lum[:h, :w]
        mask = mask[:h, :w]
    sel_in = inner > 0.5
    return {
        "subjectSharp": round(float(lap[sel_in].mean()), 5) if sel_in.any() else 0.0,
        "subjectMean": round(float(lum[mask].mean()), 4) if mask.any() else 0.0,
        "backgroundSharp": round(float(lap[~sel_in].mean()), 5) if (~sel_in).any() else 0.0,
        "backgroundMean": round(float(lum[~mask].mean()), 4) if (~mask).any() else 0.0,
        "subjectFrac": round(float(mask.mean()), 4),
    }


def cmd_region(before, after, mask_path, out_json=None, crop_bottom_before=0):
    _, b, _ = _load_cropped(before, crop_bottom_before)
    _, a, _ = _load(after)
    mi = Image.open(mask_path).convert("RGBA")
    alpha = np.asarray(mi.crop((0, 0, mi.width, mi.height)))[..., 3].astype(np.float32) / 255.0
    if alpha.shape != b.shape[:2]:
        resized = Image.fromarray((alpha * 255).astype(np.uint8)).resize(
            (b.shape[1], b.shape[0]), Image.NEAREST)
        alpha = np.asarray(resized).astype(np.float32) / 255.0
    mask = alpha > 0.5
    before_stats = _region_stats(b, mask)
    after_stats = _region_stats(a, mask)
    deltas = {
        "subjectSharpGain": round(
            after_stats["subjectSharp"] / before_stats["subjectSharp"], 3)
        if before_stats["subjectSharp"] else 0.0,
        "backgroundSharpGain": round(
            after_stats["backgroundSharp"] / before_stats["backgroundSharp"], 3)
        if before_stats["backgroundSharp"] else 0.0,
        "subjectMeanDelta": round(after_stats["subjectMean"] - before_stats["subjectMean"], 4),
        "backgroundMeanDelta": round(after_stats["backgroundMean"] - before_stats["backgroundMean"], 4),
    }
    result = {
        "ok": True,
        "before": before_stats,
        "after": after_stats,
        "deltas": deltas,
        "maskPath": mask_path,
    }
    if out_json:
        os.makedirs(os.path.dirname(out_json), exist_ok=True)
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    return result


def main(argv):
    if len(argv) < 2:
        print(json.dumps({"ok": False, "error": "missing command"}))
        return 2
    cmd = argv[1]
    try:
        if cmd == "info":
            result = cmd_info(argv[2])
        elif cmd == "assess":
            result = cmd_assess(argv[2])
        elif cmd == "orient":
            args = {}
            i = 2
            while i < len(argv) - 1:
                if argv[i].startswith("--"):
                    args[argv[i][2:]] = argv[i + 1]
                    i += 2
                else:
                    i += 1
            result = cmd_orient(args["input"], args["output"])
        elif cmd == "measure":
            crop_bottom = 0
            if "--crop-bottom" in argv:
                crop_bottom = int(argv[argv.index("--crop-bottom") + 1])
            result = cmd_measure(argv[2], crop_bottom)
        elif cmd == "compare":
            args = {}
            i = 2
            while i < len(argv) - 1:
                if argv[i].startswith("--"):
                    args[argv[i][2:]] = argv[i + 1]
                    i += 2
                else:
                    i += 1
            result = cmd_compare(
                args["before"], args["after"], args["out"],
                out_json=args.get("json"),
                label_before=args.get("label-before", "before"),
                label_after=args.get("label-after", "after"),
                crop_bottom_before=int(args.get("crop-bottom-before", 0) or 0),
            )
        elif cmd == "region":
            args = {}
            i = 2
            while i < len(argv) - 1:
                if argv[i].startswith("--"):
                    args[argv[i][2:]] = argv[i + 1]
                    i += 2
                else:
                    i += 1
            result = cmd_region(
                args["before"], args["after"], args["mask"],
                out_json=args.get("json"),
                crop_bottom_before=int(args.get("crop-bottom-before", 0) or 0),
            )
        else:
            result = {"ok": False, "error": "unknown command: " + cmd}
            print(json.dumps(result, ensure_ascii=False))
            return 2
    except Exception as exc:  # noqa: BLE001 - surface any failure as JSON
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
