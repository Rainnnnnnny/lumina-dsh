"""SUPIR (SDXL diffusion) adapter for lumina-dsh's quality-first engine chain.

This is a thin wrapper around the official SUPIR inference entry point:
  code dir: <install-dir>/supir-code   (unpacked https://github.com/Fanghua-Yu/SUPIR)
  weights : <install-dir>/supir        (SUPIR-v0Q.ckpt + sd_xl_base_1.0_0.9vae.safetensors
                                        + CLIP-ViT-bigG + clip-vit-large-patch14-336)

It runs SUPIR's own inference.py in a temp folder and writes one PNG.
EXPERIMENTAL: shipped as the diffusion adapter, but real end-to-end validation
requires the multi-GB weights; failures fall back to the next engine in the chain.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--kind", default="default")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--code-dir", default="")
    parser.add_argument("--num-steps", type=int, default=20)
    parser.add_argument("--cfg", type=float, default=7.5)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--use-llava", action="store_true", default=False)
    args = parser.parse_args()

    code_dir = args.code_dir or os.path.join(os.path.dirname(args.model_dir.rstrip("\\/")), "supir-code")
    entry = os.path.join(code_dir, "inference.py")
    if not os.path.exists(entry):
        entry = os.path.join(code_dir, "test.py")
    if not os.path.exists(entry):
        raise SystemExit("SUPIR code not installed (expected inference.py/test.py); re-run hilumina to install it")
    supir_model = _first_existing(args.model_dir, ["SUPIR-v0Q.ckpt", "SUPIR-v0F.ckpt"])
    sdxl_model = _first_existing(args.model_dir, ["sd_xl_base_1.0_0.9vae.safetensors", "sd_xl_base_1.0.safetensors"])
    if not supir_model or not sdxl_model:
        raise SystemExit("SUPIR/SDXL weights missing in " + args.model_dir)

    work = tempfile.mkdtemp(prefix="lumina-supir-")
    in_dir = os.path.join(work, "in")
    out_dir = os.path.join(work, "out")
    os.makedirs(in_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    shutil.copyfile(args.input, os.path.join(in_dir, "input.png"))

    if os.path.basename(entry) == "test.py":
        command = [
            sys.executable, entry,
            "--img_dir", in_dir,
            "--save_dir", out_dir,
            "--upscale", str(max(1, min(4, int(round(args.scale))))),
            "--SUPIR_sign", "Q",
            "--edm_steps", str(max(1, args.num_steps)),
            "--s_cfg", str(args.cfg),
            "--seed", "1234",
            "--a_prompt", args.prompt or "high quality, detailed",
            "--n_prompt", "bad quality",
        ]
        if not args.use_llava:
            command.append("--no_llava")
        command.append("--loading_half_params")
    else:
        command = [
            sys.executable, entry,
            "--img_dir", in_dir,
            "--save_dir", out_dir,
            "--supir_model", supir_model,
            "--sdxl_model", sdxl_model,
            "--upscale", str(max(1, min(4, int(round(args.scale))))),
            "--num_steps", str(max(1, args.num_steps)),
            "--cfg_scale", str(args.cfg),
            "--a_prompt", args.prompt or "high quality, detailed",
            "--seed", "1234",
        ]
    proc = subprocess.run(command, cwd=code_dir, capture_output=True, text=True)
    candidates = [os.path.join(out_dir, name) for name in os.listdir(out_dir)] if os.path.isdir(out_dir) else []
    if proc.returncode != 0 or not candidates:
        shutil.rmtree(work, ignore_errors=True)
        detail = (proc.stderr or proc.stdout or "").strip()[-600:]
        raise SystemExit("SUPIR inference failed: " + detail)
    result = candidates[0]
    target_w = max(1, round(_width(args.input) * args.scale))
    target_h = max(1, round(_height(args.input) * args.scale))
    try:
        from PIL import Image
        image = Image.open(result).convert("RGB")
        if image.size != (target_w, target_h):
            image = image.resize((target_w, target_h), Image.LANCZOS)
        image.save(args.output, "PNG")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(json.dumps({"ok": True, "engine": "supir", "width": target_w, "height": target_h}))


def _compat_mha():
    """Disable torch 2.9's new MHA fast path (legacy SUPIR passes 2D attn masks)."""
    try:
        import torch.backends.mha as mha
        mha.set_fastpath_enabled(False)
    except Exception:
        pass


def _first_existing(directory, names):
    for name in names:
        candidate = os.path.join(directory, name)
        if os.path.exists(candidate):
            return candidate
    return None


def _width(path):
    from PIL import Image
    return Image.open(path).width


def _height(path):
    from PIL import Image
    return Image.open(path).height


if __name__ == "__main__":
    main()
