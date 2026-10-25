"""hdrsynth.py — 把 8-bit 图「画」成 HDR 版本（高光重建 + 逆色调映射 + HDR 输出）。

背景：8-bit 截图里超过/接近显示白的高光（天空、雾、灯、反光）细节已经不存在，**不能恢复**；
但可以基于邻域做**可信的“绘制”**：把“被洗白”的区域按连续权重合成云/雾状明暗与色偏、
给紧凑高光（灯、叶隙亮斑）加辉光，并把整张图反推成 HDR 辐射度，输出「HDR 观感」的 SDR
预览 + 真正的 HDR 文件（RGB16 线性 / RGB16 PQ / gainmap），即“把图像画成 HDR 版本”。

关键设计（避免“打补丁”脏块）：
  1. **连续 wash 权重**：w_wash = smoothstep((lum - 0.93)/0.07) × 平坦度权重。
     不用硬 mask 做区域替换，所以全图过渡连续、不会出现灰斑/接缝；
  2. **纹理合成**：分形噪声（固定种子）在 wash 权重上叠加云/雾状明暗层次与轻微色偏，
     把死白的天空/雾气变成有层次的亮部；
  3. **紧凑高光重建**：面积小、孤立的高光（灯、叶隙、反光）判定为 compact，
     保留其亮度并加暖色辉光（HDR bloom 的观感）；
  4. **HDR 反推**：已知区做逆色调映射（ITM），wash 区按权重扩展 >1.0 的宽容度，
     compact 高光给更高辐射度；输出 RGB16 线性 PNG、RGB16 PQ PNG、gain map、宽容度可视化；
  5. **HDR 观感调色**：轻微 S 曲线（压暗暗部/提亮高光）+ 饱和 + 辉光，得到 HDR-look 的 SDR 预览。

用法：
  python hdrsynth.py --input <原图> --out-dir <目录> [--crop-bottom 149]
      [--wash-lum 0.93] [--darken 0.10] [--texture 0.35] [--glow 0.45]
      [--contrast 0.10] [--sat 1.05] [--headroom 4.0] [--diffuse-nits 203]

输出（默认前缀 hdr-）：
  hdr-view.png         SDR 观感预览（HDR-look 的 8-bit 图，可直接再用 ps_grade 调色）
  hdr-linear16.png     RGB16 PNG，线性 BT.709（value = clip(lin/4.0)*65535，见 meta）
  hdr-pq16.png         RGB16 PNG，SMPTE ST2084 PQ / BT.709（diffuse white 203 nit，见 meta）
  hdr-gainmap.png      8-bit gain map（log2(HDR/SDR) 增益 0..2 stops）
  hdr-headroom.png     HDR 宽容度假彩色可视化
  hdr-washmask.png     洗白区权重可视化（红=最需要重建）
  hdr-meta.json        全部参数与指标
  hdr-qa.png           原图/重建 1:1 对比（高光区域）
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# numeric helpers (numpy only)
# --------------------------------------------------------------------------- #


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def srgb_to_linear(a):
    a = np.clip(a, 0.0, 1.0)
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(a):
    a = np.clip(a, 0.0, 1.0)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def box_blur(a, r):
    r = int(round(float(r)))
    if r < 1:
        return a.astype(np.float32)
    k = 2 * r + 1
    out = a.astype(np.float32)
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r + 1, r)
        p = np.pad(out, pad, mode='edge')
        cs = np.cumsum(p, axis=axis, dtype=np.float64)
        sl_hi = [slice(None)] * out.ndim
        sl_lo = [slice(None)] * out.ndim
        sl_hi[axis] = slice(k, k + out.shape[axis])
        sl_lo[axis] = slice(0, out.shape[axis])
        out = (cs[tuple(sl_hi)] - cs[tuple(sl_lo)]).astype(np.float32) / k
    return out


def gaussian_blur(a, sigma):
    if sigma < 0.5:
        return a.astype(np.float32)
    r = max(1, int(round(sigma * 0.85)))
    out = a.astype(np.float32)
    for _ in range(3):
        out = box_blur(out, r)
    return out


def resize_f(a, size, method=Image.BILINEAR):
    w, h = int(size[0]), int(size[1])
    if a.ndim == 2:
        return np.asarray(Image.fromarray(a.astype(np.float32), 'F').resize((w, h), method), dtype=np.float32)
    return np.stack([resize_f(a[..., c], (w, h), method) for c in range(a.shape[2])], axis=2)


def dilate(m, n=1):
    out = m
    for _ in range(n):
        p = np.pad(out, 1, mode='constant')
        out = (p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:])
    return out


def erode(m, n=1):
    out = m
    for _ in range(n):
        p = np.pad(out, 1, mode='constant')
        out = (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:])
    return out


def fractal_noise(shape, octaves=6, seed=7):
    """Smooth fractal value noise ~[-1, 1] (fixed seed -> reproducible)."""
    rng = np.random.default_rng(seed)
    h, w = shape
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        gh = max(2, h // (2 ** (octaves - 1 - o)))
        gw = max(2, w // (2 ** (octaves - 1 - o)))
        grid = rng.standard_normal((gh, gw)).astype(np.float32)
        out += resize_f(grid, (w, h), Image.BICUBIC) * amp
        total += amp
        amp *= 0.62
    out /= max(total, 1e-6)
    return np.clip(out, -2.5, 2.5) / 2.5



def load_brush_tip(path, work=180):
    """Load a brush-tip image -> alpha array (0..1). Supports RGBA or black-on-white L."""
    im = Image.open(path)
    if im.mode in ('RGBA', 'LA'):
        a = np.asarray(im.convert('RGBA'))[..., 3].astype(np.float32) / 255.0
        if a.max() < 0.01:
            g = np.asarray(im.convert('L')).astype(np.float32) / 255.0
            a = 1.0 - g
    else:
        g = np.asarray(im.convert('L')).astype(np.float32) / 255.0
        a = 1.0 - g
    a = np.clip(a, 0, 1)
    return resize_f(a, (work, work), Image.LANCZOS)


def brush_tip_variants(tip, angles=(0, 30, 60, 90, 120, 150)):
    """Pre-rotated versions of the brush tip (so strokes can follow any direction)."""
    out = []
    base = Image.fromarray((np.clip(tip, 0, 1) * 255).astype(np.uint8), 'L')
    for ang in angles:
        r = base.rotate(ang, expand=True, resample=Image.BICUBIC)
        a = np.asarray(r, dtype=np.float32) / 255.0
        out.append(a)
    return out

def fog_brush_field(lum, wash, seed=7, n_strokes=80, tip_path=None):
    """Procedural “mist brush”: soft dabs stroked along turbulence flow lines.

    Simulates painting fog with a soft brush: many soft round dabs, chained along
    flow lines of a smooth noise field, blurred and normalised to a **zero-mean**
    field so it only modulates local contrast inside the washed/misty area — it
    never shifts the area's average brightness (that is what created rim/halo
    artifacts in earlier versions).

    Returns a float32 field ~[-1, 1], shaped to the image.
    """
    import math
    h, w = lum.shape
    # work at half resolution: fog wisp detail is low frequency anyway (faster)
    h2, w2 = (h + 1) // 2, (w + 1) // 2
    lum2 = resize_f(lum, (w2, h2), Image.BILINEAR)
    wash2 = resize_f(wash, (w2, h2), Image.BILINEAR)
    rng = np.random.default_rng(seed + 77)
    # flow direction = along iso-lines of a very smooth turbulence field
    smooth = gaussian_blur(fractal_noise((h2, w2), octaves=3, seed=seed + 5), 22)
    gy, gx = np.gradient(smooth)
    ang = np.arctan2(gy, gx) + np.pi / 2.0
    dens = np.clip(wash2, 0.0, None).ravel()
    cum = np.cumsum(dens / max(dens.sum(), 1e-6))
    field = np.zeros((h2, w2), np.float32)
    if tip_path:
        tip = load_brush_tip(tip_path, work=160)
        variants = brush_tip_variants(tip)
    else:
        variants = None
    for _ in range(n_strokes):
        idx = int(np.searchsorted(cum, rng.random()))
        y0, x0 = divmod(idx, w2)
        length = int(rng.integers(50, 200))
        op = float(rng.uniform(0.25, 0.7))
        bend = float(rng.uniform(-0.4, 0.4))
        x, y = float(x0), float(y0)
        if variants is not None:
            # brush-tip stamping: pick a tip variant and a per-stroke size
            vi = int(rng.integers(0, len(variants)))
            tipA = variants[vi]
            tsize = int(rng.integers(26, 90))          # half-res stamp size
            tsize -= tsize % 2                          # keep even -> slice math lines up
            timg = Image.fromarray((np.clip(tipA, 0, 1) * 255).astype(np.uint8), 'L').resize((tsize, tsize), Image.LANCZOS)
            ta = np.asarray(timg, dtype=np.float32) / 255.0
            rr = tsize // 2
            step = max(2.0, tsize * 0.22)
            for s in range(length):
                a = ang[int(y), int(x)] + bend * (s / 60.0)
                x += math.cos(a) * step
                y += math.sin(a) * step
                if x < rr or y < rr or x >= w2 - rr or y >= h2 - rr:
                    break
                xi, yi = int(x), int(y)
                if wash2[yi, xi] < 0.2:
                    continue
                patch = field[yi - rr:yi + rr, xi - rr:xi + rr]
                patch[...] = 1.0 - (1.0 - patch) * (1.0 - ta * op)   # screen-compose
        else:
            step = 2.5
            sigma = float(rng.uniform(3.5, 9.0))
            stretch = float(rng.uniform(2.5, 6.0))
            x, y = float(x0), float(y0)
            rr = max(3, int(3.2 * sigma * stretch))
            for s in range(length):
                a = ang[int(y), int(x)] + bend * (s / 60.0)
                x += math.cos(a) * step
                y += math.sin(a) * step
                if x < rr or y < rr or x >= w2 - rr or y >= h2 - rr:
                    break
                xi, yi = int(x), int(y)
                if wash2[yi, xi] < 0.2:
                    continue
                xs = np.arange(xi - rr, xi + rr + 1) - x
                ys = np.arange(yi - rr, yi + rr + 1)[:, None] - y
                u = xs[None, :] * math.cos(a) + ys * math.sin(a)
                v = -xs[None, :] * math.sin(a) + ys * math.cos(a)
                d = (u / (sigma * stretch)) ** 2 + (v / sigma) ** 2
                field[yi - rr:yi + rr + 1, xi - rr:xi + rr + 1] += np.exp(-0.5 * d, dtype=np.float32) * op
    field = box_blur(field, 3)
    m = wash2 > 0.15
    if m.any():
        f = field[m]
        field = (field - float(f.mean())) / (float(f.std()) + 1e-6)
    field = np.clip(field, -2.5, 2.5) / 2.5
    field = field * smoothstep((wash2 - 0.05) / 0.45)
    # remove residual mean bias introduced by the falloff mask
    mm = wash2 > 0.3
    if mm.any():
        field = field - float(field[mm].mean())
    return resize_f(field, (w, h), Image.BICUBIC)


# --------------------------------------------------------------------------- #
# 16-bit PNG writer (RGB16) — Pillow cannot write 16-bit multi-channel PNG
# --------------------------------------------------------------------------- #


def save_png_rgb16(path, arr, scale=1.0):
    """arr HxWx3 float -> 16-bit/channel RGB PNG (value = clip(arr/scale)*65535)."""
    import struct
    import zlib
    h, w = arr.shape[:2]
    a = (np.clip(arr / scale, 0.0, 1.0) * 65535.0 + 0.5).astype('>u2')
    raw = a.tobytes()
    rowbytes = w * 6
    filtered = bytearray()
    for y in range(h):
        filtered.append(0)  # filter type 0 (none)
        filtered += raw[y * rowbytes:(y + 1) * rowbytes]
    comp = zlib.compress(bytes(filtered), 6)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 16, 2, 0, 0, 0)
    with open(path, 'wb') as fh:
        fh.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                 + chunk(b'IDAT', comp) + chunk(b'IEND', b''))


def save_rgb_png(path, a):
    Image.fromarray(np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8), 'RGB').save(path)


def save_gray_png(path, a):
    Image.fromarray(np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8), 'L').save(path)


def pq_encode(lin, diffuse_nits=203.0):
    """SMPTE ST2084 PQ encode linear BT.709.

    lin = 1.0 is treated as diffuse white (SDR white); --diffuse-nits sets its
    absolute luminance (203 nits = HDR10 reference, so lin 4.0 -> ~812 nits).
    """
    m1, m2 = 2610.0 / 16384.0, 2523.0 / 32.0
    c1, c2, c3 = 3424.0 / 4096.0, 2413.0 / 128.0, 2392.0 / 128.0
    y = np.clip(lin * diffuse_nits, 0.0, None) / 10000.0
    ym = y ** m1
    return ((c1 + c2 * ym) / (1.0 + c3 * ym)) ** m2


# --------------------------------------------------------------------------- #
# core steps
# --------------------------------------------------------------------------- #


def detect_wash(rgb, lum, wash_lum=0.93, flat_th=0.012, open_radius=2):
    """Return (wash_weight 0..1 continuous, clipped_core bool, compact_core bool).

    wash_weight: 连续权重（高亮 + 平坦 = 细节被洗掉），只用于纹理/辉光强度；
    clipped_core: 硬阈值 >0.985 的裁切区（用于统计/辉光）；
    compact_core: 小面积孤立高光（灯/叶隙），给额外辉光。

    纹理是零均值的（见 paint_highlights），所以 wash 在轮廓边变小只会让纹理
    幅度变小、不会改变平均亮度 —— 不会出现亮/暗描边。
    """
    hp = np.abs(lum - gaussian_blur(lum, 1.4))
    detail = box_blur(hp, 6)
    flat_w = smoothstep((flat_th - detail) / max(flat_th, 1e-5))
    wash = smoothstep((lum - wash_lum) / 0.07) * flat_w
    wash = box_blur(wash, 6)
    clipped = (lum >= 0.985) | (rgb.min(-1) >= 0.995)
    core = clipped & (flat_w > 0.5)
    if open_radius > 0:
        core = erode(dilate(core, 2), 2)
    # compact = small isolated patches; big = large contiguous washed areas
    big = smoothstep(box_blur(core.astype(np.float32), 70) * 2.4)
    compact = core & (big < 0.35)
    # the clipped image border frame is not a light source: never glow there
    if compact.any():
        bb = 3
        compact[:bb, :] = False
        compact[-bb:, :] = False
        compact[:, :bb] = False
        compact[:, -bb:] = False
    return wash, core, compact, big


def paint_highlights(rgb, lum, wash, core, compact, big, darken, texture, glow, seed,
                     fog=0.0, fog_strokes=80, fog_brighten=False, fog_tip=None):
    """零均值纹理绘制 + 亮部辉光（不会在轮廓边产生亮/暗描边）。

    - 纹理是乘性零均值（1 + amp*n）：只改变局部对比，不改变区域平均亮度，
      所以 wash 在人物/树枝/岩石轮廓边渐变时不会出现“描边”；
    - 辉光叠加按目标亮度加权：只抬亮部，不抬暗部物体的轮廓。
    """
    H, W = lum.shape
    n1 = fractal_noise((H, W), octaves=4, seed=seed)          # smooth haze structure
    n3 = fractal_noise((H, W), octaves=2, seed=seed + 23)     # smooth colour drift

    # 1) zero-mean haze texture (no mean shift -> no rim at silhouettes)
    mod = 1.0 + darken * wash * n1
    # 1b) optional procedural mist-brush strokes (wispy fog, zero-mean)
    if fog > 0:
        f = fog_brush_field(lum, wash, seed, int(fog_strokes), fog_tip)
        if fog_brighten:
            f = np.clip(f, 0.0, None) * wash      # only add light (glowing mist)
        mod = mod + fog * f
    out = rgb * mod[..., None]

    # 2) gentle zero-mean chromatic drift inside painted areas
    chroma = np.stack([0.60 * n3, 0.15 * n3, -0.45 * n3], axis=-1) * (texture * 0.035) * wash[..., None]
    out = out * (1.0 + chroma)

    # 3) compact highlights: keep bright, add warm physical-ish glow, weighted by
    #    the destination brightness (dark silhouettes must not be lifted).
    dst_lum = luma(out)
    w_dst_small = smoothstep((dst_lum - 0.72) / 0.22)
    w_dst_broad = smoothstep((dst_lum - 0.75) / 0.22)
    if glow > 0 and compact.any():
        src = (lum * compact.astype(np.float32)) ** 2.2
        halo = gaussian_blur(src, 11) * glow
        tint = np.array([1.0, 0.86, 0.66], np.float32)
        out = out + halo[..., None] * tint * w_dst_small[..., None]
    # 4) extra broad glow around the largest washed areas (sun/mist bleeding)
    if glow > 0:
        broad = gaussian_blur(wash * (lum ** 2.0), 40) * (glow * 0.35)
        out = out + broad[..., None] * np.array([1.0, 0.92, 0.82], np.float32) * w_dst_broad[..., None]
    # allow >1 here: the tone curve below rolls it back into [0, 1]
    return np.clip(out, 0.0, 1.5)


def hdr_grade(view, contrast, sat):
    """HDR-look grade: deepen shadows, tiny mid lift, soft highlight rolloff (no clip).

    The rolloff compresses display 0.88..1.0 -> ~0.88..0.97 so recovered highlight
    structure stays visible and the output metric clip% goes down, not up.
    """
    lum = luma(view)
    x = np.clip(lum, 0.0, 1.0)
    # shadow deepen + mid lift (only where there is room; faded near white)
    y = x - contrast * 0.25 * np.exp(-((x - 0.25) / 0.22) ** 2)
    y = y + contrast * 0.10 * np.exp(-((x - 0.55) / 0.25) ** 2)
    # highlight rolloff above 0.85
    hi = x > 0.85
    k = 0.85
    rolled = k + (1.0 - k) * 0.80 * np.tanh((x - k) / max(1.0 - k, 1e-4) * 1.3) / np.tanh(1.3)
    y = np.where(hi, rolled, y)
    y = np.clip(y, 0.0, 1.0)
    ratio = y / np.maximum(lum, 1e-4)
    out = view * ratio[..., None]
    if sat != 1.0:
        g = luma(out)[..., None]
        out = g + (out - g) * sat
    return np.clip(out, 0.0, 1.0)


def highlight_shoulder(a, knee=0.88, top=0.965):
    """Global per-pixel highlight shoulder: identity below `knee`, soft compress above.

    Used in `--sdr-mode neutral`: it only makes room for the painted highlight detail
    and is a purely per-pixel curve (no spatial mask), so it cannot create edge halos.
    Shadows/mid-tones/contrast are left untouched for the downstream PS recipe to do
    exactly once (avoiding "HDR grade + recipe grade" double contrast).

    The shoulder saturates at `top` (default 0.965) so painted >1 values keep their
    texture instead of being clipped by the 8-bit PNG.
    """
    x = np.clip(a, 0.0, None)
    span = max(1.0 - knee, 1e-4)
    rolled = knee + (top - knee) * np.tanh((x - knee) / span * 1.4) / np.tanh(1.4)
    return np.where(x <= knee, x, rolled)


def build_hdr(view, wash, core, compact, headroom):
    """Radiance from the finished SDR view: ITM on known, extra headroom on painted areas."""
    lin = srgb_to_linear(view)
    lum = luma(lin)
    # inverse tone map: near-white known pixels get headroom (smooth, monotonic)
    t = np.clip((lum - 0.45) / 0.55, 0.0, 1.0)
    w_known = smoothstep(t) ** 1.6
    # painted / washed areas carry additional headroom (the "invented" dynamic range)
    w_wash = smoothstep(wash) ** 1.2
    w = np.maximum(w_known, w_wash)
    hdr = lin * (1.0 + (headroom - 1.0) * w)[..., None]
    # compact light sources: slightly brighter radiance, then clamp to headroom
    if compact.any():
        boost = compact.astype(np.float32) * gaussian_blur(np.clip(lum, 0, None), 4)
        hdr = hdr * (1.0 + 0.8 * boost[..., None])
    return np.clip(hdr, 0.0, headroom)


def save_headroom_viz(hdr, path):
    lg = np.clip(np.log2(np.maximum(luma(hdr), 1e-4)) + 2.0, 0.0, 2.5) / 2.5
    r = np.clip(1.5 - np.abs(lg * 3 - 1.0), 0, 1)
    g = np.clip(1.5 - np.abs(lg * 3 - 2.0), 0, 1)
    b = np.clip(1.5 - np.abs(lg * 3 - 0.2), 0, 1)
    save_rgb_png(path, np.stack([r, g, b], axis=-1))


def save_wash_viz(rgb, wash, core, path):
    vis = rgb.copy()
    vis = vis * (1.0 - 0.35 * wash[..., None]) + np.array([1.0, 0.30, 0.10]) * (0.35 * wash[..., None])
    vis[core] = vis[core] * 0.4 + np.array([1.0, 0.15, 0.05]) * 0.6
    save_rgb_png(path, np.clip(vis, 0, 1))


def qa_sheet(orig, view, wash, core, out_path, max_rows=2):
    H, W = wash.shape
    gh, gw = 14, 24
    cells = []
    for gy in range(gh):
        for gx in range(gw):
            y0, y1 = int(gy * H / gh), int((gy + 1) * H / gh)
            x0, x1 = int(gx * W / gw), int((gx + 1) * W / gw)
            n = int((wash[y0:y1, x0:x1] > 0.5).sum())
            if n > 400:
                cells.append((n, x0, y0, x1, y1))
    cells.sort(reverse=True)
    boxes = []
    for _, x0, y0, x1, y1 in cells:
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        bs = 560
        bx0 = max(0, min(W - bs, cx - bs // 2))
        by0 = max(0, min(H - bs, cy - bs // 2))
        box = (bx0, by0, bx0 + bs, by0 + bs)
        if all(abs(box[0] - b[0]) > bs // 2 or abs(box[1] - b[1]) > bs // 2 for b in boxes):
            boxes.append(box)
        if len(boxes) >= max_rows:
            break
    if not boxes:
        boxes = [(0, 0, min(560, W), min(560, H))]
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 20)
    except Exception:
        font = ImageFont.load_default()
    pad = 8
    rows = []
    for bi, box in enumerate(boxes):
        x0, y0, x1, y1 = box
        ow, oh = x1 - x0, y1 - y0
        tiles = []
        for img, lab in ((orig, f'原图（8-bit） #{bi + 1}'), (view, f'HDR 重建视图 #{bi + 1}')):
            t = Image.fromarray(np.clip(img[y0:y1, x0:x1] * 255 + 0.5, 0, 255).astype(np.uint8), 'RGB')
            dr = ImageDraw.Draw(t)
            dr.rectangle([0, 0, ow, 26], fill=(0, 0, 0))
            dr.text((6, 2), lab, fill=(255, 226, 140), font=font)
            tiles.append(t)
        row = Image.new('RGB', (ow * 2 + pad * 3, oh + pad * 2), (16, 16, 18))
        row.paste(tiles[0], (pad, pad))
        row.paste(tiles[1], (pad * 2 + ow, pad))
        rows.append(row)
    if rows:
        sheet = Image.new('RGB', (max(r.width for r in rows), sum(r.height for r in rows) + pad), (16, 16, 18))
        y = 0
        for r in rows:
            sheet.paste(r, (0, y))
            y += r.height
        sheet.save(out_path)


# --------------------------------------------------------------------------- #


def main(argv=None):
    ap = argparse.ArgumentParser(description='Paint an 8-bit image into an HDR version.')
    ap.add_argument('--input', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--prefix', default='hdr-')
    ap.add_argument('--crop-bottom', type=int, default=149)
    ap.add_argument('--wash-lum', type=float, default=0.93)
    ap.add_argument('--flat-th', type=float, default=0.012)
    ap.add_argument('--darken', type=float, default=0.10)
    ap.add_argument('--texture', type=float, default=0.35)
    ap.add_argument('--glow', type=float, default=0.45)
    ap.add_argument('--contrast', type=float, default=0.22)
    ap.add_argument('--sat', type=float, default=1.06)
    ap.add_argument('--fog', type=float, default=0.0,
                    help='雾气笔刷强度（0=关；建议 0.15-0.4，零均值只改局部对比）')
    ap.add_argument('--fog-tip', default=None,
                    help='画笔笔尖 PNG（RGBA 或黑底白形），用于替代高斯笔触')
    ap.add_argument('--fog-strokes', type=int, default=80,
                    help='雾气笔刷笔画数（越多越密）')
    ap.add_argument('--fog-brighten', action='store_true',
                    help='雾刷只提亮（发光雾气）而不是明暗双向')
    ap.add_argument('--sdr-mode', choices=['neutral', 'look'], default='neutral',
                    help='neutral=只做高光压缩/重建，暗部对比留给 ps_grade（推荐，避免二次调色）；'
                         'look=同时做 HDR 观感曲线（对比度/饱和），适合单独出图')
    ap.add_argument('--sdr-knee', type=float, default=0.90,
                    help='neutral 模式高光肩部拐点；越大保留越多高光对比')
    ap.add_argument('--sdr-top', type=float, default=0.965,
                    help='neutral 模式高光肩部上限；越接近 1 高光越亮（HDR 感更强）')
    ap.add_argument('--headroom', type=float, default=4.0)
    ap.add_argument('--diffuse-nits', type=float, default=203.0)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--no-qa', action='store_true')
    ap.add_argument('--skip-hdr', action='store_true',
                    help='只输出 SDR view + meta（供 ps_grade 自动流程用，不产 16-bit/gainmap 大文件）')
    args = ap.parse_args(argv)

    os.makedirs(args.out_dir, exist_ok=True)
    p = lambda name: os.path.join(args.out_dir, args.prefix + name)

    im = Image.open(args.input)
    rgb = np.asarray(im.convert('RGB')).astype(np.float32) / 255.0
    crop = int(args.crop_bottom or 0)
    if crop > 0:
        rgb = rgb[:rgb.shape[0] - crop]
    H, W = rgb.shape[:2]
    orig = rgb.copy()
    lum = luma(rgb)

    wash, core, compact, big = detect_wash(rgb, lum, args.wash_lum, args.flat_th)
    wash_pct = float((wash > 0.5).mean() * 100)
    if wash_pct < 0.05 and float(core.mean()) < 0.0005:
        print(json.dumps({'ok': False, 'error': '没有检测到被洗白的高光区（可调低 --wash-lum / 调高 --flat-th）'},
                         ensure_ascii=False))
        return 1

    painted = paint_highlights(rgb, lum, wash, core, compact, big,
                               args.darken, args.texture, args.glow, args.seed,
                               args.fog, args.fog_strokes, args.fog_brighten, args.fog_tip)
    if args.sdr_mode == 'look':
        view = hdr_grade(painted, args.contrast, args.sat)
    else:
        # neutral: no shadow deepening / no saturation change / no contrast curve —
        # only a global, per-pixel highlight shoulder so that the painted >1 values
        # fit into 8-bit. Everything else is left for the PS recipe to grade ONCE.
        view = np.clip(highlight_shoulder(painted, args.sdr_knee, args.sdr_top), 0.0, 1.0)
    hdr = build_hdr(view, wash, core, compact, args.headroom)

    # ---- files ---------------------------------------------------------------
    files = {'view': p('view.png')}
    save_rgb_png(files['view'], view)
    if not args.skip_hdr:
        files['linear16'] = p('linear16.png')
        save_png_rgb16(files['linear16'], hdr, scale=4.0)
        files['pq16'] = p('pq16.png')
        save_png_rgb16(files['pq16'], pq_encode(hdr, args.diffuse_nits), scale=1.0)
        files['gainmap'] = p('gainmap.png')
        sdr_lin = srgb_to_linear(view)
        ratio = np.clip(luma(hdr), 0.0, None) / np.maximum(luma(sdr_lin), 1e-3)
        gain_stops = np.clip(np.log2(np.maximum(ratio, 1.0)), 0.0, 2.0)
        save_gray_png(files['gainmap'], gain_stops / 2.0)
        files['headroom'] = p('headroom.png')
        save_headroom_viz(hdr, files['headroom'])
        files['washmask'] = p('washmask.png')
        save_wash_viz(orig, wash, core, files['washmask'])
    if not args.no_qa:
        files['qa'] = p('qa.png')
        qa_sheet(orig, view, wash, core, files['qa'])

    # ---- metrics -------------------------------------------------------------
    lum_v = luma(view)
    meta = {
        'ok': True,
        'input': args.input,
        'outputDir': args.out_dir,
        'size': [W, H],
        'params': {
            'washLum': args.wash_lum, 'flatTh': args.flat_th, 'darken': args.darken,
            'texture': args.texture, 'glow': args.glow, 'contrast': args.contrast,
            'sat': args.sat, 'sdrMode': args.sdr_mode, 'headroom': args.headroom, 'cropBottom': crop,
            'seed': args.seed, 'diffuseNits': args.diffuse_nits,
        },
        'highlight': {
            'washPct': round(wash_pct, 3),
            'clipCorePct': round(float(core.mean() * 100), 3),
            'compactCorePct': round(float(compact.mean() * 100), 3),
            'clipBeforePct': round(float((lum > 0.98).mean() * 100), 3),
            'clipAfterPct': round(float((lum_v > 0.98).mean() * 100), 3),
            'lumP99Before': round(float(np.percentile(lum, 99)), 4),
            'lumP99After': round(float(np.percentile(lum_v, 99)), 4),
            'paintedMeanLum': round(float(lum_v[wash > 0.5].mean()) if (wash > 0.5).any() else 0.0, 4),
            'origMeanLumInWash': round(float(lum[wash > 0.5].mean()) if (wash > 0.5).any() else 0.0, 4),
        },
        'hdr': {
            'max': round(float(hdr.max()), 3),
            'p999': round(float(np.percentile(hdr, 99.9)), 3),
            'pixelsAbove1Pct': round(float((luma(hdr) > 1.0).mean() * 100), 2),
            'pixelsAbove2Pct': round(float((luma(hdr) > 2.0).mean() * 100), 2),
        },
        'encoding': {
            'linear16': 'RGB16 PNG (bit depth 16, color type 2), linear BT.709, value = clip(lin/4.0)*65535',
            'pq16': f'RGB16 PNG, SMPTE ST2084 PQ, BT.709 primaries; linear 1.0 = diffuse white {args.diffuse_nits:g} nits (lin max 4.0 -> ~{args.diffuse_nits * 4:g} nits)',
            'gainmap': '8-bit gray, log2(HDR/SDR) in [0,2] stops mapped to 0..255',
        },
        'files': files,
    }
    with open(p('meta.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    payload = json.dumps(meta, ensure_ascii=False)
    try:
        sys.stdout.buffer.write(payload.encode('utf-8') + b'\n')
        sys.stdout.buffer.flush()
    except Exception:
        print(payload)
    return 0


if __name__ == '__main__':
    sys.exit(main())
