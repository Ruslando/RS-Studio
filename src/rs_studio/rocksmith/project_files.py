"""The DLC Builder project files for an exported package, as its PSARC import makes them.

Rocksmith2014.NET's PsarcImporter.import unpacks and converts a package into a
project folder: arrangement XML, showlights, cover, audio, `.phrase-levels` and an
`.rs2dlc` project. This builds the same files from what the export already has, so
the project zip opens in DLC Builder as if the package had been imported there.
"""
from __future__ import annotations

import json
import math
import re
import struct
import unicodedata
import uuid
from decimal import ROUND_HALF_UP, Decimal

import numpy as np

from .arrangement_xml import arrangement_xml

# Enum values DLC Builder stores (DLCProject/Arrangement.fs).
_ARRANGEMENT_NAMES = {"Lead": 0, "Combo": 1, "Rhythm": 2, "Bass": 3}
_ROUTE_LEAD, _ROUTE_RHYTHM, _ROUTE_BASS = 1, 2, 4
_PRIORITY_MAIN, _PRIORITY_ALTERNATIVE, _PRIORITY_BONUS = 0, 1, 2
_TONE_SLOTS = ("Rack1", "Rack2", "Rack3", "Rack4", "Amp", "Cabinet", "PrePedal1", "PrePedal2",
               "PrePedal3", "PrePedal4", "PostPedal1", "PostPedal2", "PostPedal3", "PostPedal4")


class _Float32(float):
    """A value .NET holds as float32: written as the shortest text that reads back as one."""


def _number(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, _Float32):
        return np.format_float_positional(np.float32(value), trim="-")
    if float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(float(value))


def _string(text: str) -> str:
    """System.Text.Json's default escaping: non-ASCII and HTML-sensitive characters as \\uXXXX."""
    out = json.dumps(text, ensure_ascii=True)
    out = re.sub(r"\\u([0-9a-f]{4})", lambda m: "\\u" + m.group(1).upper(), out)
    for ch, code in (("&", "0026"), ("'", "0027"), ("+", "002B"), ("<", "003C"), (">", "003E"), ("`", "0060")):
        out = out.replace(ch, "\\u" + code)
    return out


def _json(value, indent: int | None, depth: int = 0) -> str:
    """System.Text.Json: two-space indent, `"key": value`, `[]` and `{}` when empty."""
    if isinstance(value, dict):
        if not value:
            return "{}"
        if indent is None:
            return "{" + ",".join(f"{_string(k)}:{_json(v, None)}" for k, v in value.items()) + "}"
        pad, inner = "\n" + "  " * depth, "\n" + "  " * (depth + 1)
        return "{" + ",".join(f"{inner}{_string(k)}: {_json(v, indent, depth + 1)}" for k, v in value.items()) + pad + "}"
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        if indent is None:
            return "[" + ",".join(_json(v, None) for v in value) + "]"
        pad, inner = "\n" + "  " * depth, "\n" + "  " * (depth + 1)
        return "[" + ",".join(f"{inner}{_json(v, indent, depth + 1)}" for v in value) + pad + "]"
    if isinstance(value, str):
        return _string(value)
    if value is None:
        return "null"
    return _number(value)


def _guid(value: str) -> str:
    """A manifest id (32 hex digits, any case) as .NET writes a Guid."""
    return str(uuid.UUID(hex=str(value)))


def _round_half_away(value: float, digits: int) -> float:
    return float(Decimal(repr(value)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def _f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", float(value)))[0]


def file_name(text: str) -> str:
    """StringValidator.fileName: diacritics removed, only [ 0-9a-zA-Z_-] kept, whitespace as one dash."""
    plain = "".join(ch for ch in unicodedata.normalize("NFD", text) if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", "-", re.sub(r"[^ 0-9a-zA-Z_-]", "", plain))


def _pedal(pedal: dict) -> dict:
    """Tone.toPedalDto, through Tone.fromDto: knob values sorted by key (an F# Map)."""
    out = {"Type": pedal.get("Type"),
           "KnobValues": {k: _Float32(v) for k, v in sorted((pedal.get("KnobValues") or {}).items())},
           "Key": pedal.get("Key")}
    if pedal.get("Category") is not None:
        out["Category"] = pedal["Category"]
    if pedal.get("Skin") is not None:
        out["Skin"] = pedal["Skin"]
    if pedal.get("SkinIndex") is not None:
        out["SkinIndex"] = _Float32(pedal["SkinIndex"])
    return out


def _volume(value) -> str:
    """Tone volume: parsed and rounded to a tenth (away from zero), written with three decimals."""
    text = re.sub(r"[^0-9.-]", "", str(value).replace(",", "."))
    return f"{_round_half_away(float(text), 1):.3f}"


def _tone(tone: dict) -> dict:
    """A manifest tone as the project stores it (Tone.toDto)."""
    gear = tone.get("GearList") or {}
    cabinet = gear.get("Cabinet") or {"Type": "Cabinets", "Key": "Cab_Marshall1960TV_Ribbon_Cone", "KnobValues": {}}
    slots = {**gear, "Cabinet": cabinet}
    out = {"GearList": {slot: _pedal(slots[slot]) for slot in _TONE_SLOTS if slots.get(slot)},
           "ToneDescriptors": list(tone.get("ToneDescriptors") or []),
           "NameSeparator": tone.get("NameSeparator") or " - ",
           "IsCustom": True,
           "Volume": _volume(tone.get("Volume", 0))}
    if tone.get("MacVolume") is not None:
        out["MacVolume"] = _volume(tone["MacVolume"])
    out["Key"] = tone.get("Key")
    out["Name"] = tone.get("Name")
    if tone.get("SortOrder") is not None:
        out["SortOrder"] = _Float32(tone["SortOrder"])
    return out


def _instrumental(xml_name: str, attrs: dict) -> dict:
    """PsarcImportUtils.importInstrumental, as the project file stores it."""
    props = attrs.get("ArrangementProperties") or {}
    route = _ROUTE_BASS if props.get("pathBass") == 1 else _ROUTE_LEAD if props.get("pathLead") == 1 else _ROUTE_RHYTHM
    priority = (_PRIORITY_MAIN if props.get("represent") == 1
                else _PRIORITY_BONUS if props.get("bonusArr") == 1 else _PRIORITY_ALTERNATIVE)
    density = attrs.get("DynamicVisualDensity") or [1.3]
    top = min(int(attrs.get("MaxPhraseDifficulty") or 0), len(density) - 1)
    tuning = attrs.get("Tuning") or {}
    cents = float(attrs.get("CentOffset") or 0)
    return {
        "ID": str(uuid.uuid4()),   # a new id per import, as DLC Builder makes it
        "XML": xml_name,
        "Name": _ARRANGEMENT_NAMES.get(attrs.get("ArrangementName"), 0),
        "RouteMask": route,
        "Priority": priority,
        "ScrollSpeed": _round_half_away(_f32(density[top]), 1),
        "BassPicked": props.get("bassPick") == 1,
        "Tuning": [int(tuning.get(f"string{i}", 0)) for i in range(6)],
        "TuningPitch": round(440 * math.pow(math.pow(2, 1 / 1200), cents), 2),
        "BaseTone": attrs.get("Tone_Base") or "",
        "Tones": [name for name in (attrs.get(f"Tone_{slot}") for slot in "ABCD") if name],
        "MasterID": int(attrs.get("MasterID_RDV") or 0),
        "PersistentID": _guid(attrs["PersistentID"]),
    }


def project_files(arrangements: list, *, dlc_key: str, showlights: bytes, cover_dds: bytes,
                  main_wem: bytes, preview_wem: bytes, main_volume: float, preview_volume: float,
                  version: int, author: str) -> dict[str, bytes]:
    """The files of DLC Builder's project folder, by name.

    arrangements: (file name as in the package, e.g. "lead2", shipped SNG, manifest attributes).
    """
    low = dlc_key.lower()
    files: dict[str, bytes] = {"cover.dds": cover_dds, "arr_showlights_RS2.xml": showlights,
                               f"{low}.wem": main_wem, f"{low}_preview.wem": preview_wem}
    entries, levels, tones = [], {}, {}
    for name, song, attrs in arrangements:
        xml_name = f"arr_{name}_RS2.xml"
        files[xml_name] = arrangement_xml(song, attrs)
        entries.append(_instrumental(xml_name, attrs))
        levels[_guid(attrs["PersistentID"])] = {p.name: p.max_difficulty for p in song.phrases}
        for tone in attrs.get("Tones") or []:
            if tone and (tone.get("GearList") or {}).get("Amp") and tone.get("Key") not in tones:
                tones[tone.get("Key")] = _tone(tone)
    # Arrangement.sorter: by route, then priority; the showlights last.
    entries.sort(key=lambda a: (a["RouteMask"], a["Priority"]))
    arrangements_dto = [{"Case": "Instrumental", "Fields": [a]} for a in entries]
    arrangements_dto.append({"Case": "Showlights", "Fields": [{"ID": str(uuid.uuid4()), "XML": "arr_showlights_RS2.xml"}]})

    attrs = arrangements[0][2] if arrangements else {}
    project = {"Version": str(version)}
    if author:
        project["Author"] = author
    project["DLCKey"] = attrs.get("DLCKey") or dlc_key
    project["ArtistName"] = {"Value": attrs.get("ArtistName"), "SortValue": attrs.get("ArtistNameSort")}
    if attrs.get("JapaneseArtistName"):
        project["JapaneseArtistName"] = attrs["JapaneseArtistName"]
    if attrs.get("JapaneseSongName"):
        project["JapaneseTitle"] = attrs["JapaneseSongName"]
    project["Title"] = {"Value": attrs.get("SongName"), "SortValue": attrs.get("SongNameSort")}
    project["AlbumName"] = {"Value": attrs.get("AlbumName"), "SortValue": attrs.get("AlbumNameSort")}
    project["Year"] = int(attrs.get("SongYear") or 0)
    project["AlbumArtFile"] = "cover.dds"
    # The volume as the sound bank stores it (float32), rounded to a tenth.
    project["AudioFile"] = {"Path": f"{low}.wem", "Volume": round(_f32(main_volume), 1)}
    project["AudioPreviewFile"] = {"Path": f"{low}_preview.wem", "Volume": round(_f32(preview_volume), 1)}
    project["IgnoredIssues"] = []
    project["Arrangements"] = arrangements_dto
    project["Tones"] = list(tones.values())

    rs2dlc = file_name(f"{attrs.get('ArtistNameSort') or ''}_{attrs.get('SongNameSort') or ''}") + ".rs2dlc"
    # Written on Windows, where DLC Builder's JSON writer ends lines with CRLF.
    files[rs2dlc] = _json(project, 2).replace("\n", "\r\n").encode("utf-8")
    files[".phrase-levels"] = _json(levels, None).encode("utf-8")
    return files
