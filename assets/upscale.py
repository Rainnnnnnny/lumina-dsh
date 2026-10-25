#!/usr/bin/env python
"""Built-in super-resolution fallback: high-quality Lanczos upscale.

This does NOT add detail (no AI model is bundled); it is a deterministic
resize with an optional mild unsharp pass, useful as a baseline or when the
sharpness/QA pipeline still expects a larger canvas. For real AI upscaling
configure an external command (Real-ESRGAN, waifu2x, Topaz, ...) through
`superResolution.command` + `args` in the plugin/user config.

CLI:
  upscale.py --input in.png --output out.png [--scale 2] [--max-long-edge 8192] [--sharpen 0.6]
Prints JSON: ok, input, output, source{w,h}, outputImage{w,h}, scale, method
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageFilter

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass



def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--scale', type=float, default=2.0)
    ap.add_argument('--max-long-edge', type=float, default=8192.0)
    ap.add_argument('--sharpen', type=float, default=0.0)
    args = ap.parse_args(argv)

    try:
        im = Image.open(args.input).convert('RGB')
    except Exception as exc:  # noqa: BLE001 - report as JSON to the caller
        print(json.dumps({'ok': False, 'error': 'cannot open input: %s' % exc}, ensure_ascii=False))
        return 1

    width, height = im.size
    long_edge = max(width, height)
    scale = max(0.01, float(args.scale))
    if long_edge * scale > args.max_long_edge:
        scale = float(args.max_long_edge) / long_edge
    target_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    if target_size == (width, height):
        im.save(args.output)
        print(json.dumps({
            'ok': True, 'input': args.input, 'output': args.output,
            'source': {'width': width, 'height': height},
            'outputImage': {'width': width, 'height': height},
            'scale': 1.0, 'method': 'lanczos',
        }, ensure_ascii=False))
        return 0

    target = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    out = im.resize(target, Image.LANCZOS)
    if float(args.sharpen) > 0:
        out = out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=int(round(float(args.sharpen) * 100)), threshold=2))

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    out.save(args.output, 'PNG')
    print(json.dumps({
        'ok': True,
        'input': args.input,
        'output': args.output,
        'source': {'width': width, 'height': height},
        'outputImage': {'width': out.width, 'height': out.height},
        'scale': round(out.width / width, 4),
        'method': 'lanczos',
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
