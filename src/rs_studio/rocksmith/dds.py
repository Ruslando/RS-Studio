"""Album art: procedural cover rendered with Pillow, saved as DDS (64/128/256).

Tries DXT1-compressed DDS first (what official art uses); falls back to
uncompressed RGBA DDS on older Pillow versions.
"""
from __future__ import annotations

import hashlib
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def _cover(title: str, artist: str) -> Image.Image:
    digest = hashlib.md5(f"{artist}-{title}".encode()).digest()
    top = tuple(60 + d % 140 for d in digest[:3])
    bottom = tuple(20 + d % 90 for d in digest[3:6])
    img = Image.new("RGB", (512, 512))
    px = img.load()
    for y in range(512):
        f = y / 511
        row = tuple(int(t + (b - t) * f) for t, b in zip(top, bottom))
        for x in range(512):
            px[x, y] = row
    draw = ImageDraw.Draw(img)
    try:
        font_big = ImageFont.load_default(size=44)
        font_small = ImageFont.load_default(size=28)
    except TypeError:  # Pillow < 10 default font has no size
        font_big = font_small = ImageFont.load_default()

    def fit(text, font, max_w=460) -> str:
        while text and draw.textlength(text, font=font) > max_w:
            text = text[:-1]
        return text

    draw.text((26, 380), fit(title, font_big), fill=(240, 240, 240), font=font_big)
    draw.text((26, 440), fit(artist, font_small), fill=(200, 200, 200), font=font_small)
    return img


def _save_dds(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    try:
        img.convert("RGBA").save(buf, "DDS", pixel_format="DXT1")
    except (TypeError, ValueError, OSError):
        buf = io.BytesIO()
        img.convert("RGBA").save(buf, "DDS")
    return buf.getvalue()


def _load_cover(path: Path) -> Image.Image | None:
    try:
        resampling = getattr(Image, "Resampling", Image).LANCZOS
        with Image.open(path) as img:
            return ImageOps.fit(img.convert("RGB"), (512, 512), method=resampling)
    except Exception:
        return None


def album_art(title: str, artist: str, cover_path: Path | None = None) -> dict[int, bytes]:
    base = _load_cover(cover_path) if cover_path else None
    if base is None:
        base = _cover(title, artist)
    return {size: _save_dds(base.resize((size, size), Image.LANCZOS))
            for size in (64, 128, 256)}
