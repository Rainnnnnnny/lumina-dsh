"""Refine a snapped polygon mask by removing background-connected colour regions.

Hardtrace can snap onto foliage/branches behind thin hair. This script:
  1. rasterises the dense polygon,
  2. classifies "background-ish" colour (e.g. orange/red autumn leaves),
  3. floods that colour from the image border (so only regions connected to the
     outside are removed; isolated same-colour details on the character stay),
  4. writes the refined mask + per-tile add/sub polygons (maskcompose helpers).

Usage:
  python maskrefine.py --input orig.png --polygon dense.json --out-dir D
      [--tiles 5] [--max-points 900] [--rules orange] [--preview box]
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import maskcompose as mc  # noqa: E402

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def args_of(argv):
    a = {}
    i = 1
    while i < len(argv) - 1:
        if argv[i].startswith('--'):
            a[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return a


def background_colour(rgb, rules):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    out = np.zeros(rgb.shape[:2], dtype=bool)
    if 'orange' in rules:
        # autumn leaves / warm tree bark: red-dominant, include darker leaves
        out |= (r - b > 0.10) & (r > 0.20) & (g > 0.08) & (r >= g)
    return out


def box_blur(a, r):
    """Fast box blur over the first two axes."""
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


def flood_from_seed(candidate, seeds):
    """8-connected flood fill of `candidate` starting from `seeds`."""
    h, w = candidate.shape
    seen = np.zeros_like(candidate)
    stack = [tuple(p) for p in zip(*np.nonzero(seeds & candidate))]
    for y, x in stack:
        seen[y, x] = True
    while stack:
        y, x = stack.pop()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and candidate[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
    return seen


def colour_model_clean(mask, img, iterations=2, blur_r=10):
    """Remove mask pixels that look like the local background, starting from the
    mask edge (the bright-rim fix). Iterating lets the boundaries settle."""
    m = mask.copy()
    for _ in range(max(1, iterations)):
        fg_w = mc.erode(m, 4).astype(np.float32)
        bg_w = (~mc.dilate(m, 5)).astype(np.float32)
        ftw = box_blur(fg_w, blur_r)
        btw = box_blur(bg_w, blur_r)
        fg = np.stack([box_blur(img[..., c] * fg_w, blur_r) for c in range(3)], -1) / np.maximum(ftw, 1e-4)[..., None]
        bg = np.stack([box_blur(img[..., c] * bg_w, blur_r) for c in range(3)], -1) / np.maximum(btw, 1e-4)[..., None]
        d_fg = ((img - fg) ** 2).sum(-1)
        d_bg = ((img - bg) ** 2).sum(-1)
        bg_like = m & (d_bg < d_fg * 1.10)
        edge = m & ~mc.erode(m, 2)
        remove = flood_from_seed(bg_like, edge & bg_like)
        if not remove.any():
            break
        m = m & ~remove
    return m


def flood_from_border(candidate):
    h, w = candidate.shape
    seen = np.zeros_like(candidate)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if candidate[y, x] and not seen[y, x]:
                seen[y, x] = True
                stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if candidate[y, x] and not seen[y, x]:
                seen[y, x] = True
                stack.append((y, x))
    while stack:
        y, x = stack.pop()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and candidate[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
    return seen


def main(argv):
    a = args_of(argv)
    out_dir = a['out-dir']
    os.makedirs(out_dir, exist_ok=True)
    poly = json.load(open(a['polygon'], encoding='utf-8'))
    img = np.asarray(Image.open(a['input']).convert('RGB')).astype(np.float32) / 255.0

    mask = mc.raster_polygon(poly)
    # align the image to the mask canvas (the pipeline crops the bottom UI strip)
    img = img[:mask.shape[0], :mask.shape[1]]
    H, W = img.shape[:2]
    rules = a.get('rules', 'orange')

    bg_colour = background_colour(img, rules)
    bg_connected = flood_from_border(bg_colour)
    refined = mask & ~bg_connected

    # --- colour-model cleanup: remove background-looking pixels connected to --
    # the mask edge (this is what causes bright rims: the subject layer gets
    # brightened but the mask accidentally contains a band of background).
    if 'bg-clean' in a.get('rules', ''):
        refined = colour_model_clean(refined, img, iterations=int(a.get('bg-clean-iterations', 2)))

    # close 1-px pin-holes created by the removal + smooth ragged cuts so the
    # polygon count stays sane and the mask does not look speckled
    refined = mc.erode(mc.dilate(refined, 1), 1)
    if 'region-hard-sub' in a:
        refined = mc.erode(mc.dilate(refined, 2), 2)
        # fill small enclosed holes (speck noise from the colour cuts)
        inv = ~refined
        ys, xs = np.nonzero(inv)
        seen = np.zeros_like(inv)
        hb = [int(v) for v in a['region-hard-sub'].split(';')[0].split(',')]
        for yy, xx in zip(ys, xs):
            if seen[yy, xx] or not (hb[1] <= yy < hb[3] and hb[0] <= xx < hb[2]):
                continue
            comp = mc.label_component(inv, (int(yy), int(xx)))
            seen |= comp
            if int(comp.sum()) < int(a.get('hole-fill', 120)):
                refined |= comp

    # --- hard removal inside explicit regions -------------------------------
    # For areas where hardtrace swallowed midground foliage/branches: drop
    # "warm dark" pixels unconditionally inside the given boxes. Teal hair,
    # white armour, green cloth and bright skin are not "warm dark", so they
    # survive; orange leaves and brown branches do not.
    if 'region-hard-sub' in a:
        r, g, b = img[..., 0], img[..., 1], img[..., 2]
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        warm_dark = (r - b > 0.05) & (r > 0.15) & (lum < 0.50)
        min_area = int(a.get('hard-sub-min', 300))
        for spec in a['region-hard-sub'].split(';'):
            if not spec.strip():
                continue
            bx0, by0, bx1, by1 = [int(v) for v in spec.split(',')]
            box = np.zeros_like(refined)
            box[by0:by1, bx0:bx1] = True
            cand = warm_dark & refined & box
            ys, xs = np.nonzero(cand)
            seen = np.zeros_like(cand)
            for yy, xx in zip(ys, xs):
                if seen[yy, xx]:
                    continue
                comp = mc.label_component(cand, (int(yy), int(xx)))
                seen |= comp
                if int(comp.sum()) >= min_area:
                    refined &= ~comp

    removed = int((mask & bg_connected).sum())
    Image.fromarray((refined * 255).astype(np.uint8)).save(os.path.join(out_dir, 'mask-refined.png'))

    # optional visual check crop
    if 'check-box' in a:
        x0, y0, x1, y1 = [int(v) for v in a['check-box'].split(',')]
        scale = float(a.get('check-scale', 1.0))
        content = Image.open(a['input']).convert('RGB').crop((0, 0, W, H))
        arr = np.asarray(content).astype(np.float32) / 255.0
        m = refined[y0:y1, x0:x1]
        a2 = arr[y0:y1, x0:x1].copy()
        a2[m] = a2[m] * 0.45 + np.array([0.2, 1.0, 0.4]) * 0.55
        im = Image.fromarray((np.clip(a2, 0, 1) * 255).astype(np.uint8))
        ow, oh = int((x1 - x0) * scale), int((y1 - y0) * scale)
        im = im.resize((ow, oh), Image.LANCZOS)
        im.save(os.path.join(out_dir, 'mask-refined-check.png'))

    # --- tile polygons with holes -----------------------------------------
    tiles = int(a.get('tiles', 5))
    max_pts = int(a.get('max-points', 900))
    simplify = float(a.get('simplify', '0.7'))
    min_loop_area = float(a.get('min-loop-area', 60))
    tw, th = W / tiles, H / tiles
    adds, subs = [], []
    recon = np.zeros((H, W), dtype=bool)
    for ty in range(tiles):
        for tx in range(tiles):
            x0, y0 = round(tx * tw), round(ty * th)
            x1, y1 = round((tx + 1) * tw), round((ty + 1) * th)
            tm = refined[y0:y1, x0:x1]
            if not tm.any():
                continue
            ta, ts = [], []
            for loop in mc.trace_loops(tm):
                if len(loop) < 4:
                    continue
                simp = mc.rdp(loop, simplify)
                if len(simp) < 3:
                    continue
                arr = np.asarray(simp, dtype=np.float64)
                area = abs(float(np.dot(arr[:, 0], np.roll(arr[:, 1], -1)) - np.dot(arr[:, 1], np.roll(arr[:, 0], -1)))) / 2.0
                if area < min_loop_area:
                    continue
                pts = [[round(x + x0, 1), round(y + y0, 1)] for x, y in simp]
                if len(pts) > max_pts:
                    idx = np.linspace(0, len(pts) - 1, max_pts).astype(int)
                    pts = [pts[i] for i in idx]
                entry = {'points': pts, 'op': 'add' if mc.loop_is_outer(loop, tm) else 'sub'}
                (ta if entry['op'] == 'add' else ts).append(entry)
                scratch = Image.new('L', (x1 - x0, y1 - y0), 0)
                ImageDraw.Draw(scratch).polygon([(x, y) for x, y in simp], fill=255)
                mm = np.asarray(scratch) > 127
                if entry['op'] == 'add':
                    recon[y0:y1, x0:x1] |= mm
                else:
                    recon[y0:y1, x0:x1] &= ~mm
            adds.extend(ta)
            subs.extend(ts)
    polygons = adds + subs

    inter = (recon & refined).sum()
    union = (recon | refined).sum()
    json.dump(polygons, open(os.path.join(out_dir, 'mask-tiles.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print(json.dumps({
        'ok': True,
        'removedBackgroundPx': removed,
        'maskAreaPct': round(float(refined.mean()) * 100, 3),
        'reconIoU': round(float(inter) / max(1, union), 4),
        'polygons': len(polygons),
        'add': len(adds),
        'sub': len(subs),
        'totalPoints': sum(len(p['points']) for p in polygons),
        'outDir': out_dir,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
