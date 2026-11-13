"""Renders the VidQueue icon (same design as extension/icons/icon.svg) to
assets/vidqueue.png (tray, About) and assets/vidqueue.ico (exe). Run from the
repo root:  .venv\\Scripts\\python.exe tools\\make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
S = 1024  # draw large, downsample for smooth edges


def render(size):
    k = S / 64
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((4 * k, 10 * k, 60 * k, 54 * k), int(9 * k), fill=(47, 111, 237, 255))
    d.polygon([(25 * k, 21 * k), (25 * k, 37 * k), (38 * k, 29 * k)], fill=(255, 255, 255, 255))
    d.rounded_rectangle((16 * k, 43 * k, 48 * k, 47 * k), int(2 * k), fill=(255, 255, 255, 230))
    d.rounded_rectangle((16 * k, 43 * k, 34 * k, 47 * k), int(2 * k), fill=(159, 230, 184, 255))
    return im.resize((size, size), Image.Resampling.LANCZOS)


def main():
    out = ROOT / "assets"
    out.mkdir(exist_ok=True)
    render(256).save(out / "vidqueue.png")
    big = render(256)
    big.save(out / "vidqueue.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    for n in (48, 96):  # PNG icons for the extension (AMO / about:addons)
        render(n).save(ROOT / "extension" / "icons" / f"icon-{n}.png")
    print("icons written")


if __name__ == "__main__":
    main()
