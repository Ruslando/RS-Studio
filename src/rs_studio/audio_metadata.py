"""Read common song tags and embedded cover art from uploaded audio."""
from __future__ import annotations

import base64
import re
from pathlib import Path

from mutagen import File as MutagenFile


_TEXT_TAGS = {
    "title": ("title", "tit2", "©nam", "inam"),
    "artist": ("artist", "tpe1", "©art", "iart"),
    "album": ("album", "talb", "©alb", "iprd"),
    "date": ("date", "year", "tdrc", "tyer", "©day", "icrd"),
}
_MAX_COVER_BYTES = 20 * 1024 * 1024
_MAX_COVER_B64_BYTES = (_MAX_COVER_BYTES * 4 // 3) + 8


def _tag_value(tags, aliases: tuple[str, ...]) -> str:
    if not tags:
        return ""
    wanted = {key.casefold() for key in aliases}
    for key, raw in tags.items():
        if str(key).casefold() not in wanted:
            continue
        raw = getattr(raw, "text", raw)
        if isinstance(raw, (list, tuple)):
            raw = raw[0] if raw else ""
        value = str(raw or "").strip()
        if value:
            return value[:180]
    return ""


def _pictures(audio, tags) -> list[tuple[bytes, str, int | None]]:
    found: list[tuple[bytes, str, int | None]] = []
    for picture in getattr(audio, "pictures", ()) or ():
        data = getattr(picture, "data", b"")
        if data:
            found.append((data, getattr(picture, "mime", ""), getattr(picture, "type", None)))

    getall = getattr(tags, "getall", None)
    if getall:
        for picture in getall("APIC"):
            data = getattr(picture, "data", b"")
            if data and getattr(picture, "mime", "") != "-->" and len(data) <= _MAX_COVER_BYTES:
                found.append((data, getattr(picture, "mime", ""), getattr(picture, "type", None)))

    if tags:
        lowered = {str(key).casefold(): value for key, value in tags.items()}
        for value in lowered.get("covr", ()) or ():
            if len(value) > _MAX_COVER_BYTES:
                continue
            data = bytes(value)
            if data:
                image_format = str(getattr(value, "imageformat", ""))
                found.append((data, f"image/{image_format.lower()}" if image_format else "", None))

        blocks = lowered.get("metadata_block_picture", ()) or ()
        if isinstance(blocks, (str, bytes)):
            blocks = [blocks]
        for block in blocks:
            try:
                from mutagen.flac import Picture
                encoded = block if isinstance(block, bytes) else str(block).encode("ascii")
                if len(encoded) > _MAX_COVER_B64_BYTES:
                    continue
                picture = Picture(base64.b64decode(encoded, validate=True))
                if picture.data:
                    found.append((picture.data, picture.mime, picture.type))
            except Exception:
                continue

        coverarts = lowered.get("coverart", ()) or ()
        mime_values = lowered.get("coverartmime", ()) or ()
        if isinstance(coverarts, (str, bytes)):
            coverarts = [coverarts]
        if isinstance(mime_values, (str, bytes)):
            mime_values = [mime_values]
        for index, cover in enumerate(coverarts):
            try:
                if len(cover) > _MAX_COVER_B64_BYTES:
                    continue
                data = base64.b64decode(cover, validate=True)
            except Exception:
                continue
            mime = mime_values[index] if index < len(mime_values) else ""
            if data:
                found.append((data, str(mime), None))
    return [picture for picture in found if len(picture[0]) <= _MAX_COVER_BYTES]


def extract_audio_metadata(path: Path) -> dict:
    """Return normalized text tags and optional embedded artwork bytes.

    Unsupported or untagged files simply return empty values. Malformed tags do
    not prevent the audio itself from being uploaded and processed.
    """
    result = {"title": "", "artist": "", "album": "", "year": "", "cover": None, "coverMime": ""}
    try:
        audio = MutagenFile(path)
        tags = getattr(audio, "tags", None) if audio else None
        for field, aliases in _TEXT_TAGS.items():
            value = _tag_value(tags, aliases)
            if field == "date":
                match = re.search(r"(?<!\d)(\d{4})(?!\d)", value)
                value = match.group(1) if match else ""
                field = "year"
            result[field] = value

        pictures = _pictures(audio, tags) if audio else []
        if pictures:
            data, mime, _ = next((item for item in pictures if item[2] == 3), pictures[0])
            result["cover"] = data
            result["coverMime"] = mime
    except Exception:
        pass
    return result
