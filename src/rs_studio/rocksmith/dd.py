"""Dynamic difficulty: easier versions of every phrase, as DLC Builder generates them.

Rocksmith2014.NET's Rocksmith2014.DD (Generator, NoteScorer, LevelCounter,
EntityChooser, HandShapeChooser), rule for rule on chart.py's entities, with
three deliberate differences (notes/dd-analyse.md, section 5):

- a reduced chord drops the same strings from its notes as from its template
  (DLC Builder trims the chord notes from the top even when the template keeps
  the top strings);
- vibrato goes at 45 % even when tremolo went at 35 % in the same step;
- the phrases stay as the user named them (chart.py groups them), so this only
  levels; it does not merge, rename or link phrases.

Works on one phrase iteration at a time. A level is a list of entities; the
hardest is the iteration's own, untouched.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass

MAX_LEVELS = 30          # LevelCounter.MaximumPossibleLevels
MIN_LEVELS = 2           # LevelCounter.MinimumNumberOfLevelsToGenerate
_PHRASE_DIVISIONS = (0, 3, 2, 3, 1, 3, 2, 3, 4)   # NoteScorer.phraseDivisions


def ms(t: float) -> int:
    return int(round(t * 1000))


def _round_away(x: float) -> int:
    """MidpointRounding.AwayFromZero, for positive numbers."""
    return int(math.floor(x + 0.5))


def _fx(n: dict) -> dict:
    return n.get("fx") or {}


def _links(n: dict) -> bool:
    """A note carried on into the next one on its string (XML linkNext)."""
    return bool(n.get("linkNext") or n.get("slide") == "legato")


def _is_tap(n: dict) -> bool:
    return n.get("slap") == "tap"


def _has_technique(n: dict) -> bool:
    """Anything DLC Builder keeps in a note's mask or technique fields, Ignore and
    LinkNext aside (EntityChooser's includeAlways test)."""
    fx = _fx(n)
    return bool(fx.get("palmMute") or fx.get("dead") or fx.get("accent") or fx.get("vibrato")
                or (fx.get("hammer") and fx["hammer"] != "origin") or n.get("tremPick")
                or n.get("harmonic") or n.get("slide") or n.get("bend") or n.get("slap"))


# ---- scores (NoteScorer.fs) ---------------------------------------------------

def _subdivision(start: int, end: int, time: int) -> int:
    dist = float(end - start)
    pos = float(time - start)
    mid = dist / 2
    if pos - mid > 10:
        pos -= mid
    return _round_away(dist / pos) if pos > 0 else 1000


def _subdivision_in_measure(phrase_end: int, beats: list, time: int) -> int:
    first = next((b for b in reversed(beats) if b[0] < time and b[1]), None)
    if first is None:
        return 2
    following = next((b for b in beats if b[0] > time and b[1]), None)
    return _subdivision(first[0], following[0] if following else phrase_end, time)


def _division_in_phrase(start: int, end: int, time: int) -> int:
    length = (end - start) / len(_PHRASE_DIVISIONS)
    index = int((time - start) // length) if length > 0 else 0
    return _PHRASE_DIVISIONS[min(max(index, 0), len(_PHRASE_DIVISIONS) - 1)]


def _penalty(e) -> int:
    notes = [n for _, _, n in e.notes]
    if all(_fx(n).get("dead") for n in notes):
        return 20
    if e.chord_id == -1 and notes[0].get("bend"):
        return 10
    return 0


def score(e, beats: list, start: int, end: int) -> int:
    """beats: (ms, is first beat of a measure) inside the phrase iteration."""
    time = ms(e.time)
    b1 = next((b for b in reversed(beats) if b[0] <= time), None)
    b2 = next((b for b in beats if b[0] >= time), None)
    if b1 is None:
        position = 20
    elif b2 is not None:
        if time == b1[0]:
            position = 0 if b1[1] else _subdivision_in_measure(end, beats, time)
        else:
            position = 10 * _subdivision(b1[0], b2[0], time)
    else:
        position = 10 * _subdivision(b1[0], end, time)
    return _penalty(e) + _division_in_phrase(start, end, time) + position


@dataclass
class _Range:
    low: float
    high: float


def _score_map(scores: list) -> dict:
    counts: dict[int, int] = {}
    for s in scores:
        counts[s] = counts.get(s, 0) + 1
    out, low = {}, 0.0
    for s in sorted(counts):
        high = low + counts[s] / len(scores)
        out[s] = _Range(low, high)
        low = high
    return out


# ---- level count (LevelCounter.fs, "Simple") ----------------------------------

def _note_count(template) -> int:
    return sum(1 for f in template.frets if f >= 0)


def max_chord_strings(entities: list, templates: list) -> int:
    return max((_note_count(templates[e.chord_id]) for e in entities if e.chord_id != -1), default=0)


def _signature(n: dict) -> tuple:
    return tuple(sorted((k, repr(v)) for k, v in n.items() if k not in ("start", "end", "id")))


def level_count(entities: list, templates: list, beats: list, start: int, end: int) -> int:
    """How many levels a phrase iteration gets on its own; 1 without notes."""
    if not entities:
        return 1
    base = len(set(score(e, beats, start, end) for e in entities))
    singles = [e for e in entities if e.chord_id == -1]
    chords = [e for e in entities if e.chord_id != -1]
    repeated = sum(1 for a, b in zip(singles, singles[1:])
                   if a.notes[0][:2] == b.notes[0][:2] and _signature(a.notes[0][2]) == _signature(b.notes[0][2]))
    repeated += sum(1 for a, b in zip(chords, chords[1:]) if a.chord_id == b.chord_id)
    count = base // 2 if base > 15 and repeated / len(entities) > 0.8 else base
    return min(max(count, max(MIN_LEVELS, max_chord_strings(entities, templates))), MAX_LEVELS)


def hero_levels(max_difficulty: int) -> tuple[int, int, int]:
    """Easy, medium, hard: a third and two thirds of the way, as in official
    files (DLC Builder takes a quarter and a half). With two levels all three are
    the top one: DLC Builder notes that Score Attack crashes otherwise."""
    if max_difficulty <= 0:
        return (0, 0, 0)
    if max_difficulty == 1:
        return (1, 1, 1)
    return (_round_away(max_difficulty / 3), _round_away(2 * max_difficulty / 3), max_difficulty)


# ---- choosing a level (EntityChooser.fs) ----------------------------------------

def from_highest(total: int, frets) -> bool:
    """Double and triple stops on the highest strings keep their top notes."""
    return ((total == 3 and frets[5] > -1 and frets[4] > -1 and frets[3] > -1)
            or (total == 2 and frets[5] > -1 and frets[4] > -1))


def kept_strings(frets, count: int) -> set:
    """The strings a chord keeps when cut to `count` notes: the lowest ones, or
    the highest for a stop on the top strings."""
    used = [s for s, f in enumerate(frets) if f >= 0]
    return set(used[-count:] if from_highest(len(used), frets) else used[:count])


class Templates:
    """The arrangement's chord templates; a cut chord adds one with the same name."""

    def __init__(self, templates: list):
        self.list = templates
        self.ids = {self._key(t): k for k, t in enumerate(templates)}

    @staticmethod
    def _key(t) -> tuple:
        return tuple(t.frets), tuple(t.fingers), t.name, t.mask

    def cut(self, chord_id: int, strings: set) -> int:
        t = self.list[chord_id]
        cut = copy.copy(t)
        cut.frets = [f if s in strings else -1 for s, f in enumerate(t.frets)]
        cut.fingers = [f if s in strings else -1 for s, f in enumerate(t.fingers)]
        cut.notes = [m if s in strings else -1 for s, m in enumerate(t.notes)]
        key = self._key(cut)
        if key not in self.ids:
            self.ids[key] = len(self.list)
            self.list.append(cut)
        return self.ids[key]


def _allowed_chord_notes(p: float, max_chord: int) -> int:
    return 0 if max_chord == 0 else math.ceil(p * max_chord - 1e-9)


def _copy_note(n: dict) -> dict:
    out = dict(n)
    out["fx"] = dict(_fx(n))
    return out


def _prune(e, n: dict, string: int, p: float, removed: set) -> None:
    """pruneTechniques: what a note loses at this level (fixed: vibrato goes at
    45 % whether or not tremolo went at 35 %)."""
    fx = n["fx"]
    if p <= 0.2:
        if not n.get("bend"):
            e.sustain = 0.0
        if _links(n):
            removed.add(string)
        for key in ("linkNext", "slide", "slideFrets", "tremPick"):
            n.pop(key, None)
        for key in ("hammer", "accent", "vibrato"):
            fx.pop(key, None)
        if n.get("harmonic") == "pinch":
            n.pop("harmonic")
        if n.get("slap") in ("slap", "pop"):
            n.pop("slap")
    if p <= 0.35 and n.get("tremPick") and not _is_tap(n):
        n.pop("tremPick")
    if p <= 0.45 and fx.get("vibrato") and not _is_tap(n):
        fx.pop("vibrato")
    if p <= 0.6 and n.get("harmonic") == "pinch":
        n.pop("harmonic")


def _strings_of(e) -> list:
    return [s for s, _, _ in e.notes]


def choose(p: float, entities: list, scores: list, templates: Templates, max_chord: int) -> list:
    """The entities of one level at fraction p (0 < p < 1) of a phrase iteration."""
    ranges = _score_map(scores)
    with_score: dict[int, int] = {}
    for s in scores:
        with_score[s] = with_score.get(s, 0) + 1
    current: dict[int, int] = {}
    removed: set = set()          # strings whose linked note was dropped
    pending: dict[int, tuple] = {}   # string -> (entity, note) carried on into the next
    allowed = _allowed_chord_notes(p, max_chord)
    out: list = []

    def exclude(s: int) -> bool:
        r = ranges[s]
        if p < r.low:
            return True
        if p < r.high:
            share = (p - r.low) / (r.high - r.low)
            allowed_count = max(1 if r.low == 0 else 0, _round_away(with_score[s] * share))
            return current.get(s, 0) + 1 > allowed_count
        return False

    def drop_pending(string: int) -> None:
        held = pending.pop(string, None)
        if held is not None:
            ent, n = held
            if n.get("slide") == "legato":
                n.pop("slide", None)
                ent.sustain = 0.0
            n.pop("linkNext", None)

    for e, s in zip(entities, scores):
        # A plain note that a kept note is carried on into always stays.
        always = e.chord_id == -1 and e.notes[0][0] in pending and not _has_technique(e.notes[0][2])
        if not always and exclude(s):
            if e.chord_id == -1:
                string, _, n = e.notes[0]
                drop_pending(string)
                if n.get("linkNext") and not n.get("slide"):
                    removed.add(string)
                else:
                    removed.discard(string)
            else:
                for string, _, n in e.notes:
                    if n.get("linkNext") and not n.get("slide"):
                        removed.add(string)
            continue

        if e.chord_id == -1:
            string, fret, n = e.notes[0]
            if string in removed:
                # The note before it on the string was linked into it and is gone.
                if not _links(n):
                    removed.discard(string)
                continue
            current[s] = current.get(s, 0) + 1
            ent = copy.copy(e)
            note = _copy_note(n)
            ent.notes = [(string, fret, note)]
            _prune(ent, note, string, p, removed)
            pending.pop(string, None)
            if _links(note):
                pending[string] = (ent, note)
            if _fx(note).get("hammer") and note["fx"]["hammer"] != "origin" and not _keeps_hopo(ent, out, entities, e):
                note["fx"].pop("hammer")
            out.append(ent)
            continue

        current[s] = current.get(s, 0) + 1
        template = templates.list[e.chord_id]
        count = _note_count(template)
        if allowed <= 1:
            ent = _single_from_chord(e, template, count, p, removed)
            string, _, note = ent.notes[0]
            if _links(note):
                pending[string] = (ent, note)
            out.append(ent)
            continue
        ent = copy.copy(e)
        if allowed < count:
            keep = kept_strings(template.frets, allowed)
            for string, _, n in e.notes:
                if string not in keep and _links(n):
                    removed.add(string)
            ent.notes = [(st, f, n) for st, f, n in e.notes if st in keep]
            ent.chord_id = templates.cut(e.chord_id, keep)
        ent.notes = [(st, f, _copy_note(n)) for st, f, n in ent.notes]
        for string, _, note in ent.notes:
            _prune(ent, note, string, p, removed)
            if _links(note):
                pending[string] = (ent, note)
        out.append(ent)
    # Generator.fs clears a chord's link when none of its notes links on; here a
    # chord's link is read off its notes (chart.py), so the two cannot disagree.
    return out


def _single_from_chord(e, template, count: int, p: float, removed: set):
    """noteFromChord: the lowest note, or the highest of a stop on the top strings."""
    top = from_highest(count, template.frets)
    pick = e.notes[-1] if top else e.notes[0]
    for string, _, n in e.notes:
        if (string, n) != (pick[0], pick[2]) and _links(n):
            removed.add(string)
    ent = copy.copy(e)
    note = _copy_note(pick[2])
    note.pop("finger", None)
    ent.notes = [(pick[0], pick[1], note)]
    ent.chord_id = -1
    _prune(ent, note, pick[0], p, removed)
    return ent


def _keeps_hopo(ent, kept: list, entities: list, original) -> bool:
    """A hammer-on or pull-off stays only where the note it comes from is still
    right before it (EntityChooser's HOPO rule)."""
    string, fret, _ = ent.notes[0]
    before_all = next((x for x in reversed(entities[:entities.index(original)])
                       if string in _strings_of(x)), None)
    if before_all is None:
        return True   # a hammer-on from nowhere
    before_level = next((x for x in reversed(kept) if string in _strings_of(x)), None)
    if before_level is None:
        return False
    if before_level.chord_id == -1 and _is_tap(before_level.notes[0][2]):
        return True
    if abs(before_level.time - before_all.time) < 1e-6 and (before_level.chord_id == -1) == (before_all.chord_id == -1):
        return True
    if before_level is kept[-1] and before_level.chord_id == -1:
        prev = before_level.notes[0]
        prev_fx = _fx(prev[2])
        return not (prev_fx.get("dead") or (prev[2].get("harmonic") and prev[2]["harmonic"] != "pinch")) and prev[1] != fret
    return False


def generate(entities: list, count: int, templates: Templates, beats: list, start: float, end: float) -> list:
    """The levels of one phrase iteration, easiest first; the last is `entities`."""
    if count <= 1 or not entities:
        return [list(entities)] * max(1, count)
    start_ms, end_ms = ms(start), ms(end)
    beats_ms = [(ms(t), first) for t, first in beats]
    scores = [score(e, beats_ms, start_ms, end_ms) for e in entities]
    max_chord = max_chord_strings(entities, templates.list)
    levels = [choose((d + 1) / count, entities, scores, templates, max_chord) for d in range(count - 1)]
    return levels + [list(entities)]


# ---- handshapes (HandShapeChooser.fs) -----------------------------------------

def is_arpeggio(members: list) -> bool:
    """HandShapeChooser.isArpeggio: single notes on more than one string, at more than one time."""
    singles = [e for e in members if e.chord_id == -1]
    if not singles:
        return False
    first = singles[0]
    return not all(e.notes[0][0] == first.notes[0][0] or abs(e.time - first.time) < 1e-6 for e in singles)


def shape_at_level(info: dict, members_full: list, members_level: list, p: float, max_chord: int,
                   templates: Templates) -> dict | None:
    """A grip shape as it stands at a level: kept, cut to fewer strings, or gone."""
    if not any(info["start"] - 1e-6 <= t < info["end"] for e in members_level for t in (e.time, e.time + e.sustain)):
        return None
    if info["kind"] == "arpeggio" or is_arpeggio(members_full):
        return info
    allowed = _allowed_chord_notes(p, max_chord)
    frets = templates.list[info["chord_id"]].frets
    count = _note_count(templates.list[info["chord_id"]])
    if allowed <= 1:
        return None
    if allowed >= count:
        return info
    keep = kept_strings(frets, allowed)
    return {**info, "chord_id": templates.cut(info["chord_id"], keep),
            "frets": [f for s, f in enumerate(frets) if s in keep and f >= 0]}
