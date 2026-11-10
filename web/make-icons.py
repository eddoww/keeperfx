#!/usr/bin/env python3
"""Make the app icons in web/icons/ from res/keeperfx_icon512-24bpp.png.

Usage: web/make-icons.py   (needs Pillow; the results are committed)

  icon-192.png, icon-512.png       the Horny face on a transparent background
  maskable-192.png, maskable-512.png   on the site's dark stone with an ember glow,
                                   the face inside the middle 80% so any mask
                                   shape (circle, squircle) keeps it whole
  apple-touch-icon.png (180)       the same, opaque, for iOS home screens
"""
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "res", "keeperfx_icon512-24bpp.png")
OUT = os.path.join(ROOT, "web", "icons")
BG = (10, 7, 6)          # --bg
GLOW = (226, 86, 43)     # --ember


def backdrop(size):
    img = Image.new("RGBA", (size, size), BG + (255,))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    r = size * 0.36
    ImageDraw.Draw(glow).ellipse((size / 2 - r, size * 0.47 - r, size / 2 + r, size * 0.47 + r), fill=GLOW + (95,))
    return Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(size * 0.12)))


def padded(face, size, scale):
    img = backdrop(size)
    s = round(size * scale)
    img.alpha_composite(face.resize((s, s), Image.LANCZOS), ((size - s) // 2, (size - s) // 2))
    return img


def main():
    face = Image.open(SRC).convert("RGBA")
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        face.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon-{size}.png"), optimize=True)
        padded(face, size, 0.72).save(os.path.join(OUT, f"maskable-{size}.png"), optimize=True)
    padded(face, 180, 0.84).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"), optimize=True)


if __name__ == "__main__":
    main()
