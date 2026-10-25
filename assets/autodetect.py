#!/usr/bin/env python
"""Quick scene analysis used by ps_grade --auto.

Outputs JSON on stdout:
  ok, width, height, stripPx, confidence,
  contentWidth, contentHeight, clipPct, washPct, mean, p50,
  skinCenterPct, skinBBoxFrac, style ('character'|'landscape'), reasons
"""
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from metrics import _load, _lum, _detect_strip  # noqa: E402
from hdrsynth import detect_wash, luma  # noqa: E402

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def _skin_mask(a):
    """Skin-ish pixels (anime/game pale skin) in 0..255 YCbCr + saturation gate."""
    r = a[..., 0] * 255.0
    g = a[..., 1] * 255.0
    b = a[..., 2] * 255.0
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b
    mx = a.max(axis=-1)
    mn = a.min(axis=-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    skin = (y > 70) & (cb > 80) & (cb < 125) & (cr > 136) & (cr < 170) & (sat < 0.42)
    return skin


def _downscale(mask, factor=16):
    h, w = mask.shape
    gh, gw = max(1, h // factor), max(1, w // factor)
    img = Image.fromarray((mask * 255.0).astype(np.uint8), 'L')
    small = np.asarray(img.resize((gw, gh), Image.BOX), dtype=np.float32) / 255.0
    return small


def _largest_component(grid):
    """4/8-connected largest blob on the coarse grid -> (size, cells)."""
    gh, gw = grid.shape
    seen = np.zeros_like(grid, dtype=bool)
    best_size, best_cells = 0, None
    for y in range(gh):
        row = grid[y]
        for x in range(gw):
            if not row[x] or seen[y, x]:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            cells = []
            while stack:
                cy, cx = stack.pop()
                cells.append((cy, cx))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < gh and 0 <= nx < gw and grid[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            if len(cells) > best_size:
                best_size, best_cells = len(cells), cells
    return best_size, best_cells


def analyze(path):
    im, a, fmt = _load(path)
    h, w = a.shape[:2]
    strip = int(_detect_strip(path).get('stripPx') or 0)
    content = a[:h - strip] if strip else a
    ch, cw = content.shape[:2]
    lum = luma(content)
    clip_pct = float((lum >= 0.985).mean() * 100.0)
    try:
        wash, core, compact, big = detect_wash(content, lum, 0.90, 0.012, 2)
        wash_pct = float((wash > 0.3).mean() * 100.0)
    except Exception:
        wash_pct = 0.0

    skin = _skin_mask(content)
    small = _downscale(skin, 16)
    grid = small > 0.30
    reasons = []
    style = 'landscape'
    center_pct = 0.0
    bbox_frac = 0.0
    blob_area_frac = 0.0
    gh, gw = grid.shape
    size, cells = _largest_component(grid)
    if cells:
        ys = np.array([c[0] for c in cells])
        xs = np.array([c[1] for c in cells])
        gx0, gx1 = int(xs.min()), int(xs.max()) + 1
        gy0, gy1 = int(ys.min()), int(ys.max()) + 1
        bbox_frac = float((gx1 - gx0) * (gy1 - gy0) / float(gw * gh))
        blob_area_frac = float(size / float(gw * gh))
        cx = (xs.mean() + 0.5) / gw
        cy = (ys.mean() + 0.5) / gh
        wfrac = (gx1 - gx0) / float(gw)
        hfrac = (gy1 - gy0) / float(gh)
        # skin density inside the blob's bbox (only there, to avoid sky/rock noise)
        px0, px1 = int(gx0 / gw * cw), max(int(gx1 / gw * cw), int(gx0 / gw * cw) + 1)
        py0, py1 = int(gy0 / gh * ch), max(int(gy1 / gh * ch), int(gy0 / gh * ch) + 1)
        center_pct = float(skin[py0:py1, px0:px1].mean() * 100.0)
        ok_center = 0.18 <= cx <= 0.82 and 0.08 <= cy <= 0.98
        if ok_center and 0.002 <= bbox_frac <= 0.30 and wfrac <= 0.52 and hfrac <= 0.90 \
                and center_pct >= 12.0 and blob_area_frac >= 0.0015:
            style = 'character'
            reasons.append('skin blob area %.1f%%, bbox %.1f%% at (%.2f,%.2f), density %.0f%%'
                           % (blob_area_frac * 100.0, bbox_frac * 100.0, cx, cy, center_pct))
        else:
            reasons.append('no compact skin blob (bbox %.1f%% at %.2f,%.2f, density %.0f%%)'
                           % (bbox_frac * 100.0, cx, cy, center_pct))
    else:
        reasons.append('no skin-like pixels')

    # sky/water heuristics: bright low-saturation sky on top, smooth low-sat water below
    def _norm01(arr):
        a = np.asarray(arr, dtype=np.float32)
        return a / 255.0 if a.size and float(a.max()) > 1.5 else a

    h, w = content.shape[:2]
    top = _norm01(content[: max(1, int(h * 0.35))])
    mx = top.max(axis=2); mn = top.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    lum = 0.2126 * top[..., 0] + 0.7152 * top[..., 1] + 0.0722 * top[..., 2]
    sky_top_pct = float(((lum > 0.72) & (sat < 0.22)).mean())
    bot = _norm01(content[int(h * 0.55):])
    bmx = bot.max(axis=2); bmn = bot.min(axis=2)
    bsat = np.where(bmx > 0, (bmx - bmn) / np.maximum(bmx, 1e-6), 0.0)
    blum = 0.2126 * bot[..., 0] + 0.7152 * bot[..., 1] + 0.0722 * bot[..., 2]
    water_pct = float(((bsat < 0.20) & (blum > 0.25) & (blum < 0.85)).mean())
    return {
        'ok': True,
        'skyTopPct': round(sky_top_pct, 4),
        'waterPct': round(water_pct, 4),
        'path': path,
        'width': w,
        'height': h,
        'stripPx': strip,
        'confidence': 'high' if strip else 'none',
        'contentWidth': cw,
        'contentHeight': ch,
        'clipPct': round(clip_pct, 2),
        'washPct': round(wash_pct, 2),
        'mean': round(float(lum.mean()), 4),
        'p50': round(float(np.percentile(lum, 50)), 4),
        'skinCenterPct': round(center_pct, 3),
        'skinBBoxFrac': round(bbox_frac, 4),
        'skinBlobAreaFrac': round(blob_area_frac, 4),
        'style': style,
        'reasons': reasons,
    }


def main(argv):
    if len(argv) < 2:
        print(json.dumps({'ok': False, 'error': 'usage: autodetect.py <image>'}, ensure_ascii=False))
        return 1
    try:
        payload = json.dumps(analyze(argv[1]), ensure_ascii=False)
        sys.stdout.buffer.write(payload.encode('utf-8') + b'\n')
        sys.stdout.buffer.flush()
        return 0
    except Exception as exc:  # pragma: no cover
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
