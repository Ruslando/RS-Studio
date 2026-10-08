"""Build a Guitar Pro (.gp5) file from the editor's edit-lane notes.

The editor holds notes as ``{start, end, pitch(MIDI)}`` in seconds plus a tempo
grid. This module quantizes those notes against the grid, auto-assigns a
string/fret per the chosen tuning, and assembles a PyGuitarPro ``Song`` — one
track per edit lane — written to ``.gp5`` bytes (the format Guitar Pro 6/7/8 and
alphaTab all read).

The single entry point is :func:`build_gp5`, which takes the same kind of
client-supplied payload the project export uses (so it works on unsaved edits):

    {
      "name": "My song",
      "grid": {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4},
      "resolution": 4,               # quantize grid: slots per quarter note
      "tracks": [
        {"name": "Bass", "tuning": [43, 38, 33, 28],   # open-string MIDI, hi→lo
         "notes": [{"start": 0.0, "end": 0.5, "pitch": 40}, ...]},
        ...
      ]
    }

Rhythm handling is exact for grid-snapped, mostly-monophonic input (the common
case here): overlapping notes are truncated at the next onset (single voice),
notes crossing a barline are tied, and odd lengths decompose into tied figures.
"""
from __future__ import annotations

import io
import math

import guitarpro as gp
from guitarpro import models as M

GP5_VERSION = (5, 1, 0)
MAX_FRET = 24
QUARTER_TICKS = M.Duration.quarterTime  # 960

# General-MIDI program per instrument family, for nicer playback in GP/alphaTab.
_GM_BASS = 33   # Electric Bass (finger)
_GM_GUITAR = 25  # Acoustic Guitar (steel)


def _pos_int(value, default: int) -> int:
    try:
        out = int(value)
    except (TypeError, ValueError):
        return default
    return out if out > 0 else default


# STRING INDICES: this module uses BOTH conventions and each is right where it is.
#   1-based  — Guitar Pro's own numbering, string 1 = highest-pitched. Anything
#              that talks to pyguitarpro (a note's `string`, a spec's positions)
#              is 1-based, because the file format is.
#   0-based  — plain list indices into a tuning array.
# Every function that takes or returns one says which in its docstring. If you
# add one, say it there too: an off-by-one here transposes a whole part by a
# string and the file still opens.
def _required_resolution(ts_den: int, subdiv: int) -> int:
    """Smallest integer slots-per-quarter that can exactly hold this grid cell."""
    den = max(1, ts_den) * max(1, subdiv)
    return max(1, den // math.gcd(den, 4))


def _effective_resolution(grid: dict, requested: int) -> int:
    """Lift the requested resolution enough to represent every marker division.

    Front-end `subdiv` is cells per local denominator beat. The exporter uses one
    slots-per-quarter lattice, so it must be fine enough for each marker's
    denominator/subdivision pair.
    """
    res = max(1, requested)
    base_tsd = _pos_int(grid.get("tsDen"), 4)
    base_sub = _pos_int(grid.get("subdiv"), 0) if grid.get("subdiv") is not None else 0
    if base_sub:
        res = math.lcm(res, _required_resolution(base_tsd, base_sub))
    cur_tsd, cur_sub = base_tsd, base_sub
    markers = []
    for m in grid.get("tempoMap") or []:
        try:
            markers.append((float(m.get("t")), m))
        except (TypeError, ValueError):
            continue
    for _t, m in sorted(markers, key=lambda x: x[0]):
        cur_tsd = _pos_int(m.get("tsDen"), cur_tsd)
        if m.get("subdiv") is not None:
            cur_sub = _pos_int(m.get("subdiv"), cur_sub or res)
        if cur_sub:
            res = math.lcm(res, _required_resolution(cur_tsd, cur_sub))
    return res

# Editor slide kinds -> Guitar Pro slide types.
_SLIDE_TYPES = {
    "shift": M.SlideType.shiftSlideTo,      # to next note, re-picked
    "legato": M.SlideType.legatoSlideTo,    # to next note, slurred
    "inBelow": M.SlideType.intoFromBelow,   # scoop up into the note
    "inAbove": M.SlideType.intoFromAbove,   # slide down into the note
    "outDown": M.SlideType.outDownwards,    # fall off the note
    "outUp": M.SlideType.outUpwards,        # slide up off the note
}
_SLIDE_IN = {"inBelow", "inAbove"}  # decorate the note's onset; the rest its end

# Editor boolean effect keys -> Guitar Pro NoteEffect flags.
_FX_FLAGS = {
    "hammer": "hammer",       # hammer-on / pull-off (GP infers direction from pitch)
    "palmMute": "palmMute",
    "letRing": "letRing",
    "ghost": "ghostNote",
    "vibrato": "vibrato",
    "staccato": "staccato",
    "accent": "accentuatedNote",
}


def _apply_fx(note: "M.Note", fx: dict | None) -> None:
    """Set the boolean NoteEffect flags carried in the editor's ``fx`` dict."""
    if not fx:
        return
    for key, attr in _FX_FLAGS.items():
        if fx.get(key):
            setattr(note.effect, attr, True)


# Editor bend preset id -> canonical curve as [(t, semitones)], t across the note.
# Mirrors web/bend.js: a preset is only a starting shape, and the editor stores an
# explicit curve in note["bendPoints"] only once a control point has been dragged.
# Keep the two tables in sync.
BEND_PRESETS = {
    "quarter": [(0, 0), (0.5, 0.5), (1, 0.5)],
    "half": [(0, 0), (0.5, 1), (1, 1)],
    "full": [(0, 0), (0.5, 2), (1, 2)],
    "onehalf": [(0, 0), (0.5, 3), (1, 3)],
    "twostep": [(0, 0), (0.5, 4), (1, 4)],
    "release": [(0, 0), (0.5, 2), (1, 0)],
    "prebend": [(0, 2), (1, 2)],
    "prebendRelease": [(0, 2), (0.5, 2), (1, 0)],
    "bendReleaseBend": [(0, 0), (1 / 3, 2), (2 / 3, 0), (1, 2)],
}


def bend_points(fx: dict) -> "list[tuple[float, float]] | None":
    """The curve one note actually sounds: its dragged points, else its preset's."""
    pts = fx.get("bendPoints")
    if pts:
        return [(float(t), float(v)) for t, v in pts]
    preset = fx.get("bend")
    if not preset:
        return None
    return BEND_PRESETS.get(preset) or BEND_PRESETS["full"]


def _bend_type(values: "list[int]") -> "M.BendType":
    """Which of GP's five note-bend presets a curve looks like (picks the glyph).

    Read off the curve's direction changes, not its extremes: a bend that
    releases and then pushes past its first peak is still bend-release-bend.
    """
    if values[0] > 0:
        return M.BendType.prebendRelease if values[-1] < values[0] else M.BendType.prebend
    turns: list[int] = []
    for a, b in zip(values, values[1:]):
        d = (b > a) - (b < a)
        if d and (not turns or turns[-1] != d):
            turns.append(d)
    if len(turns) >= 3:
        return M.BendType.bendReleaseBend
    return M.BendType.bendRelease if turns == [1, -1] else M.BendType.bend


def _make_bend(fx: dict) -> "M.BendEffect | None":
    """Build a BendEffect curve from an editor bend, or None.

    Point ``value`` is in quarter-tones (4 = a whole-step bend) over ``position``
    0..12 spanning the note; PyGuitarPro scales these to the .gp5 file units. That
    12-column x quarter-tone grid is Guitar Pro's own bend editor, so a curve
    snapped in the editor survives exactly and only a free-dragged one rounds.
    """
    pts = bend_points(fx)
    if not pts:
        return None
    gp_points = [(round(t * 12), round(v * 2)) for t, v in pts]
    values = [v for _, v in gp_points]
    return M.BendEffect(
        type=_bend_type(values), value=max(values),
        points=[M.BendPoint(position=p, value=v) for p, v in gp_points],
    )


# Editor harmonic type id -> PyGuitarPro HarmonicEffect subclass (one per note).
_HARMONICS = {
    "natural": M.NaturalHarmonic,
    "pinch": M.PinchHarmonic,
}

# Grace/trill presets: interval in semitones from the main note (below / above).
_GRACE_INTERVALS = {"half": 1, "whole": 2}
_TRILL_INTERVALS = {"half": 1, "whole": 2}
# Tremolo-picking rate id -> Duration value. GP only encodes 8th/16th/32nd.
_TREMPICK_RATES = {"8": 8, "16": 16, "32": 32}


def _make_grace(preset: "str | None", main_fret: int) -> "M.GraceEffect | None":
    """A grace note `preset` semitones below the main note, hammered on, before the beat."""
    iv = _GRACE_INTERVALS.get(preset)
    if iv is None:
        return None
    return M.GraceEffect(fret=max(0, main_fret - iv), isOnBeat=False,
                         transition=M.GraceEffectTransition.hammer)


def _make_trill(preset: "str | None", main_fret: int) -> "M.TrillEffect | None":
    """A trill to a fret `preset` semitones above the main note, at a 16th-note rate."""
    iv = _TRILL_INTERVALS.get(preset)
    if iv is None:
        return None
    return M.TrillEffect(fret=main_fret + iv, duration=M.Duration(value=16))


def _make_trempick(preset: "str | None") -> "M.TremoloPickingEffect | None":
    rate = _TREMPICK_RATES.get(preset)
    if rate is None:
        return None
    return M.TremoloPickingEffect(duration=M.Duration(value=rate))


def _apply_note_effects(note: "M.Note", f: dict | None) -> None:
    """Apply every per-note effect carried in one onset's fx dict to a GP note."""
    if not f:
        return
    _apply_fx(note, f)                                  # boolean flags (incl. staccato/accent)
    bend = _make_bend(f)
    if bend:
        note.effect.bend = bend
    harm = _HARMONICS.get(f.get("harmonic"))
    if harm:
        note.effect.harmonic = harm()
    grace = _make_grace(f.get("grace"), note.value)
    if grace:
        note.effect.grace = grace
    trill = _make_trill(f.get("trill"), note.value)
    if trill:
        note.effect.trill = trill
    trempick = _make_trempick(f.get("tremPick"))
    if trempick:
        note.effect.tremoloPicking = trempick
    if f.get("dead"):                                   # the muted "X" note (a note type, not an effect)
        note.type = M.NoteType.dead


# ---- beat-level effects (attach to the onset beat, not a single note) ----
_SLAPS = {"tap": M.SlapEffect.tapping, "slap": M.SlapEffect.slapping, "pop": M.SlapEffect.popping}
_STROKES = {"up": M.BeatStrokeDirection.up, "down": M.BeatStrokeDirection.down}
# Tremolo-bar (whammy) presets -> (BendType, points in quarter-tones; negative = bar down).
_WHAMMY = {
    "dip":  (M.BendType.dip,  [(0, 0), (6, -4), (12, 0)]),
    "dive": (M.BendType.dive, [(0, 0), (12, -4)]),
}


def _make_whammy(preset: "str | None") -> "M.BendEffect | None":
    spec = _WHAMMY.get(preset)
    if spec is None:
        return None
    btype, pts = spec
    return M.BendEffect(type=btype, value=4,
                        points=[M.BendPoint(position=p, value=v) for p, v in pts])


def _apply_beat_fx(beat: "M.Beat", f: dict | None) -> None:
    """Apply slap / stroke / tremolo-bar from an onset's fx dict to its beat."""
    if not f:
        return
    slap = _SLAPS.get(f.get("slap"))
    if slap:
        beat.effect.slapEffect = slap
    stroke = _STROKES.get(f.get("stroke"))
    if stroke:
        beat.effect.stroke = M.BeatStroke(direction=stroke, value=M.Duration.sixteenth)
    whammy = _make_whammy(f.get("whammy"))
    if whammy:
        beat.effect.tremoloBar = whammy


def _is_bass(tuning: list[int]) -> bool:
    """Heuristic: a tuning whose highest open string is below the guitar G3."""
    return max(tuning) < 52


def _quantize(notes: list[dict], to_slot) -> list[tuple[int, int, int, str | None, dict, tuple[int, int] | None]]:
    """Snap notes to integer slots (1/`resolution` of a quarter) via `to_slot`
    (seconds -> global slot, tempo-map aware). Returns (start_slot, end_slot, midi,
    slide, fx, pos) sorted by onset then descending pitch. `pos` is the front-end's
    (string, fret) choice (1-based string) or None."""
    out: list[tuple[int, int, int, str | None, dict, tuple[int, int] | None]] = []
    for n in notes:
        s = max(0, to_slot(float(n["start"])))
        e = to_slot(float(n["end"]))
        if e <= s:
            e = s + 1
        # The single-choice effects (bend/harmonic/grace/trill/tremPick + the
        # beat effects slap/stroke/whammy) ride in the fx bag — keeps the tuple arity.
        fx = dict(n.get("fx") or {})
        for k in ("bend", "bendPoints", "harmonic", "grace", "trill", "tremPick", "slap", "stroke", "whammy"):
            if n.get(k):
                fx[k] = n[k]
        st, ft = n.get("string"), n.get("fret")
        pos = (int(st), int(ft)) if st is not None and ft is not None else None
        out.append((s, e, int(round(float(n["pitch"]))), n.get("slide"), fx, pos))
    out.sort(key=lambda x: (x[0], -x[2]))
    return out


def _figure_table(resolution: int) -> list[tuple[int, int, bool, tuple[int, int] | None]]:
    """Standard note figures expressible on this grid, as
    (slots, gp_value, isDotted, tuplet_or_None), largest first."""
    figs: set[tuple[int, int, bool, tuple[int, int] | None]] = set()
    for value in (1, 2, 4, 8, 16, 32):           # whole … 32nd
        for dotted in (False, True):
            slots = resolution * 4 / value * (1.5 if dotted else 1)
            if slots >= 1 and float(slots).is_integer():
                figs.add((int(slots), value, dotted, None))
    if resolution % 3 == 0:                       # triplet grids (e.g. 1/8T, 1/16T)
        for value in (8, 16):
            slots = resolution * 4 / value * 2 / 3
            if slots >= 1 and float(slots).is_integer():
                figs.add((int(slots), value, False, (3, 2)))
    return sorted(figs, key=lambda f: -f[0])


def _decompose(slots: int, figs: list) -> list[tuple[int, bool, tuple[int, int] | None]]:
    """Greedily split a span of `slots` into standard figures (ties them).
    Returns a list of (gp_value, isDotted, tuplet)."""
    out: list[tuple[int, bool, tuple[int, int] | None]] = []
    remaining = slots
    guard = 0
    while remaining > 0 and guard < 256:
        guard += 1
        for sl, value, dotted, tuplet in figs:
            if sl <= remaining:
                out.append((value, dotted, tuplet))
                remaining -= sl
                break
        else:
            break  # nothing fits (shouldn't happen: smallest fig is 1 slot)
    return out or [(figs[-1][1], figs[-1][2], figs[-1][3])]


def _assign_fret(pitch: int, tuning: list[int]) -> tuple[int, int] | None:
    """Lowest playable fret for `pitch`; (string_number, fret) or None if out
    of range. Strings are 1-based, string 1 = highest open (GP order)."""
    best: tuple[int, int] | None = None
    for idx, open_midi in enumerate(tuning):
        fret = pitch - open_midi
        if 0 <= fret <= MAX_FRET and (best is None or fret < best[1]):
            best = (idx + 1, fret)
    return best


def _valid_pos(pos: "tuple[int, int] | None", pitch: int, tuning: list[int]) -> bool:
    """True when `pos` (1-based string, fret) is in range and actually sounds
    `pitch` on this tuning — guards against a stale/mismatched front-end voicing."""
    if not pos:
        return False
    s, f = pos
    return 1 <= s <= len(tuning) and 0 <= f <= MAX_FRET and tuning[s - 1] + f == pitch


def _common_string(pitches: list[int], tuning: list[int]) -> int | None:
    """Pick one 0-based string on which *every* pitch is playable. Used to keep
    slide-linked notes on a single string so the slide is playable. You can't
    slide on or off an open string, so an all-fretted string is preferred over
    one where any note is open; within each, the lowest position wins. Returns
    None if no single string fits them all (falls back to per-note placement)."""
    best_key = best_idx = None
    for idx, open_midi in enumerate(tuning):
        frets = [p - open_midi for p in pitches]
        if all(0 <= f <= MAX_FRET for f in frets):
            open_flag = 0 if all(f >= 1 for f in frets) else 1   # fretted strings first
            key = (open_flag, max(frets), sum(frets))
            if best_key is None or key < best_key:
                best_key, best_idx = key, idx
    return best_idx


def _make_beat(voice, value: int, dotted: bool, tuplet, frets, note_type) -> M.Beat:
    b = M.Beat(voice)
    b.duration = M.Duration(value=value, isDotted=dotted)
    if tuplet:
        b.duration.tuplet = M.Tuplet(enters=tuplet[0], times=tuplet[1])
    if not frets:
        b.status = M.BeatStatus.rest
    else:
        b.status = M.BeatStatus.normal
        for string, fret in frets:
            n = M.Note(b)
            n.type = note_type
            n.string = string
            n.value = fret
            b.notes.append(n)
    return b


def _build_track_measures(track, q, bounds, tuning, figs, warnings, tempo_marks=None) -> None:
    """Walk each measure slot-by-slot, emitting note/rest beats; ties sustained
    notes (across barlines or truncated by a later onset). `bounds` is a list of
    (start_slot, end_slot) per measure (variable, so meter changes give shorter
    bars); `tempo_marks[mi]`, when set, drops a tempo change on that bar's downbeat."""
    # Precompute string/fret for every note. The front-end voices the lane and
    # ships each note's (string, fret), which is the source of truth here. The
    # one exception is shift/legato slide chains: they must share a string (you
    # slide along one string), so each such chain is pinned to a single common
    # string. Anything without a valid front-end position falls back to the
    # lowest playable fret.
    q = list(q)
    placed = []
    i = 0
    while i < len(q):
        chain = [i]
        while q[chain[-1]][3] in ("shift", "legato") and chain[-1] + 1 < len(q):
            chain.append(chain[-1] + 1)
        sidx = _common_string([q[j][2] for j in chain], tuning) if len(chain) > 1 else None
        if len(chain) > 1 and sidx is None:
            warnings.add(f"{track.name}: a shift/legato slide spans more than one string — placed without same-string snapping")
        for j in chain:
            s, e, pitch, slide, fx, pos = q[j]
            if sidx is not None:
                fr = (sidx + 1, pitch - tuning[sidx])      # slide chain: keep one string
            elif _valid_pos(pos, pitch, tuning):
                fr = pos                                    # front-end voicing
            else:
                fr = _assign_fret(pitch, tuning)           # fallback
            if fr is None:
                warnings.add(f"{track.name}: note {pitch} out of range for this tuning (skipped)")
                continue
            placed.append((s, e, fr, slide, fx))
        i = chain[-1] + 1

    for mi, (ms, me) in enumerate(bounds):
        measure = M.Measure(track, track.song.measureHeaders[mi])
        voice = measure.voices[0]
        voice.beats = []
        cursor = ms
        while cursor < me:
            onsets = [p for p in placed if p[0] == cursor]
            ties = [p for p in placed if p[0] < cursor < p[1]]
            # Next boundary: next onset, or the end of any sounding note, or bar end.
            cands = [me]
            cands += [p[0] for p in placed if cursor < p[0] < me]
            cands += [p[1] for p in (onsets + ties) if cursor < p[1] <= me]
            nxt = min(cands)
            span = nxt - cursor
            active = onsets or ties
            note_type = M.NoteType.normal if onsets else M.NoteType.tie
            # GP allows at most one note per string per beat. Overlapping or
            # duplicate notes (common from tracing) can resolve to the same
            # string; writing two notes on one string desyncs and corrupts the
            # .gp5 stream. Collapse collisions to the lowest fret on each string.
            by_string: dict[int, tuple[int, int]] = {}
            for _s, _e, fr, _sl, _fx in active:
                cur = by_string.get(fr[0])
                if cur is None or fr[1] < cur[1]:
                    by_string[fr[0]] = fr
            frets = sorted(by_string.values())
            seg_beats = []
            for k, (value, dotted, tuplet) in enumerate(_decompose(span, figs)):
                # First sub-figure carries the onset; the rest tie it over.
                nt = note_type if k == 0 else M.NoteType.tie
                b = _make_beat(voice, value, dotted, tuplet, frets, nt)
                voice.beats.append(b)
                seg_beats.append(b)
            # Slides attach to the note in GP; pick the right tied segment. A
            # slide INTO the note marks its first segment; a slide to the next
            # note or OUT of it marks the segment that ends here.
            into = {fr[0]: sl for _s, _e, fr, sl, _fx in onsets if sl in _SLIDE_IN}
            outof = {fr[0]: sl for _s, e2, fr, sl, _fx in active if sl and sl not in _SLIDE_IN and e2 == nxt}
            # Boolean effects attach to the note's onset (keyed by string).
            fx_by_string = {fr[0]: fx for _s, _e, fr, _sl, fx in onsets if fx}
            for note in seg_beats[0].notes:
                if into.get(note.string):
                    note.effect.slides = note.effect.slides + [_SLIDE_TYPES[into[note.string]]]
                _apply_note_effects(note, fx_by_string.get(note.string))
            # Beat-level effects (slap/stroke/whammy) ride on an onset's fx.
            for f in fx_by_string.values():
                _apply_beat_fx(seg_beats[0], f)
            for note in seg_beats[-1].notes:
                if outof.get(note.string):
                    note.effect.slides = note.effect.slides + [_SLIDE_TYPES[outof[note.string]]]
            cursor = nxt
        if not voice.beats:  # empty measure → rest(s) sized to the (maybe partial) bar
            for value, dotted, tuplet in _decompose(me - ms, figs):
                voice.beats.append(_make_beat(voice, value, dotted, tuplet, [], M.NoteType.rest))
            if not voice.beats:
                voice.beats.append(_make_beat(voice, 1, False, None, [], M.NoteType.rest))
        # A tempo change (from a marker) rides the downbeat of this bar, applied to
        # all tracks — only the first track carries it so it isn't written twice.
        if tempo_marks is not None and tempo_marks[mi] is not None and voice.beats:
            mtc = M.MixTableChange()
            mtc.tempo = M.MixTableItem(value=int(tempo_marks[mi]), duration=0, allTracks=True)
            mtc.hideTempo = False
            voice.beats[0].effect.mixTableChange = mtc
        track.measures.append(measure)


def _segments(grid: dict, resolution: int) -> list[dict]:
    """The tempo/meter segments, sorted by time. Segment 0 is the global grid at
    `offset`; the rest come from `grid['tempoMap']` (absolute-time markers). bpm is
    the quarter-note tempo; a beat is one denominator note = (4/tsDen) quarters."""
    offset = float(grid.get("offset") or 0.0)
    bpm0 = float(grid.get("bpm") or 120) or 120
    tsn0 = int(grid.get("tsNum") or 4)
    tsd0 = int(grid.get("tsDen") or 4)
    subdiv0 = _pos_int(grid.get("subdiv"), resolution)
    raw = [{"t": offset, "bpm": bpm0, "ts_num": tsn0, "ts_den": tsd0, "subdiv": subdiv0}]
    for m in (grid.get("tempoMap") or []):
        try:
            t = float(m["t"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (t > offset + 1e-6):
            continue
        raw.append({"t": t, "bpm": float(m.get("bpm") or bpm0) or bpm0,
                    "ts_num": int(m.get("tsNum") or tsn0), "ts_den": int(m.get("tsDen") or tsd0),
                    "subdiv": _pos_int(m.get("subdiv"), subdiv0)})
    raw.sort(key=lambda s: s["t"])
    prev = raw[0]
    for s in raw:
        if s is not raw[0]:
            s["bpm"] = s.get("bpm") or prev["bpm"]
            s["ts_num"] = s.get("ts_num") or prev["ts_num"]
            s["ts_den"] = s.get("ts_den") or prev["ts_den"]
            s["subdiv"] = s.get("subdiv") or prev["subdiv"]
        quarter = 60.0 / s["bpm"] if s["bpm"] else 0.0
        s["quarter_sec"] = quarter
        s["beat_sec"] = (4.0 / s["ts_den"]) * quarter
        s["measure_slots"] = max(1, int(round(s["ts_num"] * (4.0 / s["ts_den"]) * resolution)))
        s["slots_per_beat"] = s["measure_slots"] / s["ts_num"]
        prev = s
    return raw


def _plan_measures(segs: list[dict], resolution: int) -> tuple[list[dict], "callable"]:
    """Lay out measures for every segment EXCEPT the last (each is bounded by the
    next marker, its length quantized to a whole number of beats — any leftover is
    a short pickup bar with its own time signature). Fills seg['slot_start'].
    Returns (measures, to_slot) where to_slot maps seconds -> global slot."""
    measures: list[dict] = []
    slot = 0
    for k in range(len(segs) - 1):
        seg = segs[k]
        seg["slot_start"] = slot
        beats = max(1, int(round((segs[k + 1]["t"] - seg["t"]) / seg["beat_sec"]))) if seg["beat_sec"] else seg["ts_num"]
        tempo = None if k == 0 else int(round(seg["bpm"]))
        full, rem = divmod(beats, seg["ts_num"])
        first = True
        for _ in range(full):
            measures.append({"slots": seg["measure_slots"], "ts_num": seg["ts_num"],
                             "ts_den": seg["ts_den"], "tempo": tempo if first else None})
            slot += seg["measure_slots"]
            first = False
        if rem:
            ps = max(1, int(round(rem * seg["slots_per_beat"])))
            measures.append({"slots": ps, "ts_num": rem, "ts_den": seg["ts_den"],
                             "tempo": tempo if first else None})
            slot += ps
            first = False
    segs[-1]["slot_start"] = slot

    def to_slot(t: float) -> int:
        seg = segs[0]
        for s in segs:
            if s["t"] <= t + 1e-9:
                seg = s
            else:
                break
        if not seg["quarter_sec"]:
            return seg["slot_start"]
        return seg["slot_start"] + int(round((t - seg["t"]) / seg["quarter_sec"] * resolution))

    return measures, to_slot


def build_gp5(spec: dict) -> tuple[bytes, list[str]]:
    """Build a .gp5 from the editor spec. Returns (bytes, warnings)."""
    grid = spec.get("grid", {}) or {}
    requested_resolution = max(1, int(spec.get("resolution") or grid.get("subdiv") or 4))
    resolution = _effective_resolution(grid, requested_resolution)

    tracks_spec = [t for t in spec.get("tracks", []) if t.get("notes") and t.get("tuning")]
    if not tracks_spec:
        raise ValueError("No notes to export — add some notes to an edit lane first.")

    warnings: set[str] = set()
    figs = _figure_table(resolution)

    segs = _segments(grid, resolution)
    measures, to_slot = _plan_measures(segs, resolution)

    # Quantize every track first to learn how far the last segment must run.
    quantized = [(t, _quantize(t["notes"], to_slot)) for t in tracks_spec]
    end_slot = max((seg[1] for _, q in quantized for seg in q), default=0)
    last = segs[-1]
    last_tempo = None if len(segs) == 1 else int(round(last["bpm"]))
    n_last = max(1, math.ceil((end_slot - last["slot_start"]) / last["measure_slots"]))
    for i in range(n_last):
        measures.append({"slots": last["measure_slots"], "ts_num": last["ts_num"],
                         "ts_den": last["ts_den"], "tempo": last_tempo if i == 0 else None})

    song = M.Song()
    song.tempo = int(round(segs[0]["bpm"]))
    song.title = spec.get("name") or "Untitled"
    song.tracks = []
    song.measureHeaders = []
    bounds: list[tuple[int, int]] = []
    tempo_marks: list[int | None] = []
    cur_slot, tick = 0, QUARTER_TICKS
    for mi, m in enumerate(measures):
        bounds.append((cur_slot, cur_slot + m["slots"]))
        cur_slot += m["slots"]
        tempo_marks.append(m["tempo"])
        h = M.MeasureHeader()
        h.number = mi + 1
        h.start = tick  # GP measures start at 1 quarter; cumulative for variable bars
        h.timeSignature = M.TimeSignature(numerator=m["ts_num"], denominator=M.Duration(value=m["ts_den"]))
        song.measureHeaders.append(h)
        tick += int(round(m["ts_num"] * (4.0 / m["ts_den"]) * QUARTER_TICKS))

    # Guitar Pro markers are measure-header annotations. Section markers remain
    # audio-time annotations in the editor, so resolve each one to the nearest
    # planned measure boundary after the tempo/meter plan is complete.
    occupied_markers: set[int] = set()
    for section in spec.get("sections") or []:
        try:
            section_slot = to_slot(float(section.get("t", 0.0)))
        except (TypeError, ValueError):
            continue
        if not bounds:
            break
        measure_index = min(range(len(bounds)), key=lambda index: abs(bounds[index][0] - section_slot))
        title = str(section.get("text") or section.get("marker") or "").strip()
        if not title:
            continue
        if measure_index in occupied_markers:
            warnings.add(
                f"Multiple section markers resolved to bar {measure_index + 1}; "
                "the first one was kept and the later marker was skipped")
            continue
        song.measureHeaders[measure_index].marker = M.Marker(title=title)
        occupied_markers.add(measure_index)

    for ti, (tspec, q) in enumerate(quantized, start=1):
        tuning = [int(v) for v in tspec["tuning"]]
        track = M.Track(song, number=ti)
        track.name = tspec.get("name") or f"Track {ti}"
        track.strings = [M.GuitarString(i + 1, v) for i, v in enumerate(tuning)]
        gm = tspec.get("instrument")  # General-MIDI program from the lane's instrument
        track.channel.instrument = int(gm) if gm is not None else (_GM_BASS if _is_bass(tuning) else _GM_GUITAR)
        track.measures = []
        # Only track 1 carries the tempo automations (allTracks=True applies them globally).
        _build_track_measures(track, q, bounds, tuning, figs, warnings, tempo_marks if ti == 1 else None)
        song.tracks.append(track)

    buf = io.BytesIO()
    gp.write(song, buf, version=GP5_VERSION)
    return buf.getvalue(), sorted(warnings)
