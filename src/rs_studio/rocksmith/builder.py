"""Assemble a complete Rocksmith 2014 PC CDLC (.psarc) from an editor spec.

Entry point: build_cdlc(spec, audio_path). The spec is the same payload the
.gp5 export uses (tracks with seconds-based notes + string/fret, tempo grid);
audio comes from the project's original upload. One arrangement per package
used to be emitted; the export dialog can now choose several Rocksmith
arrangements from the editor lanes.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import tempfile
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import soundfile as sf

from . import bnk, chart, checker, dds, manifest, psarc, sng, wem
from .tones import custom_tone
from .wem import AudioConverterNotFoundError, WwiseNotFoundError  # public error types

_STANDARD_GUITAR = [40, 45, 50, 55, 59, 64]  # low->high E standard
_STANDARD_BASS = [28, 33, 38, 43]
PREVIEW_SECONDS = 28.0


def _song_end(spec: dict, duration: float) -> float:
    value = spec.get("songEnd")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return min(float(value), duration)
    return duration


@dataclass
class SongContext:
    dlc_key: str
    title: str
    artist: str
    album: str
    latin: dict[str, str]  # title/artist/album as the game sorts them
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
    cent_offset: float = 0.0
    scroll_speed: float = 1.3  # lower is faster, as DLC Builder sets it
    partition: int = 1


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


def _latin_names(spec: dict, artist: str, title: str, album: str) -> dict[str, str]:
    """The Latin spelling the user gave for a name in another script, else the name itself."""
    meta = spec.get("metadata") or {}
    return {field: str(meta.get(f"{field}Latin") or "").strip() or name
            for field, name in (("artist", artist), ("title", title), ("album", album))}


def _package_version(spec: dict) -> int:
    """The version the export asked for: a whole number from 1 (1 when it did not)."""
    value = (spec.get("rocksmith") or {}).get("version")
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else 1


def _cdlc_filename(artist: str, title: str, key: str, version: int = 1) -> str:
    """CustomsForge/Toolkit convention: Artist-Name_Song-Title_v1_p.psarc
    (underscores between fields, hyphens for spaces within a field, _p = PC).

    ASCII only, as Rocksmith2014.NET's StringValidator.fileName does it:
    diacritics folded, everything else outside [ 0-9A-Za-z_-] dropped."""
    def clean(s: str) -> str:
        s = unicodedata.normalize("NFD", s)
        s = re.sub(r"[^ 0-9A-Za-z_-]", "", s).strip()
        return re.sub(r"\s+", "-", s)
    return f"{clean(artist) or 'Unknown'}_{clean(title) or key}_v{version}_p.psarc"


LOW_BASS_CENTS = -1200.0   # DLC Builder's low tuning fix: a 220 Hz reference


def _tuning_offsets(tuning_hi_lo: list[int], warnings: list[str]) -> tuple[list[int], bool, float]:
    """Editor tuning (hi->lo midi) -> (RS int16[6] offsets from standard, is bass, cent offset).

    A lane may sit whole octaves off, so offsets fold into -11..+4: tunings go
    far down (A standard is -7) and hardly ever more than a few steps up.

    Rocksmith does not detect bass notes below about -4 at the normal 440 Hz
    reference. DLC Builder's "low tuning fix" halves the reference and raises
    every string an octave, which sounds the same; it is applied here
    automatically instead of being reported as I41.
    """
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
        reduced = ((off + 11) % 12) - 11
        if reduced != off:
            warnings.append(f"Tuning offset {off:+d} octave-reduced to {reduced:+d}")
        offsets.append(reduced)
    cents = 0.0
    if is_bass and any(off < -4 for off in offsets):
        offsets = [off + 12 for off in offsets]
        cents = LOW_BASS_CENTS
        warnings.append("Low bass tuning: exported an octave up at a 220 Hz reference so Rocksmith detects it")
    # A bass has no 5th and 6th string, but the game names a tuning by all six
    # offsets: they take the 4th string's, as DLC Builder sets them (Eb Standard
    # is six -1s, not -1,-1,-1,-1,0,0).
    return offsets + offsets[-1:] * (6 - len(offsets)), is_bass, cents


def _concert_pitch(spec: dict) -> tuple[float, float]:
    """(reference, shift) in cents from A440, each clamped to a quarter tone.

    The recording sits `reference` off A440 and the export moves it by `shift`,
    so Rocksmith hears it at reference + shift (its CentOffset).
    """
    raw = spec.get("tuning") if isinstance(spec.get("tuning"), dict) else {}

    def cents(key: str) -> float:
        try:
            value = float(raw.get(key) or 0.0)
        except (TypeError, ValueError):
            return 0.0
        return max(-50.0, min(50.0, value)) if math.isfinite(value) else 0.0

    return cents("reference"), cents("shift")


MAX_LEAD_IN = 30.0


def _lead_in_seconds(spec: dict) -> float:
    """The leading silence the export asked for, in seconds (0 when it did not)."""
    try:
        value = float((spec.get("rocksmith") or {}).get("leadingSilence") or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return min(MAX_LEAD_IN, max(0.0, value))


def _with_lead_in(spec: dict, lead: float) -> dict:
    """A copy of the spec with everything timed moved `lead` seconds later.

    The audio gets the same amount of silence in front (_prepare_audio), so the
    chart and the song stay in step: Rocksmith starts the track the moment the
    song loads, and a first note in the first second leaves no time to see it
    coming.

    Two things do not simply move. A tone marker at the very start names the
    arrangement's base tone, not a switch, so it stays at 0. And the beat grid is
    extended BACKWARDS by whole measures into the silence instead of starting
    after it, so the lead-in has bar lines to count along and every downbeat is
    still where the music puts it.
    """
    if lead <= 0:
        return spec
    out = copy.deepcopy(spec)
    if isinstance(out.get("songEnd"), (int, float)):
        out["songEnd"] += lead

    def moved(item):
        if isinstance(item, dict):
            for name in ("t", "seconds"):
                if isinstance(item.get(name), (int, float)):
                    item[name] += lead
            return item
        return item + lead if isinstance(item, (int, float)) else item

    for track in out.get("tracks") or []:
        for note in track.get("notes") or []:
            for name in ("start", "end"):
                if isinstance(note.get(name), (int, float)):
                    note[name] += lead
        for marker in track.get("toneMarkers") or []:
            at = marker.get("t", marker.get("seconds")) if isinstance(marker, dict) else None
            if isinstance(at, (int, float)) and at > 1e-6:
                moved(marker)
        for name in ("phraseBoundaries", "practiceBoundaries", "crowdEvents"):
            if track.get(name):
                track[name] = [moved(item) for item in track[name]]
        # A layer on its own timing carries its own grid and sections.
        for section in track.get("sections") or []:
            moved(section)
        _grid_lead_in(track.get("grid"), lead, moved)
    for section in out.get("sections") or []:
        moved(section)
    _grid_lead_in(out.get("grid"), lead, moved)
    return out


def _grid_lead_in(grid, lead: float, moved) -> None:
    if not isinstance(grid, dict):
        return
    for marker in grid.get("tempoMap") or []:
        moved(marker)
    placed = _lead_grid(grid, lead)
    if placed is not None:
        # Where the song's own grid starts, behind the silence: the count-in
        # measure ends there (chart._count_in).
        grid["songStart"] = max(0.0, float(grid.get("offset") or 0.0)) + lead
        grid["offset"] = placed[0]


def _lead_grid(grid: dict, lead: float) -> tuple[float, float] | None:
    """(first beat, measure length) of a grid behind `lead` seconds of silence.

    With silence, the grid runs back into it by whole measures (_grid_lead_in);
    without, it starts where it always did.
    """
    try:
        bpm = float(grid.get("bpm") or 120.0) or 120.0
        measure = 60.0 / bpm * max(1, int(grid.get("tsNum") or 4))
        start = max(0.0, float(grid.get("offset") or 0.0))
    except (TypeError, ValueError):
        return None
    if lead <= 0:
        return start, measure
    start += lead
    return start - int(start / measure) * measure, measure


MIN_FIRST_NOTE = 10.0   # EOF: "At least one note begins < 10 seconds" is an error


def _package_lead_in(spec: dict, track_indexes) -> float:
    """The silence the package starts with: what the export asked for, or more.

    Raised until EOF's rules for the start of a Rocksmith arrangement hold for
    every exported lane: the first note comes at 10 s or later, and a whole
    empty measure lies before it, the COUNT phrase (DLC Builder's I25). That
    measure fails only when a section snaps onto the first beat, or a measure is
    longer than the silence; then the silence grows by whole measures, so the
    downbeats stay where the music puts them.
    """
    lead = _lead_in_seconds(spec)
    tracks = spec.get("tracks") or []
    starts = []
    for index in track_indexes:
        track = tracks[index]
        notes = [n["start"] for n in track.get("notes") or []
                 if isinstance(n.get("start"), (int, float)) and not n.get("gripOnly")]   # held, not played
        if not notes:
            continue
        sections = (track["sections"] if "sections" in track else spec.get("sections")) or []
        marks = [s["t"] for s in sections if isinstance(s, dict) and isinstance(s.get("t"), (int, float)) and s["t"] >= 0]
        starts.append((min(notes), min(marks, default=float("inf")),
                       track.get("grid") or spec.get("grid") or {}))
    if not starts:
        return lead
    lead = max(lead, MIN_FIRST_NOTE - min(note for note, _, _ in starts))
    for _ in range(64):
        grow = 0.0
        for note, section, grid in starts:
            placed = _lead_grid(grid, lead)
            if placed is None:
                continue
            first, measure = placed
            # A section snaps to the nearest downbeat: within half a measure of
            # the first one, it would start the first phrase there.
            if note + lead < first + measure - 1e-6 or section + lead < first + measure / 2 - 1e-6:
                grow = max(grow, measure)
        if not grow:
            break
        lead += grow
    return lead


def read_audio(audio_path: Path) -> tuple[np.ndarray, int]:
    """(frames x channels float array, sample rate)."""
    try:
        return sf.read(str(audio_path), always_2d=True)
    except Exception:
        import librosa
        y, sr = librosa.load(str(audio_path), sr=None, mono=False)
        return np.atleast_2d(y).T, sr


# Loudness the way DLC Builder measures it (Rocksmith2014.Audio/Volume, MIT):
# ITU BS.1770 integrated loudness, and a bank volume that brings it to -16 LUFS.
# The K-weighting biquads are given at 48 kHz and re-derived for other rates.
_K_SHELF = (1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585)
_K_HIGHPASS = (1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621)
LOUDNESS_REFERENCE = -16.0
MIN_PREVIEW, MAX_PREVIEW = 5.0, 30.0


def _biquad_at(coeffs: tuple, sr: float) -> tuple[list, list]:
    b0, b1, b2, a1, a2 = coeffs
    if sr != 48000:
        k_over_q = (2 - 2 * a2) / (a2 - a1 + 1)
        k = np.sqrt((a1 + a2 + 1) / (a2 - a1 + 1))
        q = k / k_over_q
        vb = (b0 - b2) / (1 - a2)
        vh = (b0 - b1 + b2) / (a2 - a1 + 1)
        vl = (b0 + b1 + b2) / (a1 + a2 + 1)
        k = np.tan(np.arctan(k) * 48000 / sr)
        c = 1 / (1 + k / q + k * k)
        b0, b1, b2 = (vh + vb * k / q + vl * k * k) * c, 2 * (vl * k * k - vh) * c, (vh - vb * k / q + vl * k * k) * c
        a1, a2 = 2 * (k * k - 1) * c, (1 - k / q + k * k) * c
    return [b0, b1, b2], [1.0, a1, a2]


def integrated_loudness(data: np.ndarray, sr: int) -> float:
    """BS.1770 integrated loudness in LUFS: 400 ms blocks every 100 ms, gated at
    -70 LUFS and then 10 LU below the level of what is left. -inf for silence."""
    from scipy.signal import lfilter
    x = np.asarray(data, dtype=np.float64)
    for coeffs in (_K_SHELF, _K_HIGHPASS):
        x = lfilter(*_biquad_at(coeffs, sr), x, axis=0)
    step, block = int(round(0.1 * sr)), int(round(0.4 * sr))
    if len(x) < block:
        return float("-inf")
    weights = np.array([1.41 if ch in (3, 4) else 1.0 for ch in range(x.shape[1])])
    sums = np.vstack([np.zeros(x.shape[1]), np.cumsum(x * x, axis=0)])
    starts = np.arange(0, len(x) - block + 1, step)
    power = ((sums[starts + block] - sums[starts]) / block) @ weights
    with np.errstate(divide="ignore"):
        loud = -0.691 + 10 * np.log10(power)
    kept = power[loud > -70]
    if not kept.size:
        return float("-inf")
    kept = kept[-0.691 + 10 * np.log10(kept) > -0.691 + 10 * np.log10(kept.mean()) - 10]
    return float(-0.691 + 10 * np.log10(kept.mean()))


def auto_volume(data: np.ndarray, sr: int) -> float:
    """The bank volume (dB) DLC Builder would pick: -16 LUFS minus the loudness,
    to one decimal; 0 for silence."""
    loud = integrated_loudness(data, sr)
    if not np.isfinite(loud):
        return 0.0
    v = LOUDNESS_REFERENCE - loud
    return float(np.sign(v) * np.floor(abs(v) * 10 + 0.5) / 10)


def preview_window(spec: dict, length: float, first_note: float) -> tuple[float, float]:
    """The preview clip's (start, end) in the audio's own time.

    The export dialog sends a start and a length; without them, 28 s from just
    before the first note. A clip is 5 to 30 s and stays inside the song.
    """
    raw = (spec.get("rocksmith") or {}).get("preview") or {}
    try:
        start = float(raw["start"])
        clip = float(raw.get("length", PREVIEW_SECONDS))
    except (KeyError, TypeError, ValueError):
        start, clip = first_note - 1.0, PREVIEW_SECONDS
    clip = min(MAX_PREVIEW, max(MIN_PREVIEW, clip))
    start = min(max(0.0, start), max(0.0, length - clip))
    return start, min(length, start + clip)


def preview_clip(data: np.ndarray, sr: int, start: float, end: float) -> np.ndarray:
    """The preview audio with DLC Builder's 2.5 s fade-in and 3 s fade-out."""
    seg = data[int(start * sr):int(end * sr)].astype(np.float64)
    fade_in, fade_out = int(2.5 * sr), int(3.0 * sr)
    if len(seg) < fade_in + fade_out:
        fade_in = fade_out = len(seg) // 2
    seg[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
    seg[len(seg) - fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
    return seg


def _prepare_audio(audio_path: Path, first_note: float, workdir: Path,
                   warnings: list[str], lead: float = 0.0,
                   spec: dict | None = None) -> tuple[Path, Path, float, float, float]:
    """Returns (main wav, preview wav, song length, song volume dB, preview volume dB).

    `first_note` is in the audio's own time; `lead` seconds of silence go in front
    of the main track only, and the returned length includes them.
    """
    spec = spec or {}
    _, shift = _concert_pitch(spec)
    if shift:
        from ..audio_channels import pitch_shift
        shifted = workdir / "shifted.wav"
        pitch_shift(audio_path, shifted, shift, ["-c:a", "pcm_s16le"])
        audio_path = shifted
    data, sr = read_audio(audio_path)
    length = len(data) / sr

    main = workdir / "main.wav"
    padded = np.concatenate([np.zeros((int(round(lead * sr)), data.shape[1]), dtype=data.dtype), data]) if lead > 0 else data
    sf.write(str(main), padded, sr, subtype="PCM_16")

    seg = preview_clip(data, sr, *preview_window(spec, length, first_note))
    preview = workdir / "preview.wav"
    sf.write(str(preview), seg, sr, subtype="PCM_16")

    # Each leveled on its own, as DLC Builder does: the clip is often louder than the song.
    return main, preview, len(padded) / sr, auto_volume(data, sr), auto_volume(seg, sr)


def _arrangement_specs(spec: dict, tracks: list[dict], warnings: list[str]) -> list[dict]:
    requested = ((spec.get("rocksmith") or {}).get("arrangements") or [])
    if not requested:
        idx = int(spec.get("track") or 0) % len(tracks)
        track = tracks[idx]
        try:
            # The warnings this would emit are about the *chosen* tuning, and
            # here we only want to know guitar vs bass; the real call below runs
            # on the same tuning and collects them.
            _, is_bass, _ = _tuning_offsets(track.get("tuning") or [], [])
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
        out.append({"track": idx, "kind": kind, "tuning": item.get("tuning"), "capo": item.get("capo"),
                    "scrollSpeed": item.get("scrollSpeed")})
    if not out:
        raise ValueError("No Rocksmith arrangements selected")
    return out



def _scroll_speed(value) -> float:
    """DLC Builder's range: 0.5 (fastest) to 5.0, in tenths; 1.3 when unset."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 1.3
    return round(min(5.0, max(0.5, v)), 1) if math.isfinite(v) else 1.3


_TONE_PRESETS = {"lead", "clean", "crunch", "bass"}


def _arrangement_tones(track: dict, is_bass: bool, key: str, tag: str,
                       song_length: float, warnings: list[str]) -> tuple[dict, list[dict], list[tuple[float, int]]]:
    """Resolve one lane's authored switches to a base tone, slots, and SNG events."""
    # What a lane plays through when nothing says otherwise. The editor writes the
    # same choice as a marker at the start of every lane (web/tone-marker-core.js),
    # so this only decides for a spec that arrives without one.
    default = "clean" if is_bass else "crunch"
    markers = []
    custom = {}
    for index, raw in enumerate(track.get("toneMarkers") or []):
        try:
            time = float(raw.get("t", raw.get("seconds")))
        except (AttributeError, TypeError, ValueError):
            continue
        tone = str(raw.get("tone", raw.get("preset", ""))).strip().lower()
        if re.fullmatch(r"sound_[a-z0-9_-]{1,80}", tone):
            # Distinct project snapshots of one library preset stay distinct.
            definition = custom_tone(raw.get("toneData"), "Custom")
            digest = hashlib.sha256(json.dumps(definition, sort_keys=True).encode()).hexdigest()[:16]
            tone = f"{tone}_{digest}"
            custom[tone] = definition
        if tone not in _TONE_PRESETS and tone not in custom:
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
        if name in custom:
            return {**copy.deepcopy(custom[name]), "Key": f"{key}_{tag}_{name}_tone"}
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


@dataclass
class _Built:
    """One arrangement as it ships: its SNG plus what the manifest needs beside it."""
    compiled: chart.Compiled
    is_bass: bool
    cent_offset: float
    base_tone: dict
    tone_slots: list[dict]

    def issues(self) -> list[checker.Issue]:
        found = checker.check(self.compiled.sng, is_bass=self.is_bass, cent_offset=self.cent_offset)
        found += [checker.fixed(code, t) for code, t in self.compiled.fixes]
        return sorted(found, key=lambda issue: (issue.time is not None, issue.time or 0.0))


def _template_midi(templates: list, offsets: list[int], capo: int, is_bass: bool) -> None:
    """Chord template pitches from the RS tuning, as Rocksmith2014.NET's Midi.toMidiNote.

    Not the editor's pitches: after an octave fold or the low bass fix the
    template has to agree with the tuning the manifest reports.
    """
    for template in templates:
        template.notes = [
            -1 if fret == -1 else
            _STANDARD_GUITAR[s] + offsets[s] + (capo if capo > 0 and fret == 0 else fret) - (12 if is_bass else 0)
            for s, fret in enumerate(template.frets)]


_PRIORITY_ORDER = {"main": 0, "alt": 1, "bonus": 2}


def _partition(kinds: list[str], kind: str) -> int:
    """Which arrangement of its name this one is: 1 for the first Lead, 2 for the
    second … (DLC Builder's Partitioner, over arrangements sorted Main, Alt, Bonus)."""
    arr = ARRANGEMENTS[kind]
    return 1 + sum(1 for other in kinds
                   if ARRANGEMENTS[other]["name"] == arr["name"]
                   and _PRIORITY_ORDER[ARRANGEMENTS[other]["priority"]] < _PRIORITY_ORDER[arr["priority"]])


def _compile_arrangement(spec: dict, base_track: dict, req: dict, song_length: float,
                         key: str, warnings: list[str]) -> _Built:
    """One requested arrangement as the SNG it ships as."""
    track = dict(base_track)
    if req.get("tuning"):
        track["tuning"] = req["tuning"]
    if req.get("capo") is not None:
        track["capo"] = int(req["capo"])
    offsets, is_bass, cents = _tuning_offsets(track.get("tuning") or [], warnings)
    cents += sum(_concert_pitch(spec))
    arr = ARRANGEMENTS[req["kind"]]
    if arr["is_bass"] != is_bass:
        need = "4-string bass" if arr["is_bass"] else "6-string guitar"
        raise ValueError(f"{arr['full_name']} needs a {need} tuning")

    compiled = chart.compile_track(
        track, track.get("grid") or spec.get("grid") or {}, song_length,
        section_markers=(track["sections"] if "sections" in track else spec.get("sections")) or [],
        phrase_boundaries=(
            track.get("phraseBoundaries")
            or track.get("practiceBoundaries")
            or []),
        song_end=_song_end(spec, song_length))
    warnings.extend(compiled.warnings)
    compiled.sng.metadata.tuning = tuple(offsets)
    # EOF: a power chord with the low string dropped to D and the rest standard.
    compiled.arr_props["dropDPower"] = compiled.arr_props["powerChords"] and offsets == [-2, 0, 0, 0, 0, 0]
    _template_midi(compiled.sng.chords, offsets, max(0, int(track.get("capo") or 0)), is_bass)
    base_tone, tone_slots, tone_events = _arrangement_tones(
        track, is_bass, key, arr["tag"], song_length, warnings)
    compiled.sng.tones = tone_events
    return _Built(compiled, is_bass, cents, base_tone, tone_slots)


def check_spec(spec: dict) -> list[dict]:
    """What the export would warn about, per requested arrangement, without building it.

    For the editor's live check: the same compile and the same checker as
    build_cdlc, with every time moved back to the editor's own (before the lead-in).
    One arrangement failing to compile is reported against that arrangement and
    does not stop the others. `spec["duration"]` stands in for the audio length.
    """
    try:
        length = max(0.0, float(spec.get("duration") or 0.0))
    except (TypeError, ValueError):
        length = 0.0
    count = len(spec.get("tracks") or [])
    lead = _package_lead_in(spec, sorted({
        item.get("track") for item in (spec.get("rocksmith") or {}).get("arrangements") or []
        if isinstance(item.get("track"), int) and 0 <= item["track"] < count}))
    spec = _with_lead_in(spec, lead)
    tracks = spec.get("tracks") or []
    artist, title, _, _ = _song_meta(spec)
    key = _dlc_key(artist, title)
    out = []
    for item in (spec.get("rocksmith") or {}).get("arrangements") or []:
        index = item.get("track")
        arr = ARRANGEMENTS.get(item.get("kind") or "lead")
        if not isinstance(index, int) or not 0 <= index < len(tracks) or arr is None:
            continue
        # leadIn: the silence the package will start with, which the editor can show.
        found = {"track": index, "arrangement": arr["full_name"], "issues": [], "warnings": [], "error": None,
                 "leadIn": lead}
        out.append(found)
        warnings: list[str] = []
        try:
            built = _compile_arrangement(
                spec, tracks[index], {**item, "kind": item.get("kind") or "lead"},
                length + lead, key, warnings)
        except ValueError as exc:
            found["error"] = str(exc)
            continue
        found["warnings"] = list(dict.fromkeys(warnings))
        # The COUNT phrase and the events, in editor time, for the editor to show.
        song = built.compiled.sng
        found["count"] = next((pi.start_time - lead for pi in song.phrase_iterations
                               if song.phrases[pi.phrase_id].name == "COUNT"), None)
        found["events"] = [{"t": t - lead, "code": code} for t, code in song.events]
        issues = [issue.in_editor(lead) for issue in built.issues()]
        found["issues"] = [{"code": i.code, "time": i.time, "title": i.title, "help": i.help,
                            "important": i.important} for i in issues]
    return out


def build_cdlc(spec: dict, audio_path: Path | None, *, wwise_console: str | None = None,
               _wems: tuple[bytes, bytes] | None = None,
               _song_length: float | None = None,
               cover_art_path: Path | None = None) -> tuple[bytes, list[str], str]:
    """Build the psarc. Returns (bytes, warnings, download filename).

    _wems/_song_length bypass the WEM conversion + audio steps for the self-check.
    """
    warnings: list[str] = []
    version = _package_version(spec)
    source_tracks = spec.get("tracks") or []      # still in the audio's own time
    if not source_tracks:
        raise ValueError("No lanes with notes to export")
    arr_requests = _arrangement_specs(spec, source_tracks, warnings)
    lead = _package_lead_in(spec, [req["track"] for req in arr_requests])
    spec = _with_lead_in(spec, lead)
    tracks = spec.get("tracks") or []
    artist, title, album, year = _song_meta(spec)
    key = _dlc_key(artist, title)
    latin = _latin_names(spec, artist, title, album)
    low = key.lower()

    with tempfile.TemporaryDirectory(prefix="cw-rs-") as tmp:
        workdir = Path(tmp)
        starts = [
            float(n["start"])
            for req in arr_requests
            for n in source_tracks[req["track"]].get("notes") or []
            if n.get("start") is not None and not n.get("gripOnly")
        ]
        first_note = min(starts) if starts else 0.0

        if _wems is not None:
            main_wem, preview_wem = _wems
            song_length = (_song_length or 60.0) + lead
            volume = preview_volume = -8.0
        else:
            main_wav, preview_wav, song_length, volume, preview_volume = _prepare_audio(
                Path(audio_path), first_note, workdir, warnings, lead, spec)
            main_wem = wem.convert_to_wem(main_wav, wwise_console)
            preview_wem = wem.convert_to_wem(preview_wav, wwise_console)

        contexts: list[SongContext] = []
        arrangement_entries: list[tuple[str, bytes]] = []
        for sort_idx, req in enumerate(arr_requests):
            arr = ARRANGEMENTS[req["kind"]]
            built = _compile_arrangement(spec, tracks[req["track"]], req, song_length, key, warnings)
            partition = _partition([r["kind"] for r in arr_requests], req["kind"])
            built.compiled.sng.metadata.part = partition   # SNG and manifest agree, as in DLC Builder
            # Timed as in the editor, before the silence, like the live check.
            warnings.extend(f"{arr['full_name']}: {issue.in_editor(lead).text()}" for issue in built.issues())
            sng_packed = sng.pack(sng.serialize(built.compiled.sng))
            representative = arr["priority"] == "main"

            ctx = SongContext(
                dlc_key=key, title=title, artist=artist, album=album, latin=latin, year=year,
                is_bass=built.is_bass, arrangement=arr, representative=representative,
                arrangement_sort=sort_idx,
                partition=partition,
                persistent_id=manifest.stable_uuid(key, arr["tag"]),
                master_id=manifest.stable_id32(key, arr["tag"]),
                tone=built.base_tone,
                tone_slots=built.tone_slots,
                compiled=built.compiled,
                cent_offset=built.cent_offset,
                scroll_speed=_scroll_speed(req.get("scrollSpeed")),
            )
            contexts.append(ctx)
            arrangement_entries.extend([
                (f"songs/bin/generic/{low}_{arr['tag']}.sng", sng_packed),
                (f"manifests/songs_dlc_{low}/{low}_{arr['tag']}.json",
                 manifest.manifest_json(manifest.build_attributes(ctx, header=False))),
            ])

        main_bnk, main_file_id = bnk.generate(key, main_wem, volume, is_preview=False)
        prev_bnk, prev_file_id = bnk.generate(f"{key}_Preview", preview_wem, preview_volume,
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
             + f"Package Version: {version}\n".encode()
             + b"Package Comment: Experimental in-app export"),
            ("appid.appid", b"248750"),
        ]
        return psarc.build_psarc(entries), warnings, _cdlc_filename(latin["artist"], latin["title"], key, version)
