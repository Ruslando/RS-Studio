"""Compile the editor's tab spec into a Rocksmith SNG arrangement.

The editor gives notes in seconds with voiced string/fret (see tab.py's spec
docstring) — already audio-synced, so unlike the usual GP->EOF CDLC route no
manual re-sync is needed. This builds a single difficulty level (no dynamic
difficulty), phrases/sections every 8 measures, greedy 4-fret anchors, and
maps the editor's effect fields onto SNG note masks.

Conversion rules follow Rocksmith2014.NET's XmlToSng* modules.
"""
from __future__ import annotations

import itertools
import math
import os
import struct
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..tab import bend_points
from . import sng as S


def _conversion_stamp() -> str:
    """The build timestamp RS stores, in its own MM-D-YY HH:MM shape.

    Honours SOURCE_DATE_EPOCH (the reproducible-builds convention) so a package
    can be built twice and diffed byte for byte. Without it this is the only
    remaining source of non-determinism in a build — every id is derived rather
    than drawn at random (see manifest.stable_uuid).
    """
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    now = (datetime.fromtimestamp(int(epoch), timezone.utc) if epoch and epoch.isdigit()
           else datetime.now())
    return f"{now.month:02}-{now.day}-{now:%y %H:%M}"

SUSTAIN_MIN = 0.18       # shorter notes render without a tail
SECTION_MEASURES = 8     # riff-repeater section granularity
MAX_FRET = 24
ANCHOR_WIDTH = 4
ROCKSMITH_SECTION_NAMES = {
    "intro", "outro", "verse", "chorus", "bridge", "solo", "ambient",
    "breakdown", "interlude", "prechorus", "transition", "postchorus",
    "hook", "riff", "fadein", "fadeout", "buildup", "preverse",
    "modverse", "postvs", "variation", "modchorus", "head", "modbridge",
    "melody", "postbrdg", "prebrdg", "vamp", "noguitar", "silence",
    "tapping",
}

# Limitation: legato slides are exported as shift slides (no parent/child note
# linking); add pendingLinkNext handling if linked slides ever matter.


@dataclass
class _Entity:
    """One playable event: a single note or a chord."""
    time: float
    sustain: float
    notes: list                    # [(rs_string, fret, editor_note_dict)]
    chord_id: int = -1             # -1 = single note
    shape_id: str | None = None
    # filled during compilation:
    anchor_fret: int = 1
    anchor_width: int = ANCHOR_WIDTH
    finger_print: int = -1
    arpeggio_print: int = -1
    first_in_shape: bool = False


@dataclass
class Compiled:
    sng: S.SNG
    note_count: int
    arr_props: dict
    average_tempo: float
    warnings: list = field(default_factory=list)


def _f(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ---- beat grid -------------------------------------------------------------

def _gen_beats(grid: dict, song_length: float) -> list[tuple[float, int, int]]:
    bpm = _f(grid.get("bpm"), 120.0) or 120.0
    offset = max(0.0, _f(grid.get("offset")))
    ts = max(1, int(grid.get("tsNum") or 4))

    markers = []
    for m in grid.get("tempoMap") or []:
        t = _f(m.get("t"), -1.0)
        if t < 0:
            continue
        markers.append((t, _f(m.get("bpm"), bpm) or bpm, max(1, int(m.get("tsNum") or ts))))
    markers.sort()

    # Markers at/before the grid start just override the starting tempo/meter.
    while markers and markers[0][0] <= offset + 1e-4:
        _, bpm, ts = markers.pop(0)

    segments = [(offset, bpm, ts)] + markers
    beats = []  # (time, measure, beat_in_measure)
    measure = -1
    for i, (t0, bpm, ts) in enumerate(segments):
        t_end = segments[i + 1][0] if i + 1 < len(segments) else song_length
        step = 60.0 / bpm
        t, beat_in = t0, 0
        while t < t_end - 1e-4:
            if beat_in == 0:
                measure += 1
            beats.append((t, measure, beat_in))
            beat_in = (beat_in + 1) % ts
            t += step
    if len(beats) < 2:
        raise ValueError("Song too short for the beat grid")
    return beats


# ---- effect mapping --------------------------------------------------------

# Editor fx -> Rocksmith NoteMask. Transcribed from Rocksmith2014.XML's Note.cs
# NoteMask enum (13 flags — the format's *entire* technique vocabulary, single
# notes and per-string chord notes alike) and XmlToSngNote.fs's create*Mask
# functions:
#   fx.palmMute -> PalmMute   fx.accent -> Accent   fx.vibrato -> Vibrato
#   fx.dead     -> Mute (single/chord-note) / FretHandMute (whole-chord, below)
#   fx.hammer   -> HammerOn or PullOff, direction from the previous fret on
#                  that string (see `techniques()` in compile_track)
#   tremPick    -> Tremolo    harmonic -> Harmonic / PinchHarmonic ("pinch")
#   slide       -> Slide / UnpitchedSlide     bend -> Bend
#   slap        -> Slap / Pluck / Tap
# fx.ghost, fx.letRing, fx.staccato have no Rocksmith equivalent — confirmed
# against the full NoteMask enum, nothing matches — so they're dropped with an
# export warning instead of silently disappearing (see the voiced-notes loop
# below).
def _base_note_mask(n: dict, fret: int, sustain: float) -> tuple[int, int]:
    """Mask bits + companion fields shared by single notes and chord notes."""
    mask = 0
    vibrato = 0
    fx = n.get("fx") or {}
    if fret == 0:
        mask |= S.OPEN
    if sustain > 0:
        mask |= S.SUSTAIN
    if fx.get("palmMute"):
        mask |= S.PALMMUTE
    if fx.get("dead"):
        mask |= S.MUTE
    if fx.get("accent"):
        mask |= S.ACCENT
    if fx.get("vibrato"):
        mask |= S.VIBRATO
        vibrato = 80
    if n.get("tremPick"):
        mask |= S.TREMOLO
    harmonic = n.get("harmonic")
    if harmonic == "pinch":
        mask |= S.PINCHHARMONIC
    elif harmonic:
        mask |= S.HARMONIC
    return mask, vibrato


def _bend_curve(n: dict, time: float, sustain: float) -> tuple[list, float]:
    """Editor bend -> (bend values, max step). RS step 1.0 = a whole tone.

    Rocksmith stores the curve as absolute-time samples with no resolution limit
    of its own, so an editor curve maps across 1:1 — unlike the .gp5 path, a
    free-dragged point keeps its exact time and pitch here. The game assumes the
    string is unbent at the onset, so a leading zero-value point is dropped (but
    a prebend's non-zero one at t=0 is exactly what tells it otherwise).
    """
    pts = bend_points(n)
    if not pts:
        return [], 0.0
    values = [S.BendValue(time + t * sustain, v / 2.0) for t, v in pts]
    if values and values[0].step == 0.0:
        values = values[1:]
    return values[:32], max((v for _, v in pts), default=0.0) / 2.0


# ---- chord naming / fingering ----------------------------------------------
# Ports of web/chords.js's analyzer and web/voicing-core.js's fingering rules so exported chords carry
# the same name + playable fingering as the editor's chord-preview picker
# (in-game chord boxes and finger diagrams read straight from these). Keep the
# two implementations in sync if either changes.

_PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

_CHORD_FORMULAS = [
    ("maj9", (0, 2, 4, 7, 11), (7,)), ("9", (0, 2, 4, 7, 10), (7,)),
    ("m9", (0, 2, 3, 7, 10), (7,)), ("6/9", (0, 2, 4, 7, 9), (7,)),
    ("7b9", (0, 1, 4, 7, 10), (7,)), ("7#9", (0, 3, 4, 7, 10), (7,)),
    ("maj7#11", (0, 4, 6, 7, 11), (7,)), ("m11", (0, 3, 5, 7, 10), (7,)),
    ("maj7", (0, 4, 7, 11), (7,)), ("7", (0, 4, 7, 10), (7,)),
    ("6", (0, 4, 7, 9), (7,)), ("mMaj7", (0, 3, 7, 11), (7,)),
    ("m7", (0, 3, 7, 10), (7,)), ("m6", (0, 3, 7, 9), (7,)),
    ("m7b5", (0, 3, 6, 10), ()), ("dim7", (0, 3, 6, 9), ()),
    ("7sus4", (0, 5, 7, 10), (7,)), ("add9", (0, 2, 4, 7), (7,)),
    ("madd9", (0, 2, 3, 7), (7,)), ("add11", (0, 4, 5, 7), (7,)),
    ("madd11", (0, 3, 5, 7), (7,)), ("7b5", (0, 4, 6, 10), ()),
    ("7#5", (0, 4, 8, 10), ()), ("", (0, 4, 7), ()),
    ("m", (0, 3, 7), ()), ("dim", (0, 3, 6), ()), ("aug", (0, 4, 8), ()),
    ("sus2", (0, 2, 7), ()), ("sus4", (0, 5, 7), ()), ("5", (0, 7), ()),
]


def _chord_name(midi: list) -> str:
    """Interpret the chord spelled by MIDI pitches (-1 = unused string).

    Mirrors web/chords.js: exact formulas win, while a natural fifth may be
    omitted from a 4+-tone formula when at least three identity tones remain.
    See docs/chord-engine.md for the musical policy.
    """
    pitches = [m for m in midi if m >= 0]
    if not pitches:
        return ""
    bass_pc = min(pitches) % 12
    pcs = sorted({p % 12 for p in pitches})
    if len(pcs) == 1:
        return _PC_NAMES[pcs[0]]
    pc_set = set(pcs)
    matches = []
    for formula_idx, (suffix, intervals, optional) in enumerate(_CHORD_FORMULAS):
        for root in range(12):
            full = {(root + iv) % 12 for iv in intervals}
            if not pc_set <= full:
                continue
            missing = [iv for iv in intervals if (root + iv) % 12 not in pc_set]
            if any(iv not in optional for iv in missing) or (missing and len(pcs) < 3):
                continue
            omission = "" if not missing else "(" + ",".join(
                "no5" if iv == 7 else f"no{iv}" for iv in missing) + ")"
            base = _PC_NAMES[root] + suffix + omission
            symbol = base if root == bass_pc else f"{base}/{_PC_NAMES[bass_pc]}"
            score = len(missing) + (0 if root == bass_pc else 0.35) + formula_idx * 1e-4
            matches.append((score, symbol))
    if not matches:
        return ""
    return min(matches)[1]


def _finger_groupings(frets: list) -> list[list[list[int]]]:
    """Every physical fingertip/barre grouping using at most four fingers."""
    per_fret: list[list[list[list[int]]]] = []
    for fret in sorted({f for f in frets if f > 0}):
        same = [s for s, f in enumerate(frets) if f == fret]
        full = (1 << len(same)) - 1
        valid: list[tuple[int, list[int]]] = []
        for mask in range(1, full + 1):
            members = [same[i] for i in range(len(same)) if mask & (1 << i)]
            lo_s, hi_s = min(members), max(members)
            blocked = any(lo_s <= s <= hi_s and 0 <= f < fret
                          for s, f in enumerate(frets))
            if not blocked:
                valid.append((mask, members))

        partitions: list[list[list[int]]] = []

        def solve(mask: int, out: list[list[int]]) -> None:
            if not mask:
                partitions.append(out)
                return
            first = mask & -mask
            for group_mask, members in valid:
                if not group_mask & first or group_mask & mask != group_mask:
                    continue
                solve(mask ^ group_mask, [*out, members])

        solve(full, [])
        per_fret.append(partitions)

    combined: list[list[list[int]]] = [[]]
    for choices in per_fret:
        combined = [[*prefix, *suffix] for prefix in combined for suffix in choices
                    if len(prefix) + len(suffix) <= 4]
    return combined if per_fret else [[]]


def _finger_groups(frets: list) -> list[list[int]]:
    """Minimum physical finger/barre groups, ordered by fret.

    Equal-fret notes may share a finger only when the barre between their
    strings crosses no sounding open string or lower-fretted note. Higher notes
    may sit in front of a lower barre; unused/muted strings do not block it.
    Six strings make an exact bitmask partition tiny.
    """
    choices = _finger_groupings(frets)
    if choices:
        return min(choices, key=len)
    # Preserve diagnostic behaviour for externally supplied impossible chords.
    return [[s] for s, fret in enumerate(frets) if fret > 0]


_FINGER_RANGES_MM = {
    (1, 2): (5, 80), (1, 3): (15, 95), (1, 4): (25, 110),
    (2, 3): (6, 52), (2, 4): (12, 69), (3, 4): (8.5, 47),
}


def _fingering_cost(frets: list, grouping: list[list[int]], assignment: tuple[int, ...]) -> float:
    scale = 864 if len(frets) <= 5 else 648
    spacing = 9 if len(frets) <= 5 else 7
    x_at = lambda fret: scale * (1 - 2 ** (-(fret - 0.5) / 12))
    cost = len(grouping) * 0.26 + (0.08 if 4 in assignment else 0)
    groups = []
    for strings, finger in zip(grouping, assignment):
        fret = frets[strings[0]]
        center = sum(strings) / len(strings)
        span = max(strings) - min(strings) + 1 if len(strings) > 1 else 1
        if len(strings) > 1:
            cost += 0.22 + max(0, span - 1) * 0.05 + max(0, finger - 1) * 0.18
        groups.append((finger, fret, center))
    for i, (finger_a, fret_a, string_a) in enumerate(groups):
        for finger_b, fret_b, string_b in groups[i + 1:]:
            pair = tuple(sorted((finger_a, finger_b)))
            min_comfort, max_comfort = _FINGER_RANGES_MM[pair]
            distance = math.hypot(x_at(fret_a) - x_at(fret_b), (string_a - string_b) * spacing)
            if distance > max_comfort * 1.12:
                return math.inf
            soft_reach = max_comfort * 0.72
            if distance > soft_reach:
                cost += 2.4 * ((distance - soft_reach) / (max_comfort - soft_reach)) ** 2
            if distance < min_comfort:
                cost += 0.65 * ((min_comfort - distance) / min_comfort) ** 2
            if (fret_a - fret_b) * (finger_a - finger_b) < 0:
                cost += 2.25
            if pair == (3, 4) and (abs(fret_a - fret_b) > 1 or abs(string_a - string_b) > 2):
                cost += 0.35
    return cost


def _chord_fingers(frets: list) -> list:
    """Physical fingers for a Rocksmith chord (open=0, unused=-1).

    Automatic editor voicings already reject shapes needing more than four
    groups. If an external/manual spec still supplies one, excess groups stay
    unlabeled instead of falsely reusing finger 4 on another position.
    """
    fingers = [0 if f == 0 else -1 for f in frets]
    best = None
    for grouping in _finger_groupings(frets):
        for assignment in itertools.permutations(range(1, 5), len(grouping)):
            candidate = (_fingering_cost(frets, grouping, assignment), grouping, assignment)
            if best is None or candidate[0] < best[0]:
                best = candidate
    if best is None or not math.isfinite(best[0]):
        grouping, assignment = _finger_groups(frets), tuple(range(1, min(4, len(_finger_groups(frets))) + 1))
    else:
        _, grouping, assignment = best
    for strings, finger in zip(grouping, assignment):
        for s in strings:
            fingers[s] = finger
    return fingers


@dataclass
class _Voicing:
    """Stage 1's output: the editor's notes as playable events."""
    entities: list[_Entity]
    chord_templates: list          # S.ChordTemplate, indexed by _Entity.chord_id
    shape_info: dict               # shapeId -> {chord_id, start, end, frets}
    slide_ins: int                 # slide-ins seen; they have no RS equivalent
    first_t: float
    last_end: float


@dataclass
class _Arrangement:
    """Stage 2's output: the time grid every later stage indexes into."""
    beats: list                    # (time, measure, beat_in), from _gen_beats
    sng_beats: list                # S.Beat
    phrases: list                  # S.Phrase
    phrase_iterations: list        # S.PhraseIteration
    pi_times: list                 # phrase-iteration start times, then end_t
    sections: list                 # S.Section
    end_t: float                   # where the playable part stops


@dataclass
class _Notes:
    """Stage 5's output: the SNG note stream and the flags read off it."""
    notes: list                    # S.Note
    chord_notes: list              # S.ChordNotes
    anchor_extensions: list        # S.AnchorExtension
    arr_props: dict
    per_pi: list                   # note count per phrase iteration
    dropped_slides: int            # connected slides with no fretted target


# Both lookups walk backwards from the end because callers ask in time order and
# the last match is the answer. They were closures over pi_times/sections while
# everything lived in one function.
def _find_pi(pi_times: list, time: float, *, inclusive: bool) -> int:
    pid = len(pi_times) - 1
    while pid > 0 and not ((inclusive and abs(pi_times[pid] - time) < 1e-5)
                           or pi_times[pid] < time - 1e-5):
        pid -= 1
    return pid


def _find_section(sections: list, time: float) -> int:
    sid = len(sections) - 1
    while sid > 0 and sections[sid].start_time > time + 1e-5:
        sid -= 1
    return sid


def _voiced_entities(track: dict, n_str: int, tuning_low: list,
                     warnings: list) -> _Voicing:
    """Editor notes -> entities (chords = same onset), chord templates, Shapes.

    Takes nothing from the rest of the compile: it reads the track and produces
    what everything downstream indexes by. Notes without a string/fret position
    are dropped and frets past the neck are clamped, both with a warning.
    """
    _NO_RS_EQUIVALENT = {"ghost": "ghost note", "letRing": "let ring", "staccato": "staccato"}
    voiced = []
    dropped = 0
    clamped = 0
    unsupported_fx: set = set()
    for n in track.get("notes") or []:
        if n.get("string") is None or n.get("fret") is None:
            dropped += 1
            continue
        rs_string = n_str - int(n["string"])  # GP string 1 = highest
        fret = int(n["fret"])
        if not (0 <= rs_string < n_str) or fret < 0:
            dropped += 1
            continue
        if fret > MAX_FRET:
            fret = MAX_FRET
            clamped += 1
        fx = n.get("fx") or {}
        unsupported_fx.update(label for key, label in _NO_RS_EQUIVALENT.items() if fx.get(key))
        voiced.append((_f(n.get("start")), rs_string, fret, n))
    if clamped:
        warnings.append(f"{clamped} note(s) above fret {MAX_FRET} were moved down to it")
    if dropped:
        warnings.append(f"{dropped} note(s) without a string/fret position were skipped")
    if unsupported_fx:
        warnings.append(
            f"{', '.join(sorted(unsupported_fx))} have no Rocksmith equivalent and were dropped")
    if not voiced:
        raise ValueError("No voiced notes to export")
    voiced.sort(key=lambda v: (v[0], v[1]))

    chord_templates: list[S.ChordTemplate] = []
    chord_ids: dict[tuple, int] = {}

    def ensure_chord_template(frets: list, midi: list, *, arpeggio: bool = False) -> int:
        mask = S.CHORD_MASK_ARPEGGIO if arpeggio else 0
        key = (tuple(frets), mask)
        if key not in chord_ids:
            chord_ids[key] = len(chord_templates)
            chord_templates.append(S.ChordTemplate(
                frets=frets, fingers=_chord_fingers(frets), notes=midi,
                name=_chord_name(midi), mask=mask))
        return chord_ids[key]

    # Explicit editor Shapes become Rocksmith arpeggio fingerprints. They keep
    # every note as an individually timed event while referencing one complete
    # chord template for the grip displayed on the note highway.
    raw_shapes: dict[str, list] = {}
    for item in voiced:
        shape_id = item[3].get("shapeId")
        if isinstance(shape_id, str) and shape_id:
            raw_shapes.setdefault(shape_id, []).append(item)
    mixed_shape_ids = set()
    i = 0
    while i < len(voiced):
        j = i
        while j < len(voiced) and voiced[j][0] - voiced[i][0] < 0.002:
            j += 1
        onset = voiced[i:j]
        for shape_id in {item[3].get("shapeId") for item in onset if item[3].get("shapeId")}:
            if any(item[3].get("shapeId") != shape_id for item in onset):
                mixed_shape_ids.add(shape_id)
        i = j
    shape_info: dict[str, dict] = {}
    for shape_id, members in raw_shapes.items():
        if shape_id in mixed_shape_ids:
            warnings.append(f"Shape {shape_id} shares an onset with notes outside the Shape and was exported as ordinary notes")
            continue
        by_string = {}
        conflict = False
        for _, string, fret, _ in members:
            if string in by_string and by_string[string] != fret:
                conflict = True
            by_string[string] = fret
        if conflict or len(by_string) < 2:
            warnings.append(f"Shape {shape_id} cannot be held on one fixed multi-string grip and was exported as ordinary notes")
            continue
        frets = [-1] * 6
        midi = [-1] * 6
        for string, fret in by_string.items():
            frets[string] = fret
            midi[string] = tuning_low[string] + fret
        start = min(item[0] for item in members)
        end = max(max(_f(item[3].get("end"), item[0]), item[0] + 0.02) for item in members)
        shape_info[shape_id] = {
            "chord_id": ensure_chord_template(frets, midi, arpeggio=True),
            "start": start, "end": end, "frets": list(by_string.values()),
        }

    entities: list[_Entity] = []
    i = 0
    while i < len(voiced):
        j = i
        group = {}
        while j < len(voiced) and voiced[j][0] - voiced[i][0] < 0.002:
            group.setdefault(voiced[j][1], voiced[j])  # one note per string
            j += 1
        t = voiced[i][0]
        notes = [(s, fret, n) for s, (_, _, fret, n) in sorted(group.items())]
        dur = max(_f(n.get("end"), t) - t for _, _, n in notes)
        sustain = dur if dur >= SUSTAIN_MIN else 0.0
        ent = _Entity(time=t, sustain=sustain, notes=notes)
        entity_shape_ids = {n.get("shapeId") for _, _, n in notes if n.get("shapeId") in shape_info}
        if len(entity_shape_ids) == 1 and all(n.get("shapeId") in entity_shape_ids for _, _, n in notes):
            ent.shape_id = next(iter(entity_shape_ids))
        if len(notes) >= 2:
            frets = [-1] * 6
            midi = [-1] * 6
            for s, fret, _ in notes:
                frets[s] = fret
                midi[s] = tuning_low[s] + fret
            ent.chord_id = ensure_chord_template(frets, midi)
        entities.append(ent)
        i = j

    return _Voicing(
        entities=entities,
        chord_templates=chord_templates,
        shape_info=shape_info,
        slide_ins=sum(1 for _, _, _, note in voiced
                      if note.get("slide") in ("inBelow", "inAbove")),
        first_t=entities[0].time,
        last_end=max(e.time + e.sustain for e in entities),
    )


def _beats_phrases_sections(grid: dict, song_length: float, section_markers: list | None,
                            phrase_boundaries: list | None, first_t: float, last_end: float,
                            warnings: list) -> _Arrangement:
    """The beat map, and the phrase/section structure laid over it.

    Sections come from the editor's markers when there are any and from an
    eight-measure fallback when there are not. Either way they must land on
    measure boundaries, so authored times are snapped -- with a warning once the
    snap exceeds 20ms.
    """
    beats = _gen_beats(grid, song_length)
    measure_starts = [t for t, _, beat_in in beats if beat_in == 0]
    beat_starts = [t for t, _, _ in beats]

    p1_idx = 0
    for k, ms in enumerate(measure_starts):
        if ms <= first_t + 1e-4:
            p1_idx = k
        else:
            break
    automatic_boundaries = [
        ms for ms in measure_starts[p1_idx::SECTION_MEASURES]
        if ms < last_end - 1e-4
    ]
    if not automatic_boundaries:
        automatic_boundaries = [measure_starts[p1_idx]]
    end_t = next((ms for ms in measure_starts if ms >= last_end - 1e-4), None)
    if end_t is None or end_t <= automatic_boundaries[0] + 1e-4:
        end_t = min(last_end + 0.001, song_length - 0.01)
    end_t = min(end_t, song_length - 0.001)

    # Authored section starts replace the eight-measure fallback. Rocksmith
    # sections must align with the beat/measure map and must begin at phrase
    # boundaries, so snap the editor's audio-time markers to the nearest measure.
    authored: dict[float, str] = {}
    for raw in section_markers or []:
        time = _f(raw.get("t"), -1.0)
        if time < 0:
            continue
        # `rocksmithType` is the pre-rename key; specs saved before the core
        # renamed it to `sectionType` still carry it.
        raw_name = str(raw.get("sectionType") or raw.get("rocksmithType") or raw.get("text") or "riff")
        name = "".join(ch for ch in raw_name.lower() if ch.isalnum())
        if name not in ROCKSMITH_SECTION_NAMES:
            warnings.append(f"Section '{raw_name}' is not recognized by Rocksmith and was exported as riff")
            name = "riff"
        boundary = min(measure_starts, key=lambda value: abs(value - time))
        if boundary >= end_t - 1e-4:
            continue
        if abs(boundary - time) > 0.02:
            warnings.append(
                f"Section '{raw.get('text') or raw_name}' was snapped to the nearest measure boundary")
        if boundary in authored:
            warnings.append(
                f"Multiple section markers resolved to {boundary:.3f}s; the last one was used")
        authored[boundary] = name

    if authored:
        section_entries = sorted(authored.items())
        first_playable_boundary = measure_starts[p1_idx]
        if section_entries[0][0] > first_t + 1e-4:
            section_entries.insert(0, (first_playable_boundary, "riff"))
    else:
        section_entries = [(boundary, "riff") for boundary in automatic_boundaries]

    section_boundaries = [time for time, _ in section_entries]
    section_names = [name for _, name in section_entries]

    # Phrase boundaries are arrangement-specific phrase-iteration starts.
    # They refine Riff Repeater ranges without creating or renaming sections.
    authored_phrase_starts: set[float] = set()
    for raw in phrase_boundaries or []:
        time = _f(raw.get("t") if isinstance(raw, dict) else raw, -1.0)
        if time < 0:
            continue
        boundary = min(beat_starts, key=lambda value: abs(value - time))
        if boundary < section_boundaries[0] - 1e-4 or boundary >= end_t - 1e-4:
            continue
        if abs(boundary - time) > 0.02:
            warnings.append(
                f"Phrase boundary at {time:.3f}s was snapped to the nearest beat")
        authored_phrase_starts.add(boundary)

    phrase_starts = sorted(set(section_boundaries) | authored_phrase_starts)

    has_count = phrase_starts[0] > beats[0][0] + 1e-4
    pi_times = ([beats[0][0]] if has_count else []) + phrase_starts + [end_t]
    phrases = []
    if has_count:
        phrases.append(S.Phrase(name="COUNT"))
    phrases += [S.Phrase(name=f"p{k + 1}") for k in range(len(phrase_starts))]
    phrases.append(S.Phrase(name="END"))

    phrase_iterations = [
        S.PhraseIteration(
            phrase_id=k, start_time=t,
            end_time=pi_times[k + 1] if k + 1 < len(pi_times) else song_length)
        for k, t in enumerate(pi_times)
    ]

    first_riff_pi = 1 if has_count else 0
    phrase_pi = {
        boundary: first_riff_pi + index
        for index, boundary in enumerate(phrase_starts)
    }
    sections = []
    name_counts: dict[str, int] = {}
    for k, (t, name) in enumerate(zip(section_boundaries, section_names)):
        end = section_boundaries[k + 1] if k + 1 < len(section_boundaries) else end_t
        start_pi = phrase_pi[t]
        next_section_pi = phrase_pi.get(end, first_riff_pi + len(phrase_starts))
        name_counts[name] = name_counts.get(name, 0) + 1
        sections.append(S.Section(
            name=name, number=name_counts[name], start_time=t, end_time=end,
            start_pi=start_pi, end_pi=max(start_pi, next_section_pi - 1),
            string_mask=[0] * 36))
    sections.append(S.Section(
        name="noguitar", number=1, start_time=end_t, end_time=song_length,
        start_pi=len(pi_times) - 1, end_pi=len(pi_times) - 1,
        string_mask=[0] * 36))

    sng_beats = []
    for t, measure, beat_in in beats:
        mask = 0
        if beat_in == 0:
            mask = 1 | (2 if measure % 2 == 0 else 0)
        sng_beats.append(S.Beat(time=t, measure=measure, beat=beat_in,
                                phrase_iteration=_find_pi(pi_times, t, inclusive=False),
                                mask=mask))

    return _Arrangement(beats=beats, sng_beats=sng_beats, phrases=phrases,
                        phrase_iterations=phrase_iterations, pi_times=pi_times,
                        sections=sections, end_t=end_t)


def _plan_anchors(entities: list, shape_info: dict) -> list:
    """Greedy fret window at entity onsets, widened to fit whatever chord it is
    drawn around (a fixed 4-fret box clips a wide voicing's top notes outside the
    in-game chord box). Returns (time, fret, width); also stamps each entity.
    """
    anchors_raw = []
    cur = cur_w = None
    for e in entities:
        held_frets = shape_info[e.shape_id]["frets"] if e.shape_id in shape_info else [f for _, f, _ in e.notes]
        fretted = [f for f in held_frets if f > 0]
        lo = min(fretted) if fretted else None
        hi = max(fretted) if fretted else None
        if cur is None:
            cur_w = max(ANCHOR_WIDTH, hi - lo + 1) if lo is not None else ANCHOR_WIDTH
            cur = max(1, min(lo or 1, MAX_FRET - cur_w + 1))
            anchors_raw.append((e.time, cur, cur_w))
        elif lo is not None:
            span = hi - lo + 1
            fits = cur <= lo and hi <= cur + cur_w - 1
            # a window widened for one stretchy chord must not linger for later
            # notes that don't themselves need the extra reach -- otherwise a
            # single note far outside a normal hand-span still numerically
            # "fits" the old wide window and the anchor never catches up to it
            stale_wide = cur_w > ANCHOR_WIDTH and span <= ANCHOR_WIDTH and not (
                cur <= lo and hi <= cur + ANCHOR_WIDTH - 1)
            if not fits or stale_wide:
                cur_w = max(ANCHOR_WIDTH, span)
                cur = max(1, min(lo, MAX_FRET - cur_w + 1))
                anchors_raw.append((e.time, cur, cur_w))
        e.anchor_fret = cur
        e.anchor_width = cur_w
    return anchors_raw


def _handshapes(entities: list, shape_info: dict, end_t: float) -> tuple[list, list]:
    """Fingerprints (runs of the same chord) and arpeggios (editor Shapes).

    A run may only skip ChordNotes (HighDensity "just repeat the last one") when
    NOTHING about the chord changed since the previous hit. Same chord_id alone
    isn't enough: XmlToSngNote.fs's FixHighDensity explicitly keeps ChordNotes on
    the chord where a whole-chord mute/palm-mute starts or ends, even mid-run,
    so the mute transition doesn't get silently dropped as "identical repeat".
    """
    def _mute_state(e: _Entity) -> tuple:
        return (all((n.get("fx") or {}).get("dead") for _, _, n in e.notes),
                all((n.get("fx") or {}).get("palmMute") for _, _, n in e.notes))

    fingerprints: list[S.FingerPrint] = []
    k = 0
    while k < len(entities):
        e = entities[k]
        if e.chord_id == -1 or e.shape_id:
            k += 1
            continue
        run = [e]
        j = k + 1
        while (j < len(entities) and entities[j].chord_id == e.chord_id and not entities[j].shape_id
               and _mute_state(entities[j]) == _mute_state(e)):
            run.append(entities[j])
            j += 1
        last = run[-1]
        end = last.time + max(last.sustain, 0.05) + 0.001
        if j < len(entities):
            end = min(end, entities[j].time - 0.001)
        end = min(end, end_t)
        end = max(end, last.time + 0.02)
        fp_id = len(fingerprints)
        last_note_t = last.time + last.sustain
        fingerprints.append(S.FingerPrint(
            chord_id=e.chord_id, start_time=e.time, end_time=end,
            first_note_time=e.time,
            last_note_time=last_note_t if last_note_t < end else -1.0))
        for m, ent in enumerate(run):
            ent.finger_print = fp_id
            ent.first_in_shape = m == 0
        k = j

    arpeggios: list[S.FingerPrint] = []
    for shape_id, info in sorted(shape_info.items(), key=lambda item: item[1]["start"]):
        fp_id = len(arpeggios)
        arpeggios.append(S.FingerPrint(
            chord_id=info["chord_id"], start_time=info["start"], end_time=info["end"],
            first_note_time=info["start"], last_note_time=-1.0))
        for ent in entities:
            if ent.shape_id == shape_id:
                ent.arpeggio_print = fp_id

    return fingerprints, arpeggios


def _emit_notes(entities: list, chord_templates: list, arr: _Arrangement) -> _Notes:
    """Entities -> SNG notes: masks, techniques, chord notes, arrangement flags.

    The longest stage, and the one that reads the most: anchors and fingerprints
    reach it stamped on the entities themselves rather than as parameters.
    """
    chord_notes_list: list[S.ChordNotes] = []
    chord_notes_ids: dict[tuple, int] = {}
    anchor_exts: list[S.AnchorExtension] = []
    notes: list[S.Note] = []
    notes_per_pi = [0] * len(arr.pi_times)
    arr_props = dict.fromkeys((
        "powerChords", "openChords", "doubleStops", "palmMutes", "harmonics",
        "pinchHarmonics", "hopo", "tremolo", "slides", "unpitchedSlides",
        "bends", "tapping", "vibrato", "fretHandMutes", "slapPop", "sustain"), False)
    last_fret_on_string: dict[int, int] = {}
    prev_note: S.Note | None = None
    dropped_connected_slides = 0

    def next_fret_on_string(idx: int, string: int) -> int | None:
        for e2 in entities[idx + 1:]:
            for s, f, _ in e2.notes:
                if s == string:
                    return f
        return None

    def techniques(n: dict, string: int, fret: int, sustain: float, time: float, idx: int) -> tuple:
        """HammerOn/PullOff/Slide/Bend/Slap/Pluck/Tap — shared by single notes and
        per-string chord notes (XmlToSngNote.fs applies this same set to both;
        Open/Sustain/PalmMute/Vibrato/etc are handled by _base_note_mask instead).
        """
        nonlocal dropped_connected_slides
        mask = 0
        slide_to = -1
        unpitch_to = -1
        bends: list[S.BendValue] = []
        max_bend = 0.0
        tap = slap = pluck = -1
        fx = n.get("fx") or {}

        if fx.get("hammer"):
            prev_fret = last_fret_on_string.get(string)
            mask |= S.PULLOFF if (prev_fret is not None and prev_fret > fret) else S.HAMMERON
            arr_props["hopo"] = True
        slide = n.get("slide")
        if slide in ("shift", "legato"):
            target = next_fret_on_string(idx, string)
            if target is not None and target != fret and target > 0:
                sustain = max(sustain, SUSTAIN_MIN)
                mask |= S.SLIDE | S.SUSTAIN
                slide_to = target
                arr_props["slides"] = True
            else:
                dropped_connected_slides += 1
        elif slide in ("outDown", "outUp"):
            sustain = max(sustain, SUSTAIN_MIN)
            mask |= S.UNPITCHEDSLIDE | S.SUSTAIN
            # Rocksmith can't resolve an unpitched slide that lands exactly on the
            # open fret (0) — it's a documented CDLC charting gotcha (EOF warns on
            # it) and renders wrong in-game, so floor at fret 1 instead. The high
            # end has the mirror issue (exceeding the neck's fret limit), so it
            # stays clamped at MAX_FRET.
            unpitch_to = max(1, fret - 5) if slide == "outDown" else min(MAX_FRET, fret + 5)
            arr_props["unpitchedSlides"] = True
        if n.get("bend"):
            sustain = max(sustain, 0.2)
            mask |= S.BEND | S.SUSTAIN
            bends, max_bend = _bend_curve(n, time, sustain)
            arr_props["bends"] = True
        slap_kind = n.get("slap")
        if slap_kind == "slap":
            mask |= S.SLAP
            slap = 1
            arr_props["slapPop"] = True
        elif slap_kind == "pop":
            mask |= S.PLUCK
            pluck = 1
            arr_props["slapPop"] = True
        elif slap_kind == "tap":
            mask |= S.TAP
            tap = 1
            arr_props["tapping"] = True

        return mask, sustain, slide_to, unpitch_to, bends, max_bend, tap, slap, pluck

    for idx, e in enumerate(entities):
        pi_id = _find_pi(arr.pi_times, e.time, inclusive=True)
        sec = arr.sections[_find_section(arr.sections, e.time)]
        anchor_fret = e.anchor_fret
        anchor_width = e.anchor_width

        if e.chord_id == -1:
            string, fret, n = e.notes[0]
            sustain = e.sustain
            mask, vibrato = _base_note_mask(n, fret, sustain)
            mask |= S.SINGLE
            extra, sustain, slide_to, unpitch_to, bends, max_bend, tap, slap, pluck = techniques(
                n, string, fret, sustain, e.time, idx)
            mask |= extra
            if mask & S.SLIDE:
                anchor_exts.append(S.AnchorExtension(beat_time=e.time + sustain, fret=slide_to))

            if e.arpeggio_print != -1:
                mask |= S.ARPEGGIO
            note = S.Note(
                mask=mask, time=e.time, string=string, fret=fret,
                anchor_fret=anchor_fret, anchor_width=anchor_width,
                phrase_id=arr.phrase_iterations[pi_id].phrase_id, phrase_iteration_id=pi_id,
                slide_to=slide_to, slide_unpitch_to=unpitch_to,
                tap=tap, slap=slap, pluck=pluck, vibrato=vibrato,
                sustain=sustain, max_bend=max_bend, bend_values=bends,
                finger_print_id=(-1, e.arpeggio_print),
            )
            sec.string_mask[0] |= 1 << string
            last_fret_on_string[string] = fret
        else:
            # chord: template-level mask + optional per-string chord notes
            sustain = e.sustain
            template = chord_templates[e.chord_id]
            cn_id = -1
            include_chord_notes = e.first_in_shape or e.arpeggio_print != -1
            if include_chord_notes:
                # 6, not n_str: the SNG ChordNotes struct is a fixed uint32[6]
                # regardless of instrument (see sng.py), so a bass chord leaves
                # the last two slots at their unused defaults.
                cn_mask = [0] * 6
                cn_vib = [0] * 6
                cn_slide = [-1] * 6
                cn_unpitch = [-1] * 6
                cn_bend = [[] for _ in range(6)]
                # Limitation: sustain floor accumulates across strings in one pass —
                # an earlier string's bend curve can end up timed against a sustain
                # that a later string still extends. Same simultaneous onset either
                # way, so the skew is sub-frame and inaudible.
                for s, fret, n in e.notes:
                    m, vib = _base_note_mask(n, fret, sustain)
                    extra, sustain, slide_to, unpitch_to, bends, _, _, _, _ = techniques(
                        n, s, fret, sustain, e.time, idx)
                    cn_mask[s] = m | extra
                    cn_vib[s] = vib
                    cn_slide[s] = slide_to
                    cn_unpitch[s] = unpitch_to
                    cn_bend[s] = bends
                if any(cn_mask):
                    cn = S.ChordNotes(mask=cn_mask, slide_to=cn_slide,
                                      slide_unpitch_to=cn_unpitch, vibrato=cn_vib,
                                      bend_data=cn_bend)
                    cn_id = chord_notes_ids.setdefault(cn.key(), len(chord_notes_list))
                    if cn_id == len(chord_notes_list):
                        chord_notes_list.append(cn)

            mask = S.CHORD
            if sum(1 for f in template.frets if f != -1) == 2:
                mask |= S.DOUBLESTOP
                arr_props["doubleStops"] = True
            if sustain > 0:
                mask |= S.SUSTAIN
            if cn_id != -1:
                mask |= S.CHORDNOTES
            if e.arpeggio_print != -1:
                mask |= S.ARPEGGIO
            elif e.first_in_shape:
                mask |= S.CHORDPANEL
            else:
                mask |= S.HIGHDENSITY
            if all((n.get("fx") or {}).get("palmMute") for _, _, n in e.notes):
                mask |= S.PALMMUTE
            if all((n.get("fx") or {}).get("dead") for _, _, n in e.notes):
                mask |= S.FRETHANDMUTE
            if any((n.get("fx") or {}).get("accent") for _, _, n in e.notes):
                mask |= S.ACCENT
            if any(f == 0 for _, f, _ in e.notes):
                arr_props["openChords"] = True

            note = S.Note(
                mask=mask, time=e.time, string=-1, fret=-1,
                anchor_fret=anchor_fret, anchor_width=anchor_width,
                chord_id=e.chord_id, chord_notes_id=cn_id,
                phrase_id=arr.phrase_iterations[pi_id].phrase_id, phrase_iteration_id=pi_id,
                finger_print_id=(e.finger_print, e.arpeggio_print),
                pick_direction=-1, sustain=sustain,
            )
            for s, fret, _ in e.notes:
                sec.string_mask[0] |= 1 << s
                last_fret_on_string[s] = fret

        m = note.mask
        arr_props["palmMutes"] |= bool(m & S.PALMMUTE)
        arr_props["fretHandMutes"] |= bool(m & (S.MUTE | S.FRETHANDMUTE))
        arr_props["harmonics"] |= bool(m & S.HARMONIC)
        arr_props["pinchHarmonics"] |= bool(m & S.PINCHHARMONIC)
        arr_props["tremolo"] |= bool(m & S.TREMOLO)
        arr_props["vibrato"] |= bool(m & S.VIBRATO)
        arr_props["sustain"] |= bool(m & S.SUSTAIN)

        # numbered-fret flag: on first note and on anchor changes (never on opens)
        if note.fret != 0 and (prev_note is None or prev_note.anchor_fret != note.anchor_fret):
            note.flags = 1
        note.hash = zlib.crc32(struct.pack(
            "<IiiiiI", note.mask, int(note.time * 1000), note.string, note.fret,
            note.chord_id, int(note.sustain * 1000))) & 0xFFFFFFFF
        notes_per_pi[pi_id] += 1
        prev_note = note
        notes.append(note)

    # The ceiling is int16: the note-link fields below (next_iter_note,
    # prev_iter_note, parent_prev_note) are signed 16-bit indices INTO this
    # array, so beyond 32,767 a link silently wraps negative and the game reads
    # the wrong note. 32,000 leaves headroom. See the note record in sng.py.
    if len(notes) > 32000:
        raise ValueError(f"Too many notes for one arrangement ({len(notes)})")

    # intra-phrase-iteration note linkage (int16 indices into the notes array)
    for k, note in enumerate(notes):
        if k > 0 and notes[k - 1].phrase_iteration_id == note.phrase_iteration_id:
            note.prev_iter_note = k - 1
        if k + 1 < len(notes) and notes[k + 1].phrase_iteration_id == note.phrase_iteration_id:
            note.next_iter_note = k + 1

    return _Notes(notes=notes, chord_notes=chord_notes_list, anchor_extensions=anchor_exts,
                  arr_props=arr_props, per_pi=notes_per_pi,
                  dropped_slides=dropped_connected_slides)


def compile_track(track: dict, grid: dict, song_length: float,
                  section_markers: list | None = None,
                  phrase_boundaries: list | None = None) -> Compiled:
    """Run the five stages, then assemble the SNG.

    The stages are a straight pipeline, each named for what it produces. The
    assembly below was the sixth section of the original 617-line function and
    stayed here rather than becoming a seventh helper: it is not a stage, it is
    the thing that reads every stage's output at once, which is exactly what a
    function body is for.
    """
    warnings: list[str] = []
    tuning_hi_lo = [int(p) for p in track.get("tuning") or []]
    n_str = len(tuning_hi_lo)
    if n_str < 4 or n_str > 6:
        raise ValueError(f"Rocksmith needs a 4-6 string lane, got {n_str} strings")
    tuning_low = list(reversed(tuning_hi_lo))  # index 0 = lowest string

    voicing = _voiced_entities(track, n_str, tuning_low, warnings)
    entities = voicing.entities
    song_length = max(song_length, voicing.last_end + 0.5)

    arr = _beats_phrases_sections(grid, song_length, section_markers, phrase_boundaries,
                                  voicing.first_t, voicing.last_end, warnings)

    anchors_raw = _plan_anchors(entities, voicing.shape_info)
    fingerprints, arpeggios = _handshapes(entities, voicing.shape_info, arr.end_t)
    emitted = _emit_notes(entities, voicing.chord_templates, arr)
    notes = emitted.notes

    sng_anchors = []
    for k, (t, fret, width) in enumerate(anchors_raw):
        end = anchors_raw[k + 1][0] if k + 1 < len(anchors_raw) else arr.pi_times[-1]
        in_range = [n for n in notes if t <= n.time < end]
        if in_range:
            first_nt = in_range[0].time
            last = in_range[-1]
            last_nt = last.time if (last.mask & (S.SLIDE | S.PARENT)) else last.time + last.sustain
        else:
            first_nt, last_nt = S.UNINIT_FIRST_NOTE, S.UNINIT_LAST_NOTE
        sng_anchors.append(S.Anchor(
            start_time=t, end_time=end, first_note_time=first_nt, last_note_time=last_nt,
            fret=fret, width=width,
            phrase_iteration_id=_find_pi(arr.pi_times, t, inclusive=True)))

    level = S.Level(
        difficulty=0,
        anchors=sng_anchors,
        anchor_extensions=emitted.anchor_extensions,
        handshapes=fingerprints,
        arpeggios=arpeggios,
        notes=notes,
        average_notes_per_iteration=[float(emitted.per_pi[k]) for k in range(len(arr.phrases))],
        notes_in_pi_excl_ignored=list(emitted.per_pi),
        notes_in_pi_all=list(emitted.per_pi),
    )

    metadata = S.MetaData(
        max_notes_and_chords=float(len(notes)),
        max_notes_and_chords_real=float(len(notes)),
        points_per_note=100_000.0 / max(1, len(notes)),
        first_beat_length=arr.beats[1][0] - arr.beats[0][0],
        start_time=arr.beats[0][0],
        last_conversion_date_time=_conversion_stamp(),
        song_length=song_length,
        first_note_time=voicing.first_t,
    )

    sng_obj = S.SNG(
        beats=arr.sng_beats,
        phrases=arr.phrases,
        chords=voicing.chord_templates,
        chord_notes=emitted.chord_notes,
        phrase_iterations=arr.phrase_iterations,
        dnas=[(voicing.first_t, S.DNA_RIFF), (arr.end_t, S.DNA_NONE)],
        sections=arr.sections,
        levels=[level],
        metadata=metadata,
    )

    duration = arr.beats[-1][0] - arr.beats[0][0]
    average_tempo = (len(arr.beats) - 1) / duration * 60.0 if duration > 0 else 120.0
    if emitted.dropped_slides:
        warnings.append(
            f"{emitted.dropped_slides} connected slide(s) had no fretted "
            "same-string target and were dropped")
    if voicing.slide_ins:
        warnings.append(
            f"{voicing.slide_ins} slide-in(s) have no Rocksmith equivalent and were dropped")
    return Compiled(sng=sng_obj, note_count=len(notes), arr_props=emitted.arr_props,
                    average_tempo=average_tempo, warnings=warnings)
