"""Export real transparent layer PNGs from a finished Lumina project.

Reads: input/original.png (UI strip cropped), out/<final>.png, work/mask-v*.png
(alpha = subject), work/zone-*-mask-v*.png. Writes layers/person.png,
layers/background.png, layers/zones/*.png and a split sheet split-real-layers.jpg.
"""
import os, sys, glob
from PIL import Image, ImageOps, ImageDraw

def load_mask(path, size):
    im = Image.open(path)
    a = im.getchannel("A") if im.mode == "RGBA" else im.convert("L")
    h = a.histogram(); total = sum(h) or 1
    if sum(h[192:]) > total * 0.5:
        a = ImageOps.invert(a)
    if a.size != size:
        a = a.resize(size)
    return a

def main(argv):
    project = argv[1]
    out_dir = os.path.join(project, "layers"); os.makedirs(out_dir, exist_ok=True)
    src = Image.open(os.path.join(project, "input", "original.png")).convert("RGB")
    outs = sorted(glob.glob(os.path.join(project, "out", "*.png")))
    if not outs:
        print("no output"); return 1
    out = Image.open(outs[-1]).convert("RGB")
    if src.size != out.size:
        src = src.crop((0, 0, src.width, src.height - 149))
    masks = sorted(glob.glob(os.path.join(project, "work", "mask-v*.png")))
    if masks:
        alpha = load_mask(masks[-1], out.size)
        person = out.convert("RGBA"); person.putalpha(alpha)
        person.save(os.path.join(out_dir, "person.png"))
        bg = out.convert("RGBA"); bg.putalpha(ImageOps.invert(alpha))
        bg.save(os.path.join(out_dir, "background.png"))
    zones_dir = os.path.join(out_dir, "zones"); os.makedirs(zones_dir, exist_ok=True)
    for i, zp in enumerate(sorted(glob.glob(os.path.join(project, "work", "zone-*-mask-v*.png"))), 1):
        z = load_mask(zp, out.size)
        zi = out.convert("RGBA"); zi.putalpha(z)
        zi.save(os.path.join(zones_dir, "zone-%d.png" % i))
    # split sheet
    panels = [("A original", src), ("B person layer", None), ("C background layer", None), ("D final", out)]
    if masks:
        panels[1] = ("B person layer", Image.open(os.path.join(out_dir, "person.png")))
        panels[2] = ("C background layer", Image.open(os.path.join(out_dir, "background.png")))
    def flat(im):
        base = Image.new("RGB", im.size, (20, 20, 20)); base.paste(im, mask=im.getchannel("A")); return base
    pw = 1100; cells = []
    for label, im in panels:
        im = flat(im) if im.mode == "RGBA" else im
        im = im.copy(); im.thumbnail((pw, 2000)); cells.append((label, im))
    cw, ch = pw, max(im.height for _, im in cells); canvas = Image.new("RGB", (2*cw+30, 2*(ch+50)+20), (24,24,24)); dr = ImageDraw.Draw(canvas)
    for idx, (label, im) in enumerate(cells):
        cx = (idx % 2)*cw+10; cy = (idx//2)*(ch+50)+40
        canvas.paste(im, (cx, cy)); dr.text((cx, cy-24), label, fill=(255,220,120)); dr.rectangle([cx-1, cy-1, cx+im.width, cy+im.height], outline=(90,90,90))
    canvas.resize((canvas.width//2, canvas.height//2), Image.LANCZOS).save(os.path.join(project, "split-real-layers.jpg"), quality=88)
    print("layers exported")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))