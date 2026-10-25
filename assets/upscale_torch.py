"""Tiled super-resolution runner for lumina-dsh's quality-first engine chain.

Supported checkpoint formats (auto-detected):
  - Real-ESRGAN RRDBNet (keys: conv_first / body.N.rdb1...)  -> native
  - BasicSR ESRGAN RRDBNet (keys: model.0 / model.1.sub.N.RDB1...) -> converted
     e.g. 4x-UltraSharp, 4x-Remacri

Model choice: --model <path> wins; otherwise --kind maps to the Real-ESRGAN
weights present in --model-dir. Output is the native 4x (or 2x) result resized
to --scale with Lanczos.

The script never downloads anything and never touches the network.
"""
import argparse
import os
import sys

import numpy as np
import torch
from PIL import Image

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


class ResidualDenseBlock(torch.nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.conv1 = torch.nn.Conv2d(nf, gc, 3, 1, 1)
        self.conv2 = torch.nn.Conv2d(nf + gc, gc, 3, 1, 1)
        self.conv3 = torch.nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
        self.conv4 = torch.nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
        self.conv5 = torch.nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
        self.lrelu = torch.nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(torch.nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(nf, gc)
        self.rdb2 = ResidualDenseBlock(nf, gc)
        self.rdb3 = ResidualDenseBlock(nf, gc)

    def forward(self, x):
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x


class RRDBNet(torch.nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, nf=64, nb=23, gc=32, scale=4, num_hr=True):
        super().__init__()
        self.scale = scale
        self.conv_first = torch.nn.Conv2d(num_in_ch, nf, 3, 1, 1)
        self.body = torch.nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        self.conv_body = torch.nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up1 = torch.nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up2 = torch.nn.Conv2d(nf, nf, 3, 1, 1) if scale >= 4 else None
        self.conv_hr = torch.nn.Conv2d(nf, nf, 3, 1, 1) if num_hr else None
        self.conv_last = torch.nn.Conv2d(nf, num_out_ch, 3, 1, 1)
        self.lrelu = torch.nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(torch.nn.functional.interpolate(feat, scale_factor=2, mode="nearest")))
        if self.conv_up2 is not None:
            feat = self.lrelu(self.conv_up2(torch.nn.functional.interpolate(feat, scale_factor=2, mode="nearest")))
        if self.conv_hr is not None:
            feat = self.lrelu(self.conv_hr(feat))
        return self.conv_last(feat)


def convert_basicsr_keys(state):
    """Map BasicSR/ESRGAN RRDBNet keys to this module's names.

    Old ESRGAN dumps name the conv layers model.0 / model.3 / model.6 / model.8 /
    model.10 / model.12 (conv_first / conv_body / conv_up1 / conv_up2 / conv_hr /
    conv_last); the RRDB body lives under model.1.sub.N.
    """
    conv_map = {"model.0.": "conv_first.", "model.3.": "conv_body.", "model.6.": "conv_up1.",
                "model.8.": "conv_up2.", "model.10.": "conv_last."}
    out = {}
    for key, value in state.items():
        name = key
        if name.startswith("model.1.sub."):
            name = name.replace("model.1.sub.", "body.", 1)
            name = name.replace(".RDB1.", ".rdb1.").replace(".RDB2.", ".rdb2.").replace(".RDB3.", ".rdb3.")
            name = name.replace(".conv1.0.", ".conv1.").replace(".conv2.0.", ".conv2.")
            name = name.replace(".conv3.0.", ".conv3.").replace(".conv4.0.", ".conv4.").replace(".conv5.0.", ".conv5.")
        else:
            for prefix, target in conv_map.items():
                if name.startswith(prefix):
                    name = target + name[len(prefix):]
                    break
        out[name] = value
    return out

def inspect_state(state):
    if "conv_first.weight" in state:
        fmt = "real-esrgan"
    elif "model.0.weight" in state:
        fmt = "basicsr-esrgan"
        state = convert_basicsr_keys(state)
    else:
        raise RuntimeError("unsupported checkpoint (not an RRDBNet ESRGAN/Real-ESRGAN weight)")
    # keep only genuine RRDB body blocks; some community dumps carry a stray
    # trailing conv named body.N that is not part of the RRDB stack
    import re
    block_re = re.compile(r"^body\.(\d+)\.rdb[123]\.conv[1-5]\.")
    state = {key: value for key, value in state.items() if key.startswith("body.") is False or block_re.match(key)}
    block_ids = [int(re.match(r"^body\.(\d+)\.", key).group(1)) for key in state if block_re.match(key)]
    nb = max(block_ids) + 1
    scale = 4 if "conv_up2.weight" in state else 2
    return fmt, state, nb, scale

def load_model(path, device):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    state = checkpoint.get("params_ema") or checkpoint.get("params") or checkpoint
    state = {key.replace("module.", ""): value for key, value in state.items()}
    fmt, state, nb, scale = inspect_state(state)
    model = RRDBNet(3, 3, 64, nb, 32, scale, num_hr=("conv_hr.weight" in state))
    model.load_state_dict(state, strict=True)
    model.to(device).eval()
    return {"model": model, "format": fmt, "nb": nb, "scale": scale}


def choose_model(args):
    if args.model:
        return args.model
    mapping = {
        "photo": "RealESRGAN_x4plus.pth",
        "screenshot": "RealESRGAN_x4plus.pth",
        "illustration": "RealESRGAN_x4plus.pth",
        "anime": "RealESRGAN_x4plus_anime_6B.pth",
    }
    candidate = os.path.join(args.model_dir, mapping.get(str(args.kind).lower(), "RealESRGAN_x4plus.pth"))
    if os.path.exists(candidate):
        return candidate
    for name in ("4x-UltraSharp.pth", "4x_foolhardy_Remacri.pth", "RealESRGAN_x4plus.pth"):
        fallback = os.path.join(args.model_dir, name)
        if os.path.exists(fallback):
            return fallback
    raise RuntimeError("no usable model found in " + args.model_dir)


def upscale_tiled(model, image, device, native_scale, tile=512, overlap=32):
    width, height = image.size
    output = Image.new("RGB", (width * native_scale, height * native_scale))
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            x0, y0 = max(0, x - overlap), max(0, y - overlap)
            x1, y1 = min(width, x + tile + overlap), min(height, y + tile + overlap)
            patch = image.crop((x0, y0, x1, y1))
            tensor = torch.from_numpy(np.asarray(patch).astype(np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0).to(device)
            with torch.no_grad():
                out = model(tensor).clamp_(0, 1)
            out = (out.squeeze(0).permute(1, 2, 0).cpu().numpy() * 255.0).round().clip(0, 255).astype(np.uint8)
            ox = (x - x0) * native_scale
            oy = (y - y0) * native_scale
            tw = (min(width, x + tile) - x) * native_scale
            th = (min(height, y + tile) - y) * native_scale
            output.paste(Image.fromarray(out[oy:oy + th, ox:ox + tw]), (x * native_scale, y * native_scale))
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--kind", default="default")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model", default="")
    parser.add_argument("--tile", type=int, default=512)
    args = parser.parse_args()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model_path = choose_model(args)
    loaded = load_model(model_path, device)
    image = Image.open(args.input).convert("RGB")
    result = upscale_tiled(loaded["model"], image, device, loaded["scale"], tile=args.tile)
    target_w = max(1, round(image.width * args.scale))
    target_h = max(1, round(image.height * args.scale))
    if (result.width, result.height) != (target_w, target_h):
        result = result.resize((target_w, target_h), Image.LANCZOS)
    result.save(args.output, "PNG")
    print("ok model=%s format=%s device=%s native=%dx scale=%s size=%dx%d" % (
        os.path.basename(model_path), loaded["format"], device, loaded["scale"], args.scale, result.width, result.height))


if __name__ == "__main__":
    main()
