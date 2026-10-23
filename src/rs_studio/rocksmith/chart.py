"""Compile the editor's tab spec into a Rocksmith SNG arrangement.

The editor gives notes in seconds with voiced string/fret (see tab.py's spec
docstring) — already audio-synced, so unlike the usual GP->EOF CDLC route no
manual re-sync is needed. This builds a single difficulty level (no dynamic
difficulty), phrases/sections every 8 measures, the editor's hand positions as
anchors, and maps the editor's effect fields onto SNG note masks.

Conversion rules follow Rocksmith2014.NET's XmlToSng* modules.
"""
from __future__ import annotations

import bisect
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

SUSTAIN_MIN = 0.18       # tail floor for slides, so the slide has something to draw
SUSTAIN_TAIL = 0.25      # a note value this long at the song's main tempo gets a tail
TECHNIQUE_SUSTAIN_MIN = 0.01  # vibrato/tremolo need a tail; DLC Builder asks for 5 ms
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

# Rocksmith has no field for an effect that starts late in a note: a slide runs
# over the whole sustain and so does vibrato. The editor's `slideStart` and
# `vibratoStart` (fractions of the note) are exported by cutting the note there
# into notes linked one to the next: each later piece is a Child, not picked
# again, carrying what starts at its cut. What belongs to the pick stays on the
# first piece.
_ATTACK_ONLY = ("grace", "slap", "stroke", "trill", "whammy", "shapeId", "shapeSource", "harmonic")
_ATTACK_FX = ("hammer", "accent", "staccato", "ghost", "dead")
_LINK_EPS = 0.002   # what counts as the same moment: onsets closer than this are one chord


def _onset_counter(notes: list):
    onsets = sorted(_f(n.get("start")) for n in notes)
    return lambda t: bisect.bisect_right(onsets, t + _LINK_EPS) - bisect.bisect_left(onsets, t - _LINK_EPS)


def _late_cuts(n: dict) -> tuple[float | None, float | None]:
    """(slide cut, vibrato cut) in seconds, or None for an effect from the pick."""
    start, end = _f(n.get("start")), _f(n.get("end"))
    to_next = n.get("slide") in ("shift", "legato")

    def cut(key: str) -> float | None:
        frac = _f(n.get(key))
        return start + frac * (end - start) if 0 < frac < 1 and end > start else None

    slide = cut("slideStart") if to_next else None
    vibrato = cut("vibratoStart") if (n.get("fx") or {}).get("vibrato") else None
    if vibrato is not None and to_next:
        # The slide's own piece can't be cut again: vibrato that starts later
        # covers the slide part, and a slide from the pick keeps it whole.
        vibrato = min(vibrato, slide) if slide is not None else None
    return slide, vibrato


def _split_late_effects(notes: list, fixes: list) -> list:
    """Late slides and late vibrato as linked pieces; see the comment above."""
    out = []
    for n in notes:
        slide_cut, vib_cut = _late_cuts(n)
        cuts = sorted({c for c in (slide_cut, vib_cut) if c is not None})
        if not cuts:
            out.append(n)
            continue
        # A bend curve spans the whole note and is not cut. A chord is cut too:
        # what follows a cut goes out as single notes (_voiced_entities).
        if n.get("bend"):
            fixes.append(("late-fx", _f(n.get("start"))))
            out.append(n)
            continue
        bounds = [_f(n.get("start")), *cuts, _f(n.get("end"))]
        for i, (a, b) in enumerate(zip(bounds, bounds[1:])):
            piece = {k: v for k, v in n.items() if k not in ("slideStart", "vibratoStart")}
            fx = dict(n.get("fx") or {})
            if i:
                piece = {k: v for k, v in piece.items() if k not in _ATTACK_ONLY}
                fx = {k: v for k, v in fx.items() if k not in _ATTACK_FX}
            if vib_cut is not None and a < vib_cut - 1e-9:
                fx.pop("vibrato", None)
            piece.pop("fx", None)
            if fx:
                piece["fx"] = fx
            piece["start"], piece["end"] = a, b
            if b < bounds[-1]:
                piece.pop("slide", None)
                piece["linkNext"] = True
            out.append(piece)
    return out


def _add_grace_notes(notes: list, grid: dict, fixes: list) -> list:
    """An editor grace note as Rocksmith charts one: a short note before the
    beat, a semitone or two lower, that the main note hammers on from.

    Timed as web/grace.js times it: a sixteenth at the local tempo, at most 80 ms,
    never below the open string.
    """
    segments = _tempo_segments(grid)
    out = []
    by_string: dict = {}
    for n in notes:
        by_string.setdefault(n.get("string"), []).append(_f(n.get("start")))
    for n in notes:
        interval = {"half": 1, "whole": 2}.get(n.get("grace"), 0)
        if not interval or n.get("string") is None or n.get("fret") is None:
            out.append(n)
            continue
        start, fret = _f(n.get("start")), int(n["fret"])
        bpm = next((b for t0, b, _ in reversed(segments) if t0 <= start + 1e-4), segments[0][1])
        dur = min(0.08, 15.0 / bpm, start)
        step = min(interval, fret)
        if dur <= 0 or not step or any(start - dur - _LINK_EPS < t < start - _LINK_EPS for t in by_string[n.get("string")]):
            fixes.append(("grace", start))
            out.append(n)
            continue
        grace = {k: n[k] for k in ("string", "hand") if k in n}
        grace.update(start=start - dur, end=start, fret=fret - step, pitch=_f(n.get("pitch")) - step)
        main = {k: v for k, v in n.items() if k != "grace"}
        main["fx"] = {**(n.get("fx") or {}), "hammer": True}
        out += [grace, main]
    return out


def _link_bend_continuations(notes: list) -> list:
    """A bend carried into the next note on its string — the same fret, starting
    at once, already bent as far as the first note ended — is one string held
    bent, so the first links to the second, which is not picked again (I07)."""
    onsets_at = _onset_counter(notes)
    out = [dict(n) for n in notes]
    by_string: dict = {}
    for n in out:
        if n.get("string") is not None:
            by_string.setdefault(n["string"], []).append(n)
    for run in by_string.values():
        run.sort(key=lambda n: _f(n.get("start")))
        for a, b in zip(run, run[1:]):
            pa, pb = bend_points(a), bend_points(b)
            if (pa and pb and a.get("fret") == b.get("fret") and pa[-1][1] > 0
                    and abs(pa[-1][1] - pb[0][1]) < 0.05 and onsets_at(_f(b.get("start"))) == 1
                    and abs(_f(b.get("start")) - _f(a.get("end"))) <= 0.005):
                a["linkNext"] = True
    return out


# A legato slide is a linked pair, as in XmlToSngNote.fs's pendingLinkNexts: the
# source is the Parent, held exactly until the target, and the target is its
# Child, which the game draws as the same note carrying on — no second pick. A
# shift slide stays two picked notes, which is what "shift" means.
# A chord a linked note runs into is written as single notes at one time, as EOF
# does, so every one of them can be a Child.


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
    fixes: list = field(default_factory=list)   # (issue code, time): what the export changed, where


def _f(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ---- beat grid -------------------------------------------------------------

def _tempo_segments(grid: dict) -> list[tuple[float, float, int]]:
    """(start, bpm, beats per measure) for each stretch of constant tempo."""
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

    return [(offset, bpm, ts)] + markers


def _sustain_rule(grid: dict, song_length: float):
    """Whether a note of `dur` seconds starting at `t` gets a tail.

    Decided by note value, not by the raw length: the length is rounded to the
    nearest note value at the local tempo, then timed at the song's main tempo
    (the one covering most of the song). So every eighth in a song gets the same
    answer, a few ms of gap never flips it, and slow songs still sustain eighths.
    """
    segments = _tempo_segments(grid)
    span: dict[float, float] = {}
    for i, (t0, bpm, _) in enumerate(segments):
        t1 = segments[i + 1][0] if i + 1 < len(segments) else max(song_length, t0)
        span[bpm] = span.get(bpm, 0.0) + t1 - t0
    main_beat = 60.0 / max(span, key=span.get)

    def sustained(t: float, dur: float) -> bool:
        bpm = next((b for t0, b, _ in reversed(segments) if t0 <= t + 1e-4), segments[0][1])
        value = round(dur * bpm / 60.0 * 24) / 24      # whole beats, to the nearest 1/24
        return value * main_beat >= SUSTAIN_TAIL - 1e-6
    return sustained


def _leave_note_gaps(entities: list, grid: dict) -> None:
    """End each tail 1/32 of a measure before the next note, as EOF does.

    Export only: the editor keeps the lengths as played. A tail is cut when it
    runs into the next note on one of its strings, or ends within the gap of the
    next note anywhere (legato played up to the next onset). A tail that clearly
    rings over notes on other strings is let ring. Short notes have no tail, so
    trills and fast runs are untouched.
    """
    segments = _tempo_segments(grid)

    def gap_at(t: float) -> float:
        _, bpm, ts = next((s for s in reversed(segments) if s[0] <= t + 1e-4), segments[0])
        return ts * 60.0 / bpm / 32

    for i, e in enumerate(entities):
        # The next onset: single notes written for one chord share a time.
        nxt = next((x.time for x in entities[i + 1:] if x.time > e.time + _LINK_EPS), None)
        if e.sustain <= 0 or nxt is None:
            continue
        end = e.time + e.sustain
        strings = {s for s, _, _ in e.notes}
        same = next((x.time for x in entities[i + 1:] if strings & {s for s, _, _ in x.notes}), None)
        limits = [same - gap_at(same)] if same is not None and end > same - gap_at(same) else []
        if abs(end - nxt) <= gap_at(nxt):
            limits.append(nxt - gap_at(nxt))
        if limits:
            e.sustain = max(0.0, min(limits) - e.time)
            if e.sustain < 1e-3:
                vibrato = any((n.get("fx") or {}).get("vibrato") or n.get("tremPick") for _, _, n in e.notes)
                e.sustain = TECHNIQUE_SUSTAIN_MIN if vibrato else 0.0


def _gen_beats(grid: dict, song_length: float) -> list[tuple[float, int, int]]:
    segments = _tempo_segments(grid)
    beats = []  # (time, measure, beat_in_measure)
    measure = -1
    for i, (t0, bpm, ts) in enumerate(segments):
        t_end = segments[i + 1][0] if i + 1 < len(segments) else song_length
        step = 60.0 / bpm
        t, beat_in = t0, 0
        # A marker a hair after a beat (placed by hand, float drift) must not leave
        # a sliver measure before it: EOF reads a 1 ms measure as 60000 BPM.
        while t < t_end - step / 4:
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
    # BasicFixes.removeOverlappingBendValues: one value per moment, the first
    # one (I34). Same moment = same millisecond, the resolution it is read at.
    seen: set[int] = set()
    unique = []
    for b in values:
        ms = round(b.time * 1000)
        if ms not in seen:
            seen.add(ms)
            unique.append(b)
    values = unique
    return values[:32], max((v for _, v in pts), default=0.0) / 2.0


def _chord_name(notes) -> str:
    """The name the editor gave these notes' chord, or "" when it gave none."""
    return next((str(n["chordName"]) for n in notes if n.get("chordName")), "")


def _finger(n: dict, fret: int) -> int:
    """The editor's finger on a fretted note (0 thumb, 1 index .. 4 pinky), else -1.

    The editor numbers fingers as Rocksmith does. -1 is "no finger", which an open
    string must have: a 0 there draws a T on the string (DLC Builder's I28).
    """
    finger = n.get("finger")
    return finger if fret > 0 and isinstance(finger, int) and 0 <= finger <= 4 else -1


@dataclass
class _Voicing:
    """Stage 1's output: the editor's notes as playable events."""
    entities: list[_Entity]
    chord_templates: list          # S.ChordTemplate, indexed by _Entity.chord_id
    shape_info: dict               # shapeId -> {chord_id, start, end, frets}
    slide_ins: int                 # slide-ins seen; they have no RS equivalent
    first_t: float
    last_end: float
    dead_left_out: list = field(default_factory=list)   # chord times that lost a dead note (I29)


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
    ignored_per_pi: list           # of which ignored (_ignored)
    dropped_slides: list           # times of connected slides with no fretted target


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
                     warnings: list, fixes: list, sustained, capo: int = 0) -> _Voicing:
    """Editor notes -> entities (chords = same onset), chord templates, Shapes.

    Takes nothing from the rest of the compile: it reads the track and produces
    what everything downstream indexes by. Notes without a string/fret position
    are dropped and frets past the neck are clamped, both with a warning.
    """
    voiced = []
    for n in track.get("notes") or []:
        if n.get("string") is None or n.get("fret") is None:
            fixes.append(("unvoiced", _f(n.get("start"))))
            continue
        rs_string = n_str - int(n["string"])  # GP string 1 = highest
        fret = int(n["fret"])
        if not (0 <= rs_string < n_str) or fret < 0:
            fixes.append(("unvoiced", _f(n.get("start"))))
            continue
        # The editor counts frets from the capo; Rocksmith counts them from the nut
        # and keeps 0 for a string open at the capo (Rocksmith2014.NET Midi.toMidiNote).
        if capo and fret > 0:
            fret += capo
        if fret > MAX_FRET:
            fret = MAX_FRET
            fixes.append(("fret", _f(n.get("start"))))
        voiced.append((_f(n.get("start")), rs_string, fret, n))
    if not voiced:
        raise ValueError("No voiced notes to export")
    voiced.sort(key=lambda v: (v[0], v[1]))

    chord_templates: list[S.ChordTemplate] = []
    chord_ids: dict[tuple, int] = {}

    def ensure_chord_template(frets: list, midi: list, fingers: list, name: str, t: float, *, arpeggio: bool = False) -> int:
        """One template per grip, fingering and name: the same grip fingered or named two ways is two.

        The name is the editor's (web/chords.js, or the user's own), sent on the notes.
        """
        mask = S.CHORD_MASK_ARPEGGIO if arpeggio else 0
        key = (tuple(frets), tuple(fingers), name, mask)
        if key not in chord_ids:
            chord_ids[key] = len(chord_templates)
            if any(f > 0 and g == -1 for f, g in zip(frets, fingers)):
                fixes.append(("finger", t))   # where the grip is first played
            chord_templates.append(S.ChordTemplate(
                frets=frets, fingers=fingers, notes=midi,
                name=name, mask=mask))
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
        finger_on = {}
        conflict = False
        for _, string, fret, n in members:
            if string in by_string and by_string[string] != fret:
                conflict = True
            by_string[string] = fret
            finger_on.setdefault(string, _finger(n, fret))
        if conflict or len(by_string) < 2:
            warnings.append(f"Shape {shape_id} cannot be held on one fixed multi-string grip and was exported as ordinary notes")
            continue
        frets = [-1] * 6
        midi = [-1] * 6
        fingers = [-1] * 6
        for string, fret in by_string.items():
            frets[string] = fret
            midi[string] = tuning_low[string] + (fret or capo)
            fingers[string] = finger_on[string]
        start = min(item[0] for item in members)
        end = max(max(_f(item[3].get("end"), item[0]), item[0] + 0.02) for item in members)
        shape_info[shape_id] = {
            "chord_id": ensure_chord_template(frets, midi, fingers, _chord_name(m[3] for m in members), start, arpeggio=True),
            "start": start, "end": end, "frets": list(by_string.values()),
        }

    entities: list[_Entity] = []
    dead_left_out = []
    carried: dict[int, bool] = {}   # string -> its last note is carried on by the next (linked)
    i = 0
    while i < len(voiced):
        j = i
        group = {}
        while j < len(voiced) and voiced[j][0] - voiced[i][0] < 0.002:
            group.setdefault(voiced[j][1], voiced[j])  # one note per string
            j += 1
        t = voiced[i][0]
        notes = [(s, fret, n) for s, (_, _, fret, n) in sorted(group.items())]
        dead = [item for item in notes if (item[2].get("fx") or {}).get("dead")]
        if dead and len(dead) < len(notes):
            # BasicFixes.removeMutedNotesFromChords: the game needs every chord
            # note's pitch to detect the chord (I29). A fully muted chord stays.
            notes = [item for item in notes if item not in dead]
            dead_left_out.append(t)
        # A chord that a linked note runs into goes out as single notes at one time,
        # as EOF writes it: Rocksmith links a note only to a single note (I03).
        split = len(notes) > 1 and any(carried.get(s) for s, _, _ in notes)
        for s, _, n in notes:
            carried[s] = bool(n.get("linkNext") or n.get("slide") == "legato")
        for notes in ([[item] for item in notes] if split else [notes]):
            dur = max(_f(n.get("end"), t) - t for _, _, n in notes)
            sustain = dur if sustained(t, dur) else 0.0
            if not sustain and any((n.get("fx") or {}).get("vibrato") or n.get("tremPick") for _, _, n in notes):
                # Vibrato and tremolo are drawn on the tail; without one DLC Builder
                # reports I40. Such a note keeps the length it has in the editor.
                sustain = max(dur, TECHNIQUE_SUSTAIN_MIN)
            ent = _Entity(time=t, sustain=sustain, notes=notes)
            entity_shape_ids = {n.get("shapeId") for _, _, n in notes if n.get("shapeId") in shape_info}
            if len(entity_shape_ids) == 1 and all(n.get("shapeId") in entity_shape_ids for _, _, n in notes):
                ent.shape_id = next(iter(entity_shape_ids))
            if len(notes) >= 2:
                frets = [-1] * 6
                midi = [-1] * 6
                fingers = [-1] * 6
                for s, fret, n in notes:
                    frets[s] = fret
                    midi[s] = tuning_low[s] + (fret or capo)
                    fingers[s] = _finger(n, fret)
                ent.chord_id = ensure_chord_template(frets, midi, fingers, _chord_name(n for _, _, n in notes), t)
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
        dead_left_out=dead_left_out,
    )


def _beats_phrases_sections(grid: dict, song_length: float, section_markers: list | None,
                            phrase_boundaries: list | None, first_t: float, last_end: float,
                            warnings: list, song_end: float | None = None) -> _Arrangement:
    """The beat map, and the phrase/section structure laid over it.

    Sections come from the editor's markers when there are any and from an
    eight-measure fallback when there are not. Ordinary sections land on
    measure boundaries, with a warning if snapping exceeds 20ms. The special
    End section retains its exact timestamp and defines the terminal phrase.
    """
    # End is an editor section type with terminal semantics. Rocksmith stores
    # it as its END phrase plus the final noguitar section, not a riff section.
    ends = [
        _f(raw.get("t"), -1.0) for raw in section_markers or []
        if str(raw.get("sectionType") or raw.get("rocksmithType") or raw.get("text") or "").strip().lower() == "end"
        and _f(raw.get("t"), -1.0) >= 0
    ]
    if ends:
        song_end = min(ends)
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
        if ms < min(last_end, song_end if song_end is not None else song_length) - 1e-4
    ]
    if not automatic_boundaries:
        automatic_boundaries = [measure_starts[p1_idx]]
    end_t = max(beats[0][0] + 0.001, min(song_length, song_end if song_end is not None else song_length))
    # Even an arrangement whose first note is beyond END needs a valid initial
    # section; the checker will report that note rather than hiding it.
    automatic_boundaries = [t for t in automatic_boundaries if t < end_t - 1e-4] or [beats[0][0]]

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
        if name == "end":
            continue
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


def _hand_anchors(entities: list, shape_info: dict, capo: int, pi_times: list, fixes: list) -> list:
    """Rocksmith hand positions from the editor's: (time, fret, width), stamped on each entity.

    Every note arrives with the fret the fretboard's index finger stands on
    (`hand`, counted from the capo like `fret`). A position starts wherever that
    changes, and every phrase starts with one (EOFFixes.fixPhraseStartAnchors).
    Its width is four frets, or more when a note it covers reaches further, as EOF
    writes it. Two identical positions in a row are one, except at a phrase start
    (BasicFixes.removeRedundantAnchors). Notes with nothing fretted keep the hand
    where it is.

    A note without a hand (a spec not built by the editor) keeps the current one
    when it reaches, else puts the index on its lowest fret, and is counted in a
    warning: the export does not plan hands of its own.
    """
    floor = capo + 1
    changes: list[tuple[float, int]] = []
    cur = None
    for e in entities:
        held = shape_info[e.shape_id]["frets"] if e.shape_id in shape_info else [f for _, f, _ in e.notes]
        fretted = [f for f in held if f > 0]
        hands = [int(n["hand"]) for _, f, n in e.notes if f > 0 and isinstance(n.get("hand"), (int, float))]
        if hands:
            fret = max(floor, min(hands) + capo)
        elif fretted:
            lo, hi = min(fretted), max(fretted)
            fret = cur if cur is not None and cur <= lo and hi - cur < 6 else max(floor, lo)
            fixes.append(("hand", e.time))
        else:
            fret = cur if cur is not None else floor
        fret = min(fret, MAX_FRET - ANCHOR_WIDTH + 1)
        if fret != cur:
            changes.append((e.time, fret))
            cur = fret

    anchors = _phrase_start_anchors([(t, fret, ANCHOR_WIDTH) for t, fret in changes], pi_times)
    phrase_times = set(pi_times)
    out: list[tuple[float, int, int]] = []
    for k, (t, fret, _) in enumerate(anchors):
        end = anchors[k + 1][0] if k + 1 < len(anchors) else math.inf
        reach = [f for e in entities if t - 1e-6 <= e.time < end - 1e-6
                 for f in (shape_info[e.shape_id]["frets"] if e.shape_id in shape_info else [f for _, f, _ in e.notes])
                 if f > 0]
        width = max(ANCHOR_WIDTH, max(reach, default=0) - fret + 1)
        if out and out[-1][1:] == (fret, width) and t not in phrase_times:
            continue
        out.append((t, fret, width))
    for e in entities:
        active = next((a for a in reversed(out) if a[0] <= e.time + 1e-6), out[0] if out else None)
        if active:
            e.anchor_fret, e.anchor_width = active[1], active[2]
    return out


def _phrase_start_anchors(anchors: list, pi_times: list) -> list:
    """Every phrase starts with an anchor: EOFFixes.fixPhraseStartAnchors.

    DLC Builder applies this to every package it builds, even with its other
    improvements turned off: riff repeater and DD levels start playing at a
    phrase and need the hand position there. The anchor in force is copied to
    the phrase start; before the first anchor, the next one moves up to it (or
    is copied, when it already starts another phrase). The first and the END
    phrase are skipped, as there.
    """
    anchors = list(anchors)
    same = lambda a, b: abs(a - b) < 1e-5  # noqa: E731
    for t in pi_times[1:-1]:
        active = next((k for k in range(len(anchors) - 1, -1, -1) if anchors[k][0] <= t + 1e-5), None)
        if active is not None:
            if not same(anchors[active][0], t):
                anchors.insert(active + 1, (t, *anchors[active][1:]))
            continue
        if anchors:
            first = anchors[0]
            if any(same(first[0], p) for p in pi_times):
                anchors.insert(0, (t, *first[1:]))
            else:
                anchors[0] = (t, *first[1:])
    return anchors


def _handshapes(entities: list, shape_info: dict, end_t: float, pi_times: list) -> tuple[list, list]:
    """Fingerprints (runs of the same chord) and arpeggios (editor Shapes).

    A run may only skip ChordNotes (HighDensity "just repeat the last one") when
    NOTHING about the chord changed since the previous hit. Same chord_id alone
    isn't enough: XmlToSngNote.fs's FixHighDensity explicitly keeps ChordNotes on
    the chord where a whole-chord mute/palm-mute starts or ends, even mid-run,
    so the mute transition doesn't get silently dropped as "identical repeat".

    A run also stops at a phrase start, and its shape ends there: every phrase
    begins with an anchor (_phrase_start_anchors), and an anchor inside a held
    shape breaks it (DLC Builder's I21/I22). The first chord of the new phrase
    opens a fresh shape, the "crazy" chord EOF charters are told to set.
    """
    def phrase_of(t: float) -> int:
        return _find_pi(pi_times, t, inclusive=True)

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
               and _mute_state(entities[j]) == _mute_state(e)
               and phrase_of(entities[j].time) == phrase_of(e.time)):
            run.append(entities[j])
            j += 1
        last = run[-1]
        end = last.time + max(last.sustain, 0.05) + 0.001
        if j < len(entities):
            end = min(end, entities[j].time - 0.001)
        end = min(end, end_t, next((t for t in pi_times if t > last.time + 1e-5), end_t))
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


def _ignored(e: _Entity, note: S.Note) -> bool:
    """BasicFixes.addIgnores: notes the game cannot score, left out of the score.

    Frets 23 and 24 are not detected reliably, nor is a 7th fret natural
    harmonic held on (DLC Builder's I13). A chord is ignored when any of its
    notes is; its chord notes carry no flag of their own.
    """
    def unscorable(fret: int, n: dict) -> bool:
        harmonic = n.get("harmonic") and n.get("harmonic") != "pinch"
        return fret >= 23 or (fret == 7 and harmonic and note.sustain > 0)
    return any(unscorable(fret, n) for _, fret, n in e.notes)


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
    ignored_per_pi = [0] * len(arr.pi_times)
    arr_props = dict.fromkeys((
        "powerChords", "openChords", "doubleStops", "palmMutes", "harmonics",
        "pinchHarmonics", "hopo", "tremolo", "slides", "unpitchedSlides",
        "bends", "tapping", "vibrato", "fretHandMutes", "slapPop", "sustain"), False)
    last_fret_on_string: dict[int, int] = {}
    prev_note: S.Note | None = None
    dropped_connected_slides = []

    # string -> index of a legato Parent still waiting for its Child. The index
    # is the note's own: one SNG note per entity, so it equals `idx`.
    link_parents: dict[int, int] = {}

    def next_on_string(idx: int, string: int) -> tuple[int, float, bool] | None:
        """(fret, time, whether it is part of a chord) of the next note on the string."""
        for e2 in entities[idx + 1:]:
            for s, f, _ in e2.notes:
                if s == string:
                    return f, e2.time, len(e2.notes) > 1
        return None

    def techniques(n: dict, string: int, fret: int, sustain: float, time: float, idx: int) -> tuple:
        """HammerOn/PullOff/Slide/Bend/Slap/Pluck/Tap — shared by single notes and
        per-string chord notes (XmlToSngNote.fs applies this same set to both;
        Open/Sustain/PalmMute/Vibrato/etc are handled by _base_note_mask instead).
        """
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
        linked = False
        if n.get("linkNext"):
            # A note carried on by the next one on its string (a late slide or
            # vibrato, a held bend): it runs exactly to it.
            target = next_on_string(idx, string)
            if target is not None and target[0] == fret and not target[2]:
                sustain = target[1] - time
                mask |= S.PARENT | S.SUSTAIN
                link_parents[string] = idx
                linked = True
        slide = n.get("slide")
        if slide in ("shift", "legato"):
            target = next_on_string(idx, string)
            if target is not None and target[0] != fret and target[0] > 0:
                sustain = max(sustain, SUSTAIN_MIN)
                mask |= S.SLIDE | S.SUSTAIN
                slide_to = target[0]
                arr_props["slides"] = True
                if slide == "legato":
                    # Held right up to the target, gap or overlap in the editor
                    # notwithstanding: the game only links a Child that starts
                    # where its Parent's sustain ends.
                    sustain = target[1] - time
                    mask |= S.PARENT
                    link_parents[string] = idx
            else:
                dropped_connected_slides.append(time)
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
            # An anchor where the slide ends may not show in the game (I23), and
            # anchors sit on note onsets and phrase starts. End a little before.
            later = itertools.takewhile(lambda t: t < time + sustain + 0.004,
                                        (e2.time for e2 in entities[idx + 1:]))
            for boundary in [*later, *(t for t in arr.pi_times if t > time)]:
                if abs(time + sustain - boundary) < 0.004 and boundary - time > 0.02:
                    sustain = boundary - time - 0.01
        if n.get("bend"):
            if not linked:   # a linked tail must end where its Child starts
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
            parent = link_parents.pop(string, -1)
            mask, vibrato = _base_note_mask(n, fret, sustain)
            mask |= S.SINGLE
            if parent != -1:
                mask |= S.CHILD
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
                parent_prev_note=parent,
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
            for s, _, _ in e.notes:
                link_parents.pop(s, None)      # a chord is never a Child
            template = chord_templates[e.chord_id]
            cn_id = -1
            include_chord_notes = (e.first_in_shape or e.arpeggio_print != -1
                                   or any(n.get("linkNext") or n.get("slide") == "legato" for _, _, n in e.notes))
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
                if any(m & S.PARENT for m in chord_notes_list[cn_id].mask):
                    mask |= S.PARENT
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

        if _ignored(e, note):
            note.mask |= S.IGNORE
            ignored_per_pi[pi_id] += 1
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
                  arr_props=arr_props, per_pi=notes_per_pi, ignored_per_pi=ignored_per_pi,
                  dropped_slides=dropped_connected_slides)


def compile_track(track: dict, grid: dict, song_length: float,
                  section_markers: list | None = None,
                  phrase_boundaries: list | None = None,
                  song_end: float | None = None) -> Compiled:
    """Run the five stages, then assemble the SNG.

    The stages are a straight pipeline, each named for what it produces. The
    assembly below was the sixth section of the original 617-line function and
    stayed here rather than becoming a seventh helper: it is not a stage, it is
    the thing that reads every stage's output at once, which is exactly what a
    function body is for.
    """
    warnings: list[str] = []
    fixes: list = []   # (code, time): what the export changed on a note (checker.FIXED)
    tuning_hi_lo = [int(p) for p in track.get("tuning") or []]
    n_str = len(tuning_hi_lo)
    if n_str < 4 or n_str > 6:
        raise ValueError(f"Rocksmith needs a 4-6 string lane, got {n_str} strings")
    tuning_low = list(reversed(tuning_hi_lo))  # index 0 = lowest string

    capo = max(0, int(track.get("capo") or 0))
    notes = _add_grace_notes(track.get("notes") or [], grid, fixes)
    notes = _link_bend_continuations(_split_late_effects(notes, fixes))
    track = {**track, "notes": notes}
    voicing = _voiced_entities(track, n_str, tuning_low, warnings, fixes,
                               _sustain_rule(grid, song_length), capo)
    entities = voicing.entities
    _leave_note_gaps(entities, grid)
    audio_end = song_length
    song_length = max(song_length, voicing.last_end + 0.5)

    arr = _beats_phrases_sections(grid, song_length, section_markers, phrase_boundaries,
                                  voicing.first_t, voicing.last_end, warnings,
                                  song_end=audio_end if song_end is None else song_end)

    anchors_raw = _hand_anchors(entities, voicing.shape_info, capo, arr.pi_times, fixes)
    fingerprints, arpeggios = _handshapes(entities, voicing.shape_info, arr.end_t, arr.pi_times)
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
        notes_in_pi_excl_ignored=[a - b for a, b in zip(emitted.per_pi, emitted.ignored_per_pi)],
        notes_in_pi_all=list(emitted.per_pi),
    )

    metadata = S.MetaData(
        max_notes_and_chords=float(len(notes)),
        max_notes_and_chords_real=float(len(notes) - sum(emitted.ignored_per_pi)),
        points_per_note=100_000.0 / max(1, len(notes)),
        first_beat_length=arr.beats[1][0] - arr.beats[0][0],
        start_time=arr.beats[0][0],
        last_conversion_date_time=_conversion_stamp(),
        song_length=song_length,
        first_note_time=voicing.first_t,
        capo_fret_id=capo if capo > 0 else -1,
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
    return Compiled(sng=sng_obj, note_count=len(notes), arr_props=emitted.arr_props,
                    average_tempo=average_tempo, warnings=warnings,
                    fixes=sorted(dict.fromkeys(fixes + [("I29", t) for t in voicing.dead_left_out]
                                               + [("slide", t) for t in emitted.dropped_slides]), key=lambda f: f[1]))
