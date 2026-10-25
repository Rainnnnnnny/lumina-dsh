"""Split a dense contour into tile polygons so each stays under Photoshop's
~1000-point polygon-selection limit, then union them via SelectionType.EXTEND.

Approach: clip the ordered dense ring against each tile rectangle with
Sutherland-Clipping. Each clipped polygon's boundary inside the tile is exact; the
segments added along the tile edges are shared between neighbours, so the union of
all tiles reproduces the original region exactly (PS unions them without seams).

Usage:
  python tilepoly.py --polygon <dense.json> --out <tiles.json>
      [--tiles 3] [--max-points 900] [--size 3440,1429]
Prints JSON stats.
"""
import json
import sys

import numpy as np

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def clip_edge(points, inside, intersect):
    out = []
    n = len(points)
    if n == 0:
        return out
    for i in range(n):
        cur = points[i]
        prev = points[i - 1]
        cur_in = inside(cur)
        prev_in = inside(prev)
        if cur_in:
            if not prev_in:
                out.append(intersect(prev, cur))
            out.append(cur)
        elif prev_in:
            out.append(intersect(prev, cur))
    return out


def clip_rect(points, xmin, ymin, xmax, ymax):
    pts = [tuple(map(float, p)) for p in points]
    pts = clip_edge(
        pts,
        lambda p: p[0] >= xmin,
        lambda a, b: (xmin, a[1] + (b[1] - a[1]) * (xmin - a[0]) / (b[0] - a[0]) if b[0] != a[0] else a[1]),
    )
    pts = clip_edge(
        pts,
        lambda p: p[0] <= xmax,
        lambda a, b: (xmax, a[1] + (b[1] - a[1]) * (xmax - a[0]) / (b[0] - a[0]) if b[0] != a[0] else a[1]),
    )
    pts = clip_edge(
        pts,
        lambda p: p[1] >= ymin,
        lambda a, b: (a[0] + (b[0] - a[0]) * (ymin - a[1]) / (b[1] - a[1]) if b[1] != a[1] else a[0], ymin),
    )
    pts = clip_edge(
        pts,
        lambda p: p[1] <= ymax,
        lambda a, b: (a[0] + (b[0] - a[0]) * (ymax - a[1]) / (b[1] - a[1]) if b[1] != a[1] else a[0], ymax),
    )
    return pts


def decimate(points, max_points):
    if len(points) <= max_points:
        return points
    idx = np.linspace(0, len(points) - 1, max_points).astype(int)
    return [points[i] for i in idx]


def polygon_area(points):
    p = np.asarray(points, dtype=np.float64)
    if len(p) < 3:
        return 0.0
    x, y = p[:, 0], p[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)


def main(argv):
    args = {}
    i = 1
    while i < len(argv) - 1:
        if argv[i].startswith("--"):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1

    poly = json.load(open(args["polygon"], encoding="utf-8"))
    if all(0 <= p[0] <= 1.5 and 0 <= p[1] <= 1.5 for p in poly):
        raise SystemExit("tilepoly expects absolute pixel coordinates")
    size = args.get("size", "3440,1429")
    W, H = [int(v) for v in size.split(",")]
    tiles = int(args.get("tiles", 3))
    max_points = int(args.get("max-points", 900))

    tile_w = W / tiles
    tile_h = H / tiles
    polygons = []
    stats = []
    for ty in range(tiles):
        for tx in range(tiles):
            x0 = round(tx * tile_w)
            y0 = round(ty * tile_h)
            x1 = round((tx + 1) * tile_w)
            y1 = round((ty + 1) * tile_h)
            clipped = clip_rect(poly, x0, y0, x1, y1)
            area = polygon_area(clipped)
            if len(clipped) < 3 or area < 4:
                continue
            clipped = decimate(clipped, max_points)
            pts = [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in clipped]
            polygons.append(pts)
            stats.append({"tile": [tx, ty], "points": len(pts), "area": round(area, 1)})

    json.dump(polygons, open(args["out"], "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps({
        "ok": True,
        "tiles": tiles,
        "sourcePoints": len(poly),
        "polygons": len(polygons),
        "maxTilePoints": max(s["points"] for s in stats),
        "totalPoints": sum(s["points"] for s in stats),
        "tileStats": stats,
        "outFile": args["out"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
