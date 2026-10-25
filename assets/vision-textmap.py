"""Render an image region as a native-resolution text map.

One character per source pixel (optionally block-averaged for huge regions), so
the agent can read pixel-exact structure without any image-token/resolution cap.

Commands (print JSON with a "text" field):
  map --input <path> [--x --y --w --h] [--mode lum|edge|binary|auto]
      [--threshold 128] [--max-chars 24000] [--ruler 10]
"""
import json
import sys

import numpy as np
from PIL import Image

# Force UTF-8 stdio: Node decodes this process' stdout as UTF-8 and paths may be non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


LUM_CHARS = " .:-=+*#%@"
EDGE_CHARS = " ..::--++**##@@"


def _load(path, x, y, w, h):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    x = max(0, min(int(x), W - 1))
    y = max(0, min(int(y), H - 1))
    w = max(1, min(int(w), W - x))
    h = max(1, min(int(h), H - y))
    return np.asarray(im.crop((x, y, x + w, y + h))).astype(np.float32) / 255.0, (x, y, w, h)


def _lum(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def _edge(a):
    l = _lum(a)
    gx = np.zeros_like(l)
    gy = np.zeros_like(l)
    if l.shape[1] > 2:
        gx[:, 1:-1] = (l[:, 2:] - l[:, :-2]) * 0.5
    if l.shape[0] > 2:
        gy[1:-1, :] = (l[2:, :] - l[:-2, :]) * 0.5
    mag = np.hypot(gx, gy)
    if mag.max() > 0:
        mag = mag / mag.max()
    return mag


def render(path, x, y, w, h, mode, threshold, max_chars, ruler):
    a, rect = _load(path, x, y, w, h)
    H, W = a.shape[:2]
    # block-average when the region exceeds the character budget
    budget = max(100, max_chars)
    block = 1
    while ((W + block - 1) // block) * ((H + block - 1) // block) > budget:
        block += 1
    if block > 1:
        H2 = H // block
        W2 = W // block
        a = a[: H2 * block, : W2 * block].reshape(H2, block, W2, block, 3).mean(axis=(1, 3))
        H, W = a.shape[:2]

    if mode == "auto":
        mode = "edge" if _edge(a).mean() > 0.12 else "lum"
    if mode == "edge":
        g = _edge(a)
        chars = EDGE_CHARS
        idx = np.clip((g * (len(chars) - 1)).round().astype(int), 0, len(chars) - 1)
    elif mode == "binary":
        l = _lum(a)
        idx = (l > threshold / 255.0).astype(int)
        chars = " #"
    else:
        l = _lum(a)
        idx = np.clip((l * (len(LUM_CHARS) - 1)).round().astype(int), 0, len(LUM_CHARS) - 1)
        chars = LUM_CHARS

    lines = []
    if ruler > 0:
        header = [" " * 6]
        for cx in range(0, W, ruler):
            label = str(rect[0] + cx * block).rjust(ruler)
            header.append(label[:ruler])
        lines.append("".join(header))
    for ry in range(H):
        row = []
        if ruler > 0 and ry % ruler == 0:
            row.append(str(rect[1] + ry * block).rjust(5) + " ")
        elif ruler > 0:
            row.append(" " * 6)
        row.append("".join(chars[i] for i in idx[ry]))
        lines.append("".join(row))
    return {
        "ok": True,
        "mode": mode,
        "sourceRect": list(rect),
        "block": block,
        "chars": int(W * H),
        "text": "\n".join(lines),
    }


def main(argv):
    if len(argv) < 2 or argv[1] != "map":
        print(json.dumps({"ok": False, "error": "usage: textmap.py map ..."}))
        return 2
    args = {}
    i = 2
    while i < len(argv) - 1:
        if argv[i].startswith("--"):
            args[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    try:
        res = render(
            args["input"],
            float(args.get("x", 0)),
            float(args.get("y", 0)),
            float(args.get("w", 200)),
            float(args.get("h", 120)),
            args.get("mode", "auto"),
            float(args.get("threshold", 128)),
            int(args.get("max-chars", 24000)),
            int(args.get("ruler", 10)),
        )
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
