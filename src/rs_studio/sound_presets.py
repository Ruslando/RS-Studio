"""JSON-only preset files shared with the Sound Designer."""
from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

from .rocksmith.tones import custom_tone

MAX_PRESET_BYTES = 1024 * 1024
MAX_PRESET_FILES = 256


def portable_tone_lanes(lanes: list, presets: dict) -> list:
    """Embed definitions in an exported file without changing saved references."""
    result = deepcopy(lanes)
    for lane in result:
        for marker in lane.get("toneMarkers") or []:
            tone = presets.get(marker.get("tone"))
            if tone is not None:
                marker["toneData"] = custom_tone(tone, "Custom")
    return result


def decode_presets(data: bytes) -> list[dict]:
    if len(data) > MAX_PRESET_BYTES:
        raise ValueError("Preset exceeds the 1 MiB file limit")
    raw = json.loads(data.decode("utf-8-sig"))
    if isinstance(raw, dict) and raw.get("format") == "rs-studio.sound-presets":
        if raw.get("version") != 1:
            raise ValueError("Unsupported preset library version")
        entries = raw.get("presets")
    else:
        entries = raw if isinstance(raw, list) else [raw]
    if not isinstance(entries, list) or not 1 <= len(entries) <= 100:
        raise ValueError("A preset file must contain 1–100 tones")
    tones = []
    for entry in entries:
        tone = entry.get("tone", entry) if isinstance(entry, dict) else entry
        key = tone.get("Key", "Custom") if isinstance(tone, dict) else "Custom"
        tones.append(custom_tone(tone, key))
    return tones


def read_preset_folder(folder: Path, bundled: Path) -> dict:
    """Seed portable installs once, then read the user's files without changing them."""
    folder.mkdir(parents=True, exist_ok=True)
    if folder.resolve() != bundled.resolve() and not (folder / ".defaults-seeded").exists():
        for source in sorted(bundled.glob("*.json")):
            try:
                with (folder / source.name).open("xb") as output:
                    output.write(source.read_bytes())
            except FileExistsError:
                pass
        (folder / ".defaults-seeded").write_text("1\n", encoding="utf-8")
    presets, errors = [], []
    files = sorted((path for path in folder.iterdir() if path.suffix.lower() == ".json"), key=lambda path: path.name.casefold())
    for path in files[:MAX_PRESET_FILES]:
        try:
            if path.is_symlink() or not path.is_file():
                raise ValueError("Only regular JSON files in the preset folder are supported")
            with path.open("rb") as source:
                data = source.read(MAX_PRESET_BYTES + 1)
            tones = decode_presets(data)
            for index, tone in enumerate(tones):
                suffix = f":{index + 1}" if len(tones) > 1 else ""
                presets.append({"id": f"file:{path.name}{suffix}", "file": path.name, "tone": tone})
        except (OSError, ValueError, TypeError, AttributeError, RecursionError) as error:
            errors.append({"file": path.name, "error": str(error)})
    if len(files) > MAX_PRESET_FILES:
        errors.append({"file": "", "error": f"Only the first {MAX_PRESET_FILES} JSON files were read"})
    return {"folder": str(folder.resolve()), "presets": presets, "errors": errors}
