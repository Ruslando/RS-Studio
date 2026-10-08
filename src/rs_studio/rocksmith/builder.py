"""Assemble a complete Rocksmith 2014 PC CDLC (.psarc) from an editor spec.

Entry point: build_cdlc(spec, audio_path). The spec is the same payload the
.gp5 export uses (tracks with seconds-based notes + string/fret, tempo grid);
audio comes from the project's original upload. One arrangement per package
used to be emitted; the export dialog can now choose several Rocksmith
arrangements from the editor lanes.
"""
from __future__ import annotations

import re
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import soundfile as sf

from . import bnk, chart, dds, manifest, psarc, sng, wem
from .wem import AudioConverterNotFoundError, WwiseNotFoundError  # public error types

_STANDARD_GUITAR = [40, 45, 50, 55, 59, 64]  # low->high E standard
_STANDARD_BASS = [28, 33, 38, 43]
PREVIEW_SECONDS = 28.0


@dataclass
class SongContext:
    dlc_key: str
    title: str
    artist: str
    album: str
    year: int
    is_bass: bool
    arrangement: dict
    representative: bool
    arrangement_sort: int
    persistent_id: uuid.UUID
    master_id: int
    tone: dict
    tone_slots: list[dict]
    compiled: chart.Compiled


# "type" is the RS ArrangementType ordinal (Rocksmith2014.XML ArrangementName
# enum: Lead=0, Combo=1, Rhythm=2, Bass=3 — Combo is RS1-era and unused by
# modern CDLC tooling, so it's not offered here). "priority" mirrors RS's
# ArrangementPriority (Main/Alternative/Bonus): Main is the one Representative
# arrangement per route, Alternative and Bonus are both extra, non-representative
# arrangements on the same route — they differ only in the "bonusArr" manifest
# flag (shown separately in-game), not in any format/gameplay behavior.
ARRANGEMENTS = {
    "lead": {"name": "Lead", "full_name": "Lead", "tag": "lead", "path": "lead",
             "route": 1, "type": 0, "priority": "main", "is_bass": False},
    "alt_lead": {"name": "Lead", "full_name": "AltLead", "tag": "alt_lead", "path": "lead",
                 "route": 1, "type": 0, "priority": "alt", "is_bass": False},
    "bonus_lead": {"name": "Lead", "full_name": "BonusLead", "tag": "bonus_lead", "path": "lead",
                   "route": 1, "type": 0, "priority": "bonus", "is_bass": False},
    "rhythm": {"name": "Rhythm", "full_name": "Rhythm", "tag": "rhythm", "path": "rhythm",
               "route": 2, "type": 2, "priority": "main", "is_bass": False},
    "alt_rhythm": {"name": "Rhythm", "full_name": "AltRhythm", "tag": "alt_rhythm", "path": "rhythm",
                   "route": 2, "type": 2, "priority": "alt", "is_bass": False},
    "bonus_rhythm": {"name": "Rhythm", "full_name": "BonusRhythm", "tag": "bonus_rhythm", "path": "rhythm",
                     "route": 2, "type": 2, "priority": "bonus", "is_bass": False},
    "bass": {"name": "Bass", "full_name": "Bass", "tag": "bass", "path": "bass",
             "route": 4, "type": 3, "priority": "main", "is_bass": True},
    "alt_bass": {"name": "Bass", "full_name": "AltBass", "tag": "alt_bass", "path": "bass",
                 "route": 4, "type": 3, "priority": "alt", "is_bass": True},
    "bonus_bass": {"name": "Bass", "full_name": "BonusBass", "tag": "bonus_bass", "path": "bass",
                   "route": 4, "type": 3, "priority": "bonus", "is_bass": True},
}


def _song_meta(spec: dict) -> tuple[str, str, str, int]:
    meta = spec.get("metadata") or {}
    name = (spec.get("name") or "Untitled").strip()
    title = (meta.get("title") or "").strip()
    artist = (meta.get("artist") or "").strip()
    album = (meta.get("album") or "").strip() or "RS Studio"
    try:
        year = int(meta.get("year") or 0)
    except (TypeError, ValueError):
        year = 0
    if not (1000 <= year <= 9999):
        year = datetime.now().year
    if title:
        return artist or "Unknown Artist", title, album, year
    if " - " in name:
        artist, title = name.split(" - ", 1)
        return artist.strip() or "Unknown Artist", title.strip() or name, album, year
    return artist or "Unknown Artist", name, album, year


def _dlc_key(artist: str, title: str) -> str:
    """The package's internal identifier, derived from the song title.

    Alphanumerics only, and that is load-bearing well beyond tidiness: this key
    is interpolated straight into XML attributes, RDF literals and psarc paths
    across manifest.py with no escaping anywhere. The regex below is what makes
    that safe, so manifest.py asserts the shape rather than trusting it from a
    distance. A user-supplied title reaches here verbatim.
    """
    import hashlib
    stem = re.sub(r"[^A-Za-z0-9]", "", title.title())[:14] or "Song"
    suffix = hashlib.md5(f"{artist}-{title}".encode()).hexdigest()[:4]
    return f"MTT{stem}{suffix}"


def _cdlc_filename(artist: str, title: str) -> str:
    """CustomsForge/Toolkit convention: Artist-Name_Song-Title_v1_p.psarc
    (underscores between fields, hyphens for spaces within a field, _p = PC)."""
    def clean(s: str) -> str:
        s = re.sub(r'[<>:"/\\|?*]', "", s).strip()
        return re.sub(r"\s+", "-", s) or "Unknown"
    return f"{clean(artist)}_{clean(title)}_v1_p.psarc"


def _tuning_offsets(tuning_hi_lo: list[int], warnings: list[str]) -> tuple[list[int], bool]:
    """Editor tuning (hi->lo midi) -> RS int16[6] offsets from standard."""
    n = len(tuning_hi_lo)
    if n == 6:
        ref, is_bass = _STANDARD_GUITAR, False
    elif n == 4:
        ref, is_bass = _STANDARD_BASS, True
    else:
        raise ValueError(f"Rocksmith supports 6-string guitar or 4-string bass lanes, got {n} strings")
    low_high = list(reversed([int(p) for p in tuning_hi_lo]))
    offsets = []
    for midi, std in zip(low_high, ref):
        off = midi - std
        reduced = ((off + 6) % 12) - 6  # octave-reduce (lanes may sit an octave off)
        if reduced != off:
            warnings.append(f"Tuning offset {off:+d} octave-reduced to {reduced:+d}")
        offsets.append(reduced)
    return offsets + [0] * (6 - len(offsets)), is_bass


def _prepare_audio(audio_path: Path, first_note: float, workdir: Path,
                   warnings: list[str]) -> tuple[Path, Path, float, float]:
    """Returns (main wav, preview wav, song length, bank volume dB)."""
    try:
        data, sr = sf.read(str(audio_path), always_2d=True)
    except Exception:
        import librosa
        y, sr = librosa.load(str(audio_path), sr=None, mono=False)
        data = np.atleast_2d(y).T
    length = len(data) / sr

    rms = float(np.sqrt(np.mean(np.square(data.mean(axis=1))))) or 1e-6
    rms_db = 20 * np.log10(rms)
    volume = float(np.clip(-16.0 - rms_db, -15.0, 3.0))

    main = workdir / "main.wav"
    sf.write(str(main), data, sr, subtype="PCM_16")

    start = max(0.0, min(first_note - 1.0, max(0.0, length - PREVIEW_SECONDS)))
    seg = data[int(start * sr):int((start + PREVIEW_SECONDS) * sr)].copy()
    fade_in = min(int(1.0 * sr), len(seg))
    fade_out = min(int(3.0 * sr), len(seg))
    seg[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
    seg[len(seg) - fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
    preview = workdir / "preview.wav"
    sf.write(str(preview), seg, sr, subtype="PCM_16")
    return main, preview, length, volume


def _arrangement_specs(spec: dict, tracks: list[dict], warnings: list[str]) -> list[dict]:
    requested = ((spec.get("rocksmith") or {}).get("arrangements") or [])
    if not requested:
        idx = int(spec.get("track") or 0) % len(tracks)
        track = tracks[idx]
        try:
            # The warnings this would emit are about the *chosen* tuning, and
            # here we only want to know guitar vs bass; the real call below runs
            # on the same tuning and collects them.
            _, is_bass = _tuning_offsets(track.get("tuning") or [], [])
        except ValueError:
            is_bass = False
        if len(tracks) > 1:
            warnings.append(f"Multiple lanes: exported '{track.get('name') or 'lane 1'}' only")
        return [{"track": idx, "kind": "bass" if is_bass else "lead"}]
    out = []
    used_tags = set()
    for item in requested:
        idx = int(item.get("track") or 0)
        if idx < 0 or idx >= len(tracks):
            raise ValueError("Rocksmith arrangement refers to an unknown lane")
        kind = item.get("kind") or "lead"
        arr = ARRANGEMENTS.get(kind)
        if arr is None:
            raise ValueError(f"Unknown Rocksmith arrangement type: {kind}")
        if arr["tag"] in used_tags:
            raise ValueError("Rocksmith arrangement types must be unique in one package")
        used_tags.add(arr["tag"])
        out.append({"track": idx, "kind": kind, "tuning": item.get("tuning")})
    if not out:
        raise ValueError("No Rocksmith arrangements selected")
    return out


_TONE_PRESETS = {"lead", "clean", "crunch", "bass"}


def _arrangement_tones(track: dict, is_bass: bool, key: str, tag: str,
                       song_length: float, warnings: list[str]) -> tuple[dict, list[dict], list[tuple[float, int]]]:
    """Resolve one lane's authored switches to a base tone, slots, and SNG events."""
    default = "bass" if is_bass else "lead"
    markers = []
    for index, raw in enumerate(track.get("toneMarkers") or []):
        try:
            time = float(raw.get("t", raw.get("seconds")))
        except (AttributeError, TypeError, ValueError):
            continue
        tone = str(raw.get("tone", raw.get("preset", ""))).strip().lower()
        if tone not in _TONE_PRESETS:
            warnings.append(f"Ignored unknown Rocksmith tone preset '{tone or '?'}'")
            continue
        if not 0 <= time <= song_length:
            warnings.append(f"Ignored Rocksmith tone switch outside the song at {time:.3f}s")
            continue
        markers.append((time, index, tone))
    markers.sort()
    # The UI disallows same-time markers. Keep the last one when importing a
    # hand-edited project, matching the intuitive "latest change wins" rule.
    collapsed = []
    for time, _, tone in markers:
        if collapsed and abs(time - collapsed[-1][0]) < 1e-6:
            collapsed[-1] = (time, tone)
        else:
            collapsed.append((time, tone))

    base_name = default
    remaining = []
    for time, tone in collapsed:
        if time <= 1e-6:
            base_name = tone
        else:
            remaining.append((time, tone))

    used_slots = []
    current = base_name
    for _, tone in remaining:
        if tone != current and tone not in used_slots:
            used_slots.append(tone)
        current = tone
    if len(used_slots) > 4:  # RS2014 hard limit: Tone_A..D, 4 switchable slots per arrangement.
        raise ValueError("Rocksmith supports at most four switchable tones per arrangement")

    def load(name: str) -> dict:
        return manifest.load_internal_tone(name, f"{key}_{tag}_{name}_tone")

    base = load(base_name)
    slots = [load(name) for name in used_slots]
    slot_ids = {name: index for index, name in enumerate(used_slots)}
    events = []
    current = base_name
    for time, tone in remaining:
        if tone == current:
            continue
        events.append((time, slot_ids[tone]))
        current = tone
    return base, slots, events


def build_cdlc(spec: dict, audio_path: Path | None, *, wwise_console: str | None = None,
               _wems: tuple[bytes, bytes] | None = None,
               _song_length: float | None = None,
               cover_art_path: Path | None = None) -> tuple[bytes, list[str], str]:
    """Build the psarc. Returns (bytes, warnings, download filename).

    _wems/_song_length bypass the WEM conversion + audio steps for the self-check.
    """
    warnings: list[str] = []
    tracks = spec.get("tracks") or []
    if not tracks:
        raise ValueError("No lanes with notes to export")
    arr_requests = _arrangement_specs(spec, tracks, warnings)
    artist, title, album, year = _song_meta(spec)
    key = _dlc_key(artist, title)
    low = key.lower()

    with tempfile.TemporaryDirectory(prefix="cw-rs-") as tmp:
        workdir = Path(tmp)
        starts = [
            float(n["start"])
            for req in arr_requests
            for n in tracks[req["track"]].get("notes") or []
            if n.get("start") is not None
        ]
        first_note = min(starts) if starts else 0.0

        if _wems is not None:
            main_wem, preview_wem = _wems
            song_length = _song_length or 60.0
            volume = -8.0
        else:
            main_wav, preview_wav, song_length, volume = _prepare_audio(
                Path(audio_path), first_note, workdir, warnings)
            main_wem = wem.convert_to_wem(main_wav, wwise_console)
            preview_wem = wem.convert_to_wem(preview_wav, wwise_console)

        contexts: list[SongContext] = []
        arrangement_entries: list[tuple[str, bytes]] = []
        for sort_idx, req in enumerate(arr_requests):
            base_track = tracks[req["track"]]
            track = dict(base_track)
            if req.get("tuning"):
                track["tuning"] = req["tuning"]
            offsets, is_bass = _tuning_offsets(track.get("tuning") or [], warnings)
            arr = ARRANGEMENTS[req["kind"]]
            if arr["is_bass"] != is_bass:
                need = "4-string bass" if arr["is_bass"] else "6-string guitar"
                raise ValueError(f"{arr['full_name']} needs a {need} tuning")

            compiled = chart.compile_track(
                track, spec.get("grid") or {}, song_length,
                section_markers=spec.get("sections") or [],
                phrase_boundaries=(
                    track.get("phraseBoundaries")
                    or track.get("practiceBoundaries")
                    or []))
            warnings.extend(compiled.warnings)
            compiled.sng.metadata.tuning = tuple(offsets)
            compiled.sng.metadata.part = 3 if is_bass else (2 if arr["path"] == "rhythm" else 1)
            base_tone, tone_slots, tone_events = _arrangement_tones(
                track, is_bass, key, arr["tag"], song_length, warnings)
            compiled.sng.tones = tone_events
            sng_packed = sng.pack(sng.serialize(compiled.sng))
            representative = arr["priority"] == "main"

            ctx = SongContext(
                dlc_key=key, title=title, artist=artist, album=album, year=year,
                is_bass=is_bass, arrangement=arr, representative=representative,
                arrangement_sort=sort_idx,
                persistent_id=manifest.stable_uuid(key, arr["tag"]),
                master_id=manifest.stable_id32(key, arr["tag"]),
                tone=base_tone,
                tone_slots=tone_slots,
                compiled=compiled,
            )
            contexts.append(ctx)
            arrangement_entries.extend([
                (f"songs/bin/generic/{low}_{arr['tag']}.sng", sng_packed),
                (f"manifests/songs_dlc_{low}/{low}_{arr['tag']}.json",
                 manifest.manifest_json(manifest.build_attributes(ctx, header=False))),
            ])

        main_bnk, main_file_id = bnk.generate(key, main_wem, volume, is_preview=False)
        prev_bnk, prev_file_id = bnk.generate(f"{key}_Preview", preview_wem, volume + 2.0,
                                              is_preview=True)

        art = dds.album_art(title, artist, cover_art_path)
        from importlib import resources
        res = resources.files(__package__).joinpath("res")

        entries = arrangement_entries + [
            (f"songs/arr/{low}_showlights.xml", manifest.showlights(contexts[0].compiled)),
            (f"manifests/songs_dlc_{low}/songs_dlc_{low}.hsan",
             manifest.hsan_json([manifest.build_attributes(ctx, header=True) for ctx in contexts])),
            (f"gfxassets/album_art/album_{low}_64.dds", art[64]),
            (f"gfxassets/album_art/album_{low}_128.dds", art[128]),
            (f"gfxassets/album_art/album_{low}_256.dds", art[256]),
            (f"gamexblocks/nsongs/{low}.xblock", manifest.xblock(contexts)),
            ("flatmodels/rs/rsenumerable_song.flat",
             res.joinpath("rsenumerable_song.flat").read_bytes()),
            ("flatmodels/rs/rsenumerable_root.flat",
             res.joinpath("rsenumerable_root.flat").read_bytes()),
            (f"{low}_aggregategraph.nt", manifest.aggregate_graph(contexts)),
            (f"audio/windows/song_{low}.bnk", main_bnk),
            (f"audio/windows/{main_file_id}.wem", main_wem),
            (f"audio/windows/song_{low}_preview.bnk", prev_bnk),
            (f"audio/windows/{prev_file_id}.wem", preview_wem),
            ("toolkit.version",
             b"Toolkit version: rs-studio rocksmith-export\n"
             b"Package Author: RS Studio\n"
             b"Package Version: 1\n"
             b"Package Comment: Experimental in-app export"),
            ("appid.appid", b"248750"),
        ]
        return psarc.build_psarc(entries), warnings, _cdlc_filename(artist, title)
