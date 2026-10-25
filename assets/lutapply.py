#!/usr/bin/env python
"""Apply a .cube 3D LUT to an image (trilinear), with strength + quality metrics.

Why Python: Photoshop's Color Lookup adjustment layer is scriptable but the LUT
file assignment silently fails in the hidden automation context, and this path
also lets us measure the sharpness/contrast impact and gate on it.

Adobe LUT files are NOT bundled with Lumina: the styles reference the .cube
files that ship with Photoshop itself. The LUT folder is resolved at run time
from, in order: --lut-dir, the LUMINA_LUT_DIR env var, the Photoshop install
path recorded in the Windows registry, then conventional Program Files folders.

CLI:
  lutapply.py --input in.png --lut file.cube --output out.png [--strength 40] [--json]
  lutapply.py --input in.png --lut "Kodak 5218 Kodak 2383 (by Adobe).cube" --output out.png
  lutapply.py --list [--lut-dir DIR]          # list .cube files found in the PS LUT folder
  lutapply.py --print-lut-dir                 # print the detected LUT folder
Prints JSON: ok, lutDir, sharpBefore, sharpAfter, sharpDeltaPct, clipBefore, clipAfter, lutSize
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


LUT_SUBDIR = os.path.join('Presets', '3DLUTs')
ENV_KEYS = ('LUMINA_LUT_DIR', 'DSH_LUMINA_LUT_DIR')


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def sharpness(a):
    l = luma(a)
    lap = (4 * l[1:-1, 1:-1] - l[:-2, 1:-1] - l[2:, 1:-1] - l[1:-1, :-2] - l[1:-1, 2:])
    return float(np.abs(lap).mean())


def _dedupe(paths):
    seen = set()
    out = []
    for raw in paths:
        if not raw:
            continue
        path = os.path.normpath(str(raw).strip())
        key = path.lower()
        if key in seen:
            continue
        seen.add(key)
        if os.path.isdir(path):
            out.append(path)
    return out


def _registry_photoshop_dirs():
    """Photoshop install folders recorded by the Adobe installer."""
    if os.name != 'nt':
        return []
    try:
        import winreg
    except ImportError:
        return []

    found = []
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Adobe\Photoshop'),
        (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Adobe\Photoshop'),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Adobe\Photoshop'),
    ]
    for hive, root in roots:
        try:
            with winreg.OpenKey(hive, root) as key:
                index = 0
                while True:
                    try:
                        version = winreg.EnumKey(key, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        with winreg.OpenKey(key, version) as version_key:
                            application_path = ''
                            try:
                                application_path = str(winreg.QueryValueEx(version_key, 'ApplicationPath')[0])
                            except OSError:
                                pass
                            if application_path:
                                found.append(application_path)
                            # PluginPath points at <install>\Plug-Ins\, the
                            # install root is its parent when ApplicationPath is
                            # missing (older installers).
                            if not application_path:
                                try:
                                    plugin_path = str(winreg.QueryValueEx(version_key, 'PluginPath')[0])
                                    found.append(os.path.dirname(os.path.normpath(plugin_path)))
                                except OSError:
                                    pass
                    except OSError:
                        continue
        except OSError:
            continue
    return found


def _filesystem_photoshop_dirs():
    """Conventional Program Files locations, for installs without registry data."""
    found = []
    bases = [
        os.environ.get('ProgramW6432'),
        os.environ.get('ProgramFiles'),
        os.environ.get('ProgramFiles(x86)'),
    ]
    for base in _dedupe(bases):
        for root in (os.path.join(base, 'Adobe'), base):
            try:
                entries = os.listdir(root)
            except OSError:
                continue
            for name in entries:
                candidate = os.path.join(root, name)
                if not os.path.isdir(candidate):
                    continue
                if os.path.isfile(os.path.join(candidate, 'Photoshop.exe')) or os.path.isdir(os.path.join(candidate, LUT_SUBDIR)):
                    found.append(candidate)
    return found


def detect_lut_dirs(explicit=None):
    """All existing Photoshop 3DLUT folders on this machine, best first."""
    paths = []
    if explicit:
        paths.append(explicit)
    for key in ENV_KEYS:
        value = os.environ.get(key)
        if value:
            paths.append(value)
    for install in _registry_photoshop_dirs() + _filesystem_photoshop_dirs():
        paths.append(os.path.join(install, LUT_SUBDIR))
    return _dedupe(paths)


def resolve_lut_path(lut, lut_dir=None):
    """Accept an absolute LUT path or a bare file name from Presets/3DLUTs."""
    if not lut:
        raise RuntimeError('缺少 --lut')
    lut = str(lut).strip()
    if os.path.isabs(lut):
        if not os.path.isfile(lut):
            raise RuntimeError('LUT 文件不存在: %s' % lut)
        return lut, (lut_dir or os.path.dirname(lut))
    candidates = detect_lut_dirs(lut_dir)
    for directory in candidates:
        path = os.path.join(directory, lut)
        if os.path.isfile(path):
            return path, directory
    raise RuntimeError(
        '找不到 LUT「%s」：本机 Photoshop 自带 3DLUTs 目录未检出（已尝试: %s）；'
        '可用 --lut-dir 或环境变量 LUMINA_LUT_DIR 指定'
        % (lut, '; '.join(candidates) if candidates else '无')
    )


def parse_cube(path):
    size = None
    domain_min = np.array([0.0, 0.0, 0.0], dtype=np.float32)
    domain_max = np.array([1.0, 1.0, 1.0], dtype=np.float32)
    data = []
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            upper = line.upper()
            if upper.startswith('TITLE'):
                continue
            if upper.startswith('LUT_3D_SIZE'):
                size = int(float(line.split()[-1]))
                continue
            if upper.startswith('LUT_1D_SIZE'):
                raise RuntimeError('1D LUT cube 不支持（请用 3D LUT）')
            if upper.startswith('DOMAIN_MIN'):
                domain_min = np.array([float(x) for x in line.split()[1:4]], dtype=np.float32)
                continue
            if upper.startswith('DOMAIN_MAX'):
                domain_max = np.array([float(x) for x in line.split()[1:4]], dtype=np.float32)
                continue
            parts = line.split()
            if len(parts) >= 3:
                try:
                    data.append([float(parts[0]), float(parts[1]), float(parts[2])])
                except ValueError:
                    continue
    if not size or not data:
        raise RuntimeError('cube 解析失败: size=%s lines=%d' % (size, len(data)))
    arr = np.array(data, dtype=np.float32)
    if arr.shape[0] != size ** 3:
        raise RuntimeError('cube 数据行数 %d != size^3 %d' % (arr.shape[0], size ** 3))
    # .cube order: red varies fastest
    grid = arr.reshape(size, size, size, 3)          # [b, g, r, :] after reshape
    grid = np.transpose(grid, (2, 1, 0, 3))          # -> [r,g,b,3]
    span = np.maximum(domain_max - domain_min, 1e-6)
    return {'size': size, 'grid': np.ascontiguousarray(grid), 'min': domain_min, 'span': span}


def apply_cube(rgb, lut):
    size = lut['size']
    grid = lut['grid']
    norm = np.clip((rgb - lut['min']) / lut['span'], 0.0, 1.0)
    pos = norm * (size - 1)
    i0 = np.floor(pos).astype(np.int32)
    i1 = np.minimum(i0 + 1, size - 1)
    f = (pos - i0).astype(np.float32)

    def sample(r, g, b):
        return grid[r, g, b]

    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    r1, g1, b1 = i1[..., 0], i1[..., 1], i1[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]
    c000 = sample(r0, g0, b0); c100 = sample(r1, g0, b0)
    c010 = sample(r0, g1, b0); c110 = sample(r1, g1, b0)
    c001 = sample(r0, g0, b1); c101 = sample(r1, g0, b1)
    c011 = sample(r0, g1, b1); c111 = sample(r1, g1, b1)
    c00 = c000 * (1 - fr) + c100 * fr
    c10 = c010 * (1 - fr) + c110 * fr
    c01 = c001 * (1 - fr) + c101 * fr
    c11 = c011 * (1 - fr) + c111 * fr
    c0 = c00 * (1 - fg) + c10 * fg
    c1 = c01 * (1 - fg) + c11 * fg
    return np.clip(c0 * (1 - fb) + c1 * fb, 0.0, 1.0)


def list_luts(lut_dir=None):
    out = []
    seen = set()
    for directory in detect_lut_dirs(lut_dir):
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if not name.lower().endswith('.cube') or name.lower() in seen:
                continue
            seen.add(name.lower())
            path = os.path.join(directory, name)
            try:
                info = parse_cube(path)
                out.append({'name': os.path.splitext(name)[0], 'file': path, 'size': info['size']})
            except Exception as exc:
                out.append({'name': os.path.splitext(name)[0], 'file': path, 'error': str(exc)})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--input')
    ap.add_argument('--lut')
    ap.add_argument('--lut-dir', default=None, help='override the Photoshop Presets/3DLUTs folder')
    ap.add_argument('--output')
    ap.add_argument('--strength', type=float, default=40.0)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--print-lut-dir', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)

    if args.print_lut_dir:
        dirs = detect_lut_dirs(args.lut_dir)
        print(json.dumps({'ok': bool(dirs), 'lutDirs': dirs}, ensure_ascii=False))
        return 0 if dirs else 1
    if args.list:
        dirs = detect_lut_dirs(args.lut_dir)
        print(json.dumps({'ok': True, 'lutDir': dirs[0] if dirs else None, 'luts': list_luts(args.lut_dir)}, ensure_ascii=False))
        return 0
    if not (args.input and args.lut and args.output):
        print(json.dumps({'ok': False, 'error': 'need --input/--lut/--output'}, ensure_ascii=False))
        return 1

    try:
        lut_path, lut_dir = resolve_lut_path(args.lut, args.lut_dir)
    except RuntimeError as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1

    im = Image.open(args.input).convert('RGB')
    rgb = np.asarray(im).astype(np.float32) / 255.0
    lut = parse_cube(lut_path)
    mapped = apply_cube(rgb, lut)
    s = np.clip(args.strength / 100.0, 0.0, 1.0)
    out = np.clip(rgb + (mapped - rgb) * s, 0.0, 1.0)
    Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), 'RGB').save(args.output)

    sb, sa = sharpness(rgb), sharpness(out)
    result = {
        'ok': True,
        'input': args.input,
        'output': args.output,
        'lut': lut_path,
        'lutDir': lut_dir,
        'lutSize': lut['size'],
        'strength': args.strength,
        'sharpBefore': round(sb, 5),
        'sharpAfter': round(sa, 5),
        'sharpDeltaPct': round((sa - sb) / max(sb, 1e-6) * 100.0, 2),
        'clipBefore': round(float((luma(rgb) > 0.98).mean() * 100.0), 2),
        'clipAfter': round(float((luma(out) > 0.98).mean() * 100.0), 2),
        'meanBefore': round(float(luma(rgb).mean()), 4),
        'meanAfter': round(float(luma(out).mean()), 4),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
