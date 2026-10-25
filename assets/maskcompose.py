"""Compose a pixel-accurate subject mask and emit per-tile polygons for PS.

Head/antler problem area:
  * outside the head bbox -> manual dense contour polygon (rasterized)
  * inside the head bbox  -> colour/luminance segmentation of the character
    (antlers/hair are dark or red vs the bright bluish sky; the glow is cut by
    the luminance threshold), kept as the component connected to the hair crown.

The final mask is cut into NxN tiles; each tile's pixel boundary loops become
polygons (outer loops = add, holes = sub), so Photoshop rebuilds the exact mask
via EXTEND/DIMINISH without hitting the single-polygon point limit.

Outputs in --out-dir: mask-final.png, mask-tiles.json, stats on stdout.
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


W, H = 3440, 1429


def raster_polygon(poly):
    img = Image.new('L', (W, H), 0)
    ImageDraw.Draw(img).polygon([(p[0], p[1]) for p in poly], fill=255)
    return np.asarray(img) > 127


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


def fill_holes(mask, box):
    """Fill background holes enclosed by `mask` inside `box` (unreachable from the box border)."""
    from collections import deque

    ys, xs = np.nonzero(box)
    if not len(ys):
        return mask
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    bg = (~mask) & box
    seen = np.zeros_like(mask)
    dq = deque()
    for x in range(x0, x1 + 1):
        for y in (y0, y1):
            if bg[y, x] and not seen[y, x]:
                seen[y, x] = True
                dq.append((y, x))
    for y in range(y0, y1 + 1):
        for x in (x0, x1):
            if bg[y, x] and not seen[y, x]:
                seen[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if y0 <= ny <= y1 and x0 <= nx <= x1 and bg[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    dq.append((ny, nx))
    holes = bg & ~seen
    return mask | holes


def label_component(mask, seed):
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return np.zeros_like(mask)
    seen = np.zeros_like(mask)
    sy, sx = seed
    if not (0 <= sy < mask.shape[0] and 0 <= sx < mask.shape[1] and mask[sy, sx]):
        d = (ys - sy) ** 2 + (xs - sx) ** 2
        i = int(np.argmin(d))
        sy, sx = int(ys[i]), int(xs[i])
    stack = [(sy, sx)]
    while stack:
        y, x = stack.pop()
        if seen[y, x]:
            continue
        seen[y, x] = True
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                    stack.append((ny, nx))
    return seen


def trace_loops(m):
    """Ordered pixel-boundary loops of a binary mask, mask kept on the left."""
    h, w = m.shape
    edges = {}

    def add(a, b):
        edges.setdefault(a, []).append(b)

    for y in range(h):
        row = m[y]
        for x in range(w):
            if not row[x]:
                continue
            if y == 0 or not m[y - 1, x]:
                add((x + 1, y), (x, y))
            if x == w - 1 or not row[x + 1]:
                add((x + 1, y + 1), (x + 1, y))
            if y == h - 1 or not m[y + 1, x]:
                add((x, y + 1), (x + 1, y + 1))
            if x == 0 or not row[x - 1]:
                add((x, y), (x, y + 1))

    loops = []
    used = set()
    for start in list(edges.keys()):
        for first in list(edges[start]):
            if (start, first) in used:
                continue
            loop = [start]
            cur, nxt = start, first
            while True:
                used.add((cur, nxt))
                loop.append(nxt)
                if nxt == start:
                    break
                cur = nxt
                outs = [c for c in edges.get(cur, []) if (cur, c) not in used]
                if not outs:
                    break
                mid = loop[-2]
                dx, dy = cur[0] - mid[0], cur[1] - mid[1]
                prio = [(-dy, dx), (dx, dy), (dy, -dx), (-dx, -dy)]  # right, straight, left, back
                chosen = None
                for d in prio:
                    for c in outs:
                        if (c[0] - cur[0], c[1] - cur[1]) == d:
                            chosen = c
                            break
                    if chosen is not None:
                        break
                nxt = chosen if chosen is not None else outs[0]
            if len(loop) >= 4 and loop[-1] == start:
                loops.append(loop[:-1])
    return loops


def rdp(points, eps):
    if len(points) < 3:
        return points
    pts = np.asarray(points, dtype=np.float64)
    keep = [0]

    def simp(lo, hi):
        if hi <= lo + 1:
            return
        a, b = pts[lo], pts[hi]
        ab = b - a
        n = np.hypot(ab[0], ab[1])
        seg = pts[lo + 1:hi]
        if n == 0:
            d = np.hypot(seg[:, 0] - a[0], seg[:, 1] - a[1])
        else:
            d = np.abs(ab[0] * (a[1] - seg[:, 1]) - ab[1] * (a[0] - seg[:, 0])) / n
        i = int(np.argmax(d))
        if d[i] > eps:
            idx = lo + 1 + i
            simp(lo, idx)
            keep.append(idx)
            simp(idx, hi)

    simp(0, len(pts) - 1)
    keep.append(len(pts) - 1)
    keep = sorted(set(keep))
    return [points[i] for i in keep]


def loop_is_outer(loop, tile_mask):
    h, w = tile_mask.shape
    scratch = Image.new('L', (w, h), 0)
    ImageDraw.Draw(scratch).polygon([(x, y) for x, y in loop], fill=255)
    inside = np.asarray(scratch) > 127
    n_in = int(inside.sum())
    if n_in == 0:
        return True
    return float(tile_mask[inside].mean()) > 0.5


def main(argv):
    args = {}
    i = 1
    while i < len(argv) - 1:
        if argv[i].startswith('--'):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1

    out_dir = args.get('out-dir', '.')
    poly = json.load(open(args['polygon'], encoding='utf-8'))
    manual = raster_polygon(poly)

    hb = [int(v) for v in args.get('head-bbox', '1380,660,1770,900').split(',')]
    hx0, hy0, hx1, hy1 = hb
    orig = np.asarray(Image.open(args['input']).convert('RGB').crop((0, 0, W, H))).astype(np.float32) / 255.0
    lum = 0.2126 * orig[..., 0] + 0.7152 * orig[..., 1] + 0.0722 * orig[..., 2]
    r, g, b = orig[..., 0], orig[..., 1], orig[..., 2]
    char = (lum < 0.885) | ((r - b > 0.05) & (r > g + 0.01))
    char = erode(dilate(char, 1), 1)
    region = np.zeros((H, W), dtype=bool)
    region[hy0:hy1, hx0:hx1] = True
    char_region = char & region
    sx, sy = [int(v) for v in args.get('seed', '1550,880').split(',')]
    comp = label_component(char_region, (sy, sx))

    final = manual.copy()
    final[hy0:hy1, hx0:hx1] = False
    final[hy0:hy1, hx0:hx1] = comp[hy0:hy1, hx0:hx1]

    # --- hair regions: replace the coarse contour with a per-pixel matte ---
    # Inside a hair region the subject is dark (hair/clothes) against bright sky,
    # mist, foliage or rock, so a luminance threshold + connected component gives
    # a pixel-accurate silhouette including 2-4 px hair strands, while the coarse
    # polygon would swallow the bright background between strands (-> halos).
    dark_thr = float(args.get('dark-threshold', '0.42'))
    hair_regions = [v for v in str(args.get('hair-regions', '')).split(';') if v.strip()]
    hair_seeds = [v for v in str(args.get('hair-seeds', '')).split(';') if v.strip()]
    dark = lum < dark_thr
    dark = erode(dilate(dark, 1), 1)
    near_manual = dilate(manual, int(args.get('hair-grow', 4)))
    for idx, spec in enumerate(hair_regions):
        hx0b, hy0b, hx1b, hy1b = [int(v) for v in spec.split(',')]
        box = np.zeros((H, W), dtype=bool)
        box[hy0b:hy1b, hx0b:hx1b] = True
        seed = (int(hair_seeds[idx].split(',')[0]), int(hair_seeds[idx].split(',')[1])) \
            if idx < len(hair_seeds) else ((hx0b + hx1b) // 2, (hy0b + hy1b) // 2)
        comp_h = label_component(dark & box, seed)
        # keep dark strand pixels only near the original silhouette, then merge
        # with the previous mask so solid body parts inside the box are kept
        strand = comp_h & near_manual
        # fill enclosed holes (highlight pixels inside a strand mass) while
        # keeping gaps that connect to the box border (real background)
        strand = fill_holes(strand, box)
        keep = final.copy()
        final[hy0b:hy1b, hx0b:hx1b] = False
        final[hy0b:hy1b, hx0b:hx1b] = (strand | (keep & dark))[hy0b:hy1b, hx0b:hx1b]

    # --- manual add/sub polygon edits (hand-traced regions) ---
    # JSON: [{"op":"sub","points":[[x,y],...]}, {"op":"add",...}]
    edits_file = args.get('manual-edits')
    if edits_file:
        edits = json.load(open(edits_file, encoding='utf-8-sig'))
        for ed in edits:
            pts = [(float(p[0]), float(p[1])) for p in ed['points']]
            scratch = Image.new('L', (W, H), 0)
            ImageDraw.Draw(scratch).polygon(pts, fill=255)
            reg = np.asarray(scratch) > 127
            if ed.get('op', 'add') == 'sub':
                final &= ~reg
            else:
                final |= reg

    final = erode(dilate(final, 1), 1)
    Image.fromarray((final * 255).astype(np.uint8)).save(out_dir + '/mask-final.png')

    tiles = int(args.get('tiles', 5))
    max_pts = int(args.get('max-points', 900))
    simplify = float(args.get('simplify', '0.7'))
    tw, th = W / tiles, H / tiles
    adds, subs = [], []
    recon = np.zeros((H, W), dtype=bool)
    for ty in range(tiles):
        for tx in range(tiles):
            x0, y0 = round(tx * tw), round(ty * th)
            x1, y1 = round((tx + 1) * tw), round((ty + 1) * th)
            tm = final[y0:y1, x0:x1]
            if not tm.any():
                continue
            tile_add, tile_sub = [], []
            for loop in trace_loops(tm):
                if len(loop) < 4:
                    continue
                simp = rdp(loop, simplify)
                if len(simp) < 3:
                    continue
                pts = [[round(x + x0, 1), round(y + y0, 1)] for x, y in simp]
                if len(pts) > max_pts:
                    idx = np.linspace(0, len(pts) - 1, max_pts).astype(int)
                    pts = [pts[i] for i in idx]
                entry = {'points': pts, 'op': 'add' if loop_is_outer(loop, tm) else 'sub'}
                (tile_add if entry['op'] == 'add' else tile_sub).append(entry)
                scratch = Image.new('L', (x1 - x0, y1 - y0), 0)
                ImageDraw.Draw(scratch).polygon([(x, y) for x, y in simp], fill=255)
                m = np.asarray(scratch) > 127
                if entry['op'] == 'add':
                    recon[y0:y1, x0:x1] |= m
                else:
                    recon[y0:y1, x0:x1] &= ~m
            adds.extend(tile_add)
            subs.extend(tile_sub)

    polygons = adds + subs
    inter = (recon & final).sum()
    union = (recon | final).sum()
    iou = float(inter) / float(union) if union else 0.0
    json.dump(polygons, open(out_dir + '/mask-tiles.json', 'w', encoding='utf-8'), ensure_ascii=False)
    print(json.dumps({
        'ok': True,
        'maskAreaPct': round(float(final.mean()) * 100, 3),
        'reconIoU': round(iou, 4),
        'polygons': len(polygons),
        'add': len(adds),
        'sub': len(subs),
        'totalPoints': sum(len(p['points']) for p in polygons),
        'maxPoints': max((len(p['points']) for p in polygons), default=0),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)
