"""Post-install compatibility patcher for SUPIR (run once after weights download).

Why: SUPIR's 2024 code targets Linux paths, transformers 4.28, torch 2.1-era
attention APIs.  A modern Windows/CUDA 13 install needs a handful of mechanical
patches.  This script applies them idempotently, extracts the weight archives,
and prints a JSON summary.

Usage:
  python supir_compat.py --code-dir D:/Lumina/ai/supir-code --weights-dir D:/Lumina/ai/supir
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

MPT_STUB = '''"""Stub for legacy LLaVA-MPT helpers (unused by SUPIR with --no_llava)."""


def add_bidirectional_mask_if_missing(*args, **kwargs):
    raise NotImplementedError("LLaVA-MPT path is disabled in this installation")


def convert_hf_causal_lm_to_prefix_lm(*args, **kwargs):
    raise NotImplementedError("LLaVA-MPT path is disabled in this installation")
'''

SDPA_HELPER = '''def _lumina_mea(q, k, v, attn_bias=None, scale=None, **kwargs):
    """torch SDPA fallback for xformers.ops.memory_efficient_attention."""
    import torch.nn.functional as _f
    if q.dim() == 3:
        out = _f.scaled_dot_product_attention(q.unsqueeze(1), k.unsqueeze(1), v.unsqueeze(1), scale=scale)
        return out.squeeze(1)
    return _f.scaled_dot_product_attention(q, k, v, scale=scale)
'''


def extract_archives(weights_dir, log):
    """Extract HF-style tars; bigG ships symlinked snapshots -> use blobs."""
    plan = [
        ("clip-vit-large-patch14.tar", "clip-vit-large-patch14"),
        ("clip-vit-large-patch14-336.tar", "clip-vit-large-patch14-336"),
        ("llava-v1.5-13b.tar", "llava-v1.5-13b"),
    ]
    for tar_name, dest_name in plan:
        tar_path = os.path.join(weights_dir, tar_name)
        dest = os.path.join(weights_dir, dest_name)
        if not os.path.exists(tar_path) or os.path.isdir(dest) and os.listdir(dest):
            continue
        os.makedirs(dest, exist_ok=True)
        subprocess.run(["tar.exe", "-xf", tar_path, "-C", dest], check=False, capture_output=True)
        log.append("extracted " + tar_name)
    big_tar = os.path.join(weights_dir, "CLIP-ViT-bigG-14-laion2B-39B-b160k.tar")
    big_dir = os.path.join(weights_dir, "CLIP-ViT-bigG")
    target_bin = os.path.join(big_dir, "open_clip_pytorch_model.bin")
    if os.path.exists(big_tar) and not os.path.exists(target_bin):
        os.makedirs(big_dir, exist_ok=True)
        subprocess.run(["tar.exe", "-xf", big_tar, "-C", big_dir, "--exclude=snapshots"], check=False, capture_output=True)
        blobs = sorted(glob.glob(os.path.join(big_dir, "blobs", "*")), key=os.path.getsize, reverse=True)
        if blobs:
            try:
                os.link(blobs[0], target_bin)
            except OSError:
                import shutil
                shutil.copyfile(blobs[0], target_bin)
            log.append("bigG blob linked")
    return target_bin


def write_ckpt_pth(code_dir, weights_dir, big_bin, log):
    path = os.path.join(code_dir, "CKPT_PTH.py")
    lines = [
        'LLAVA_CLIP_PATH = r"%s"' % os.path.join(weights_dir, "clip-vit-large-patch14-336"),
        'LLAVA_MODEL_PATH = r"%s"' % os.path.join(weights_dir, "llava-v1.5-13b"),
        'SDXL_CLIP1_PATH = r"%s"' % os.path.join(weights_dir, "clip-vit-large-patch14"),
        'SDXL_CLIP2_CKPT_PTH = r"%s"' % (big_bin or ""),
        'SDXL_MODEL_PATH = r"%s"' % os.path.join(weights_dir, "sd_xl_base_1.0_0.9vae.safetensors"),
        'SUPIR_MODEL_PATH = r"%s"' % os.path.join(weights_dir, "SUPIR-v0Q.ckpt"),
    ]
    open(path, "w", encoding="utf-8", newline="").write("\n".join(lines) + "\n")
    log.append("CKPT_PTH.py written")


def rewrite_paths(code_dir, weights_dir, log):
    replacements = [
        ("/opt/data/private/AIGC_pretrain/SDXL_cache/sd_xl_base_1.0_0.9vae.safetensors",
         os.path.join(weights_dir, "sd_xl_base_1.0_0.9vae.safetensors")),
        ("/opt/data/private/AIGC_pretrain/SDXL_cache", weights_dir),
        ("/opt/data/private/AIGC_pretrain/LLaVA1.5/clip-vit-large-patch14-336", os.path.join(weights_dir, "clip-vit-large-patch14-336")),
        ("/opt/data/private/AIGC_pretrain/LLaVA1.5/llava-v1.5-13b", os.path.join(weights_dir, "llava-v1.5-13b")),
        ("/opt/data/private/AIGC_pretrain/clip-vit-large-patch14", os.path.join(weights_dir, "clip-vit-large-patch14")),
        ("/opt/data/private/AIGC_pretrain/CLIP-ViT-bigG-14-laion2B-39B-b160k/open_clip_pytorch_model.bin",
         os.path.join(weights_dir, "CLIP-ViT-bigG", "open_clip_pytorch_model.bin")),
        ("/opt/data/private/AIGC_pretrain/SUPIR_cache/SUPIR-v0Q.ckpt", os.path.join(weights_dir, "SUPIR-v0Q.ckpt")),
        ("/opt/data/private/AIGC_pretrain/SUPIR_cache/SUPIR-v0F.ckpt", os.path.join(weights_dir, "SUPIR-v0F.ckpt")),
    ]
    count = 0
    for dirpath, _, filenames in os.walk(code_dir):
        for name in filenames:
            if not (name.endswith(".py") or name.endswith(".yaml")):
                continue
            file_path = os.path.join(dirpath, name)
            text = open(file_path, encoding="utf-8", errors="ignore").read()
            changed = text
            for old, new in replacements:
                changed = changed.replace(old, new.replace("\\", "/"))
            if changed != text:
                open(file_path, "w", encoding="utf-8", newline="").write(changed)
                count += 1
    # yaml lines with different names (SUPIR_CKPT_F/Q, SDXL_CKPT)
    for yaml_path in glob.glob(os.path.join(code_dir, "options", "*.yaml")):
        text = open(yaml_path, encoding="utf-8").read()
        new = text
        for key in ("SDXL_CKPT", "SUPIR_CKPT_F", "SUPIR_CKPT_Q"):
            value = os.path.join(weights_dir, "SUPIR-v0Q.ckpt" if key != "SDXL_CKPT" else "sd_xl_base_1.0_0.9vae.safetensors")
            new = re.sub(r"(?m)^%s:.*$" % key, "%s: '%s'" % (key, value.replace("\\", "/")), new)
        if new != text:
            open(yaml_path, "w", encoding="utf-8", newline="").write(new)
            count += 1
    log.append("rewrote linux paths in %d files" % count)


def patch_llava(code_dir, log):
    path = os.path.join(code_dir, r"llava\model\language_model\mpt\hf_prefixlm_converter.py")
    if os.path.isdir(os.path.dirname(path)):
        open(path, "w", encoding="utf-8", newline="").write(MPT_STUB)
        log.append("MPT stub written")
    for rel in (r"llava\model\language_model\llava_llama.py",):
        path = os.path.join(code_dir, rel)
        if not os.path.exists(path):
            continue
        text = open(path, encoding="utf-8").read()
        if "except ValueError" in text:
            continue
        for pattern in (r'AutoConfig\.register\("llava", LlavaConfig\)', r'AutoModel\.register\(LlavaConfig, LlavaLlamaForCausalLM\)'):
            text = re.sub(r"(?m)^(\s*)(" + pattern + r")",
                          lambda m: "%stry:\n%s    %s\nexcept ValueError:\n%s    pass" % (m.group(1), m.group(1), m.group(2), m.group(1)),
                          text)
        open(path, "w", encoding="utf-8", newline="").write(text)
        log.append("llava register guarded")


def patch_text_mask(code_dir, log):
    """torch>=2.9 rejects SUPIR's legacy CLIP text masks; drop them (no padding used)."""
    path = os.path.join(code_dir, r"sgm\modules\encoders\modules.py")
    if not os.path.exists(path):
        return
    text = open(path, encoding="utf-8").read()
    if "_lumina_mask" in text:
        return
    text = text.replace("import torch", "import torch\n\n\ndef _lumina_mask(attn_mask):\n    return None\n", 1)
    text = text.replace("x = checkpoint(r, x, attn_mask)", "x = checkpoint(r, x, _lumina_mask(attn_mask))")
    text = text.replace("x = r(x, attn_mask=attn_mask)", "x = r(x, attn_mask=_lumina_mask(attn_mask))")
    open(path, "w", encoding="utf-8", newline="").write(text)
    log.append("text-encoder mask patched")


def patch_sdpa(code_dir, log):
    count = 0
    for dirpath, _, filenames in os.walk(code_dir):
        for name in filenames:
            if not name.endswith(".py"):
                continue
            path = os.path.join(dirpath, name)
            text = open(path, encoding="utf-8", errors="ignore").read()
            if "xformers.ops.memory_efficient_attention(" not in text:
                continue
            text = text.replace("xformers.ops.memory_efficient_attention(", "_lumina_mea(")
            if "_lumina_mea" not in text.split("def _lumina_mea")[0] or "def _lumina_mea" not in text:
                text = SDPA_HELPER + "\n" + text
            open(path, "w", encoding="utf-8", newline="").write(text)
            count += 1
    log.append("sdpa fallback patched in %d files" % count)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--code-dir", required=True)
    parser.add_argument("--weights-dir", required=True)
    parser.add_argument("--keep-archives", action="store_true")
    args = parser.parse_args()
    log = []
    big_bin = extract_archives(args.weights_dir, log)
    write_ckpt_pth(args.code_dir, args.weights_dir, big_bin, log)
    rewrite_paths(args.code_dir, args.weights_dir, log)
    patch_llava(args.code_dir, log)
    patch_text_mask(args.code_dir, log)
    patch_sdpa(args.code_dir, log)
    if not args.keep_archives and not os.environ.get("LUMINA_KEEP_ARCHIVES"):
        freed = 0
        for pattern in ("*.tar",):
            for path in glob.glob(os.path.join(args.weights_dir, pattern)):
                try:
                    freed += os.path.getsize(path)
                    os.remove(path)
                except OSError:
                    pass
        log.append("removed weight archives, freed %.1f GB" % (freed / 1073741824))
    print(json.dumps({"ok": True, "changes": log}, ensure_ascii=False))


if __name__ == "__main__":
    main()
