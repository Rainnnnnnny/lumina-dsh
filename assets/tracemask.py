"""Default manual-trace mask workflow helper.

Step 1 (guide):  python tracemask.py guide --input img --region x,y,w,h --out-dir D [--zoom 2] [--grid 25]
    -> D/trace-guide.png  (zoomed region with source-coordinate grid, for hand tracing)
    -> D/trace-tiles/     (2x2 zoom tiles at higher magnification if needed)

Step 2 (build):  python tracemask.py build --input img --polygon coarse.json --out-dir D
        [--crop-bottom 149] [--step 2] [--radius 8] [--iterations 3] [--max-shift 15]
        [--out-step 2] [--max-points 2500] [--tiles 5]
    -> runs hardtrace (edge snapping) + tile polygonisation (add/sub with holes)
    -> D/polygon-dense.json, D/mask-tiles.json, D/mask-preview.png

Step 3 (alpha, channel mask):  python tracemask.py alpha --input img --mask mask-refined.png --out-dir D
        [--crop-bottom 149] [--band 16] [--core 2] [--blur 14] [--hair-lum 0.30] [--bright-cut 0.6]
    -> hair-aware soft alpha from the pixel-level mask (alphamatte.py)
    -> D/alpha.png (grayscale) + D/alpha-cutout.png (RGBA: content + soft alpha)
    -> pass D/alpha-cutout.png as params.layers.mask.alphaFile with mask.mode="alpha"

The coarse polygon is a list of [x, y] pairs in *content* pixel coordinates (the
image after the optional bottom-strip crop).
"""
import json
import os
import subprocess
import sys

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def _args(argv):
    out = {}
    i = 1
    while i < len(argv) - 1:
        if argv[i].startswith('--'):
            out[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return out


def cmd_guide(a):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    src = Image.open(a['input']).convert('RGB')
    W, H = src.size
    hb = [int(v) for v in a.get('crop-bottom', '149').split(',')[0:1][0:1][0:1] or [149]]
    crop_bottom = int(a.get('crop-bottom', 149))
    content = src.crop((0, 0, W, H - crop_bottom)) if crop_bottom > 0 else src
    out_dir = a['out-dir']
    os.makedirs(out_dir, exist_ok=True)

    if 'region' in a:
        x, y, w, h = [int(v) for v in a['region'].split(',')]
    else:
        x, y, w, h = 0, 0, content.width, content.height

    zoom = float(a.get('zoom', 2.0))
    grid = int(a.get('grid', 25))
    max_dim = int(a.get('max-dim', 2000))
    scale = min(zoom, max_dim / max(w, h))
    ow, oh = int(w * scale), int(h * scale)
    view = content.crop((x, y, x + w, y + h)).resize((ow, oh), Image.LANCZOS)
    dr = ImageDraw.Draw(view)
    font_path = 'C:/Windows/Fonts/msyh.ttc'
    try:
        font = ImageFont.truetype(font_path, 16)
    except Exception:
        font = ImageFont.load_default()
    for gx in range((x // grid) * grid, x + w + 1, grid):
        px = int((gx - x) * scale)
        if 0 <= px < ow:
            major = gx % (grid * 4) == 0
            dr.line([(px, 0), (px, oh)], fill=(255, 120, 120) if major else (120, 150, 220), width=1)
            if major:
                dr.text((px + 2, 2), str(gx), fill=(255, 150, 130), font=font)
    for gy in range((y // grid) * grid, y + h + 1, grid):
        py = int((gy - y) * scale)
        if 0 <= py < oh:
            major = gy % (grid * 4) == 0
            dr.line([(0, py), (ow, py)], fill=(255, 120, 120) if major else (120, 150, 220), width=1)
            if major:
                dr.text((2, py + 1), str(gy), fill=(255, 150, 130), font=font)
    guide = os.path.join(out_dir, 'trace-guide.png')
    view.save(guide)

    # 2x2 tiles for extra magnification
    tdir = os.path.join(out_dir, 'trace-tiles')
    os.makedirs(tdir, exist_ok=True)
    tiles = []
    tz = float(a.get('tile-zoom', 3.0))
    tw, th = w // 2, h // 2
    for ty in range(2):
        for tx in range(2):
            bx, by = x + tx * tw, y + ty * th
            # expand a little to keep context at tile borders
            ex, ey = 40, 40
            bx0, by0 = max(0, bx - ex), max(0, by - ey)
            bx1, by1 = min(content.width, bx + tw + ex), min(content.height, by + th + ey)
            s = min(tz, 1900 / max(1, (bx1 - bx0)), 1900 / max(1, (by1 - by0)))
            tv = content.crop((bx0, by0, bx1, by1)).resize((int((bx1 - bx0) * s), int((by1 - by0) * s)), Image.LANCZOS)
            d2 = ImageDraw.Draw(tv)
            for gx in range((bx0 // grid) * grid, bx1 + 1, grid):
                px = int((gx - bx0) * s)
                if 0 <= px < tv.width:
                    d2.line([(px, 0), (px, tv.height)], fill=(255, 120, 120), width=1)
                    d2.text((px + 2, 2), str(gx), fill=(255, 150, 130), font=font)
            for gy in range((by0 // grid) * grid, by1 + 1, grid):
                py = int((gy - by0) * s)
                if 0 <= py < tv.height:
                    d2.line([(0, py), (tv.width, py)], fill=(255, 120, 120), width=1)
                    d2.text((2, py + 1), str(gy), fill=(255, 150, 130), font=font)
            p = os.path.join(tdir, f'tile-{ty}{tx}.png')
            tv.save(p)
            tiles.append(p)
    print(json.dumps({'ok': True, 'guide': guide, 'tiles': tiles, 'size': [ow, oh],
                      'sourceRegion': [x, y, w, h], 'contentHeight': content.height}, ensure_ascii=False))


def cmd_build(a):
    out_dir = a['out-dir']
    os.makedirs(out_dir, exist_ok=True)
    dense = os.path.join(out_dir, 'polygon-dense.json')
    crop_bottom = a.get('crop-bottom', '149')
    cmd = [PY, os.path.join(HERE, 'hardtrace.py'),
           '--input', a['input'], '--polygon', a['polygon'], '--out', dense,
           '--crop-bottom', crop_bottom,
           '--step', a.get('step', '2'), '--radius', a.get('radius', '8'),
           '--iterations', a.get('iterations', '3'), '--max-shift', a.get('max-shift', '15'),
           '--out-step', a.get('out-step', '2'), '--max-points', a.get('max-points', '2500'),
           '--preview', os.path.join(out_dir, 'trace-snap-preview.png')]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(json.dumps({'ok': False, 'stage': 'hardtrace', 'error': (r.stdout + r.stderr)[:800]}, ensure_ascii=False))
        return
    trace = json.loads(r.stdout.strip().splitlines()[-1])

    tiles_json = os.path.join(out_dir, 'mask-tiles.json')
    cmd = [PY, os.path.join(HERE, 'tilepoly.py'), '--polygon', dense, '--out', tiles_json,
           '--tiles', a.get('tiles', '5'), '--max-points', '900',
           '--size', a.get('size', '3440,1429')]
    r2 = subprocess.run(cmd, capture_output=True, text=True)
    if r2.returncode != 0:
        print(json.dumps({'ok': False, 'stage': 'tilepoly', 'error': (r2.stdout + r2.stderr)[:800]}, ensure_ascii=False))
        return
    tiles = json.loads(r2.stdout.strip().splitlines()[-1])
    print(json.dumps({'ok': True, 'dense': dense, 'denseStats': trace, 'tiles': tiles_json,
                      'tilesStats': tiles}, ensure_ascii=False))


def cmd_alpha(a):
    """Soft alpha (channel mask) from a pixel-level mask, plus an RGBA cutout."""
    import numpy as np
    from PIL import Image

    out_dir = a['out-dir']
    os.makedirs(out_dir, exist_ok=True)
    alpha_png = os.path.join(out_dir, 'alpha.png')
    cmd = [PY, os.path.join(HERE, 'alphamatte.py'),
           '--input', a['input'], '--mask', a['mask'], '--out', alpha_png,
           '--band', a.get('band', '16'), '--core', a.get('core', '2'),
           '--blur', a.get('blur', '14'), '--hair-lum', a.get('hair-lum', '0.30'),
           '--bright-cut', a.get('bright-cut', '0.6')]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(json.dumps({'ok': False, 'stage': 'alphamatte',
                          'error': (r.stdout + r.stderr)[:800]}, ensure_ascii=False))
        return
    try:
        stats = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        stats = {}

    crop_bottom = int(a.get('crop-bottom', 149))
    rgb = Image.open(a['input']).convert('RGB')
    W, H = rgb.size
    content = rgb.crop((0, 0, W, H - crop_bottom)) if crop_bottom > 0 else rgb
    alpha = Image.open(alpha_png).convert('L')
    if alpha.size != content.size:
        print(json.dumps({'ok': False, 'stage': 'size',
                          'error': f'alpha {alpha.size} != content {content.size}'}, ensure_ascii=False))
        return
    cutout = os.path.join(out_dir, 'alpha-cutout.png')
    rgba = content.convert('RGBA')
    rgba.putalpha(alpha)
    rgba.save(cutout)

    arr = np.asarray(alpha).astype(np.float32) / 255.0
    print(json.dumps({
        'ok': True,
        'alpha': alpha_png,
        'cutout': cutout,
        'softPixels': int(((arr > 0.02) & (arr < 0.98)).sum()),
        'maskAreaPct': round(float((arr > 0.5).mean()) * 100, 3),
        'recoveredOutsideMask': stats.get('recoveredOutsideMask'),
        'alphamatte': stats,
    }, ensure_ascii=False))


def main(argv):
    if len(argv) < 2 or argv[1] not in ('guide', 'build', 'alpha'):
        print(json.dumps({'ok': False, 'error': 'usage: tracemask.py guide|build|alpha ...'}))
        return 2
    a = _args(argv)
    if argv[1] == 'guide':
        cmd_guide(a)
    elif argv[1] == 'alpha':
        cmd_alpha(a)
    else:
        cmd_build(a)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
