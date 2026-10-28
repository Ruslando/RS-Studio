"""DLC Builder's arrangement checks, run on the SNG we are about to ship.

A port of Rocksmith2014.NET (MIT, see NOTICE) at commit 4cf3325:
src/Rocksmith2014.XML.Processing/Checkers/InstrumentalChecker.fs and its
Utils.fs, plus checkBassTuning from samples/DLCBuilder.Domain/Utils.fs. Issue
codes, titles and the "important" set match DLC Builder's, so a list from here
can be compared line by line with what DLC Builder reports for the same psarc.

DLC Builder checks an imported psarc after SngToXml has turned it back into an
XML arrangement. `_view` does the same conversion on our SNG objects, with the
same millisecond rounding, so equality tests (a tone change *on* a note, an
anchor *at* a slide's end) come out as they do there.

Not ported, because the exporter cannot produce what they look for:
crowd-event placement (we write no events), vocals (no lyrics) and showlights
(manifest.showlights always writes a fog and a beam note).
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field, replace

from . import sng as S


@dataclass(frozen=True)
class Issue:
    code: str
    time: float | None   # seconds; None for an issue with the whole arrangement
    title: str
    help: str
    important: bool

    def in_editor(self, lead: float) -> "Issue":
        """The same issue timed before `lead` seconds of leading silence."""
        return self if self.time is None else replace(self, time=round(self.time - lead, 3))

    def text(self) -> str:
        at = "" if self.time is None else f" at {_clock(self.time)}"
        return f"{self.code}{at}: {self.title}"


def _clock(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    return f"{ms // 60000}:{ms // 1000 % 60:02}.{ms % 1000:03}"


# code -> (title, help, important). Titles are DLC Builder's (i18n/en.json); the
# help says what to change in the editor rather than in EOF.
ISSUES = {
    "I03": ("Note linked to a chord",
            "A legato slide ends on a chord. Rocksmith can only link a note to another single note.", False),
    "I04": ("Linked note missing its target",
            "A legato note has no following note on the same string.", True),
    "I05": ("Linked slide ends on the wrong fret",
            "The note after a legato slide is not on the fret the slide goes to.", True),
    "I06": ("Linked notes on different frets",
            "Two linked notes on the same string use different frets.", True),
    "I07": ("Linked bend mismatch",
            "The bend a note ends with does not match the first bend value of the note it is linked to.", True),
    "I08": ("Linked note does not reach its target",
            "The next note on the same string does not start where the linked note's sustain ends.", True),
    "I09": ("Unpitched slide with link",
            "A link on an unpitched slide causes mastery issues in Rocksmith 2014 Remastered.", True),
    "I10": ("Phrase changes on a linked note's sustain",
            "This can make a later note on the same string invisible when the arrangement has DD levels.", True),
    "I11": ("Note is both harmonic and pinch harmonic", "Pick one harmonic type.", False),
    "I13": ("7th fret harmonic with sustain",
            "The game does not detect a sustained 7th fret harmonic. Shorten the note or mark it ignored.", False),
    "I14": ("Bend without a bend value", "The note is set as a bend but every bend value is zero.", True),
    "I15": ("Tone change on a note",
            "Place a tone change slightly before a note rather than exactly on it.", False),
    "I16": ("Note inside a noguitar section", "A note or chord sits inside a section of type No Guitar.", False),
    "I18": ("Linked chord without linked chord notes",
            "The chord is linked but none of its notes are. Such a chord can crash the game.", True),
    "I20": ("Chord fingering does not match the hand position",
            "The hand position is on the lowest fret of a chord that does not use the first finger.", False),
    "I27": ("Chord fingering looks wrong",
            "The fingering needs the fingers to cross in a way common chords do not.", False),
    "I28": ("Barre over open strings", "Open strings lie between strings fretted by the same finger.", False),
    "I29": ("Muted string in a chord that is not muted",
            "The game needs the pitch of every chord note. Remove the dead note or mute the whole chord.", True),
    "I21": ("Hand position changes inside a chord shape",
            "A hand position change inside a held chord can cut the shape off or crash the game.", True),
    "I22": ("Phrase boundary breaks a chord shape",
            "Repeated chords cross a phrase or section boundary.", True),
    "I23": ("Hand position change at the end of an unpitched slide",
            "A hand position change this close to an unpitched slide's end may not show in the game.", False),
    "I25": ("The first phrase contains notes",
            "Rocksmith needs an empty first phrase. Leave the first measure empty or add leading silence.", True),
    "I26": ("Missing END phrase", "The arrangement has no phrase called END.", False),
    "I30": ("More than 100 phrases",
            "DD bars will not show, and very many phrases can crash the game.", False),
    "I31": ("Hammer-on or pull-off on the same fret",
            "A hammer-on or pull-off uses the same fret as the previous note on that string.", False),
    "I32": ("Finger changes during a slide",
            "From the hand positions, the slide starts and ends on different fingers.", False),
    "I33": ("Position shift into a pull-off", "The hand position changes on a pull-off note.", False),
    "I34": ("Several bend values at the same time",
            "Two points of a bend curve sit at the same moment. Move or remove one.", True),
    "I35": ("Natural harmonic with bend", "The harmonic should probably be a pinch harmonic.", False),
    "I37": ("Phrase mover on a note", "A mover1 phrase starts on a note; the number should be at least 2.", False),
    "I36": ("String not available on bass", "Bass arrangements can only use four strings.", True),
    "I38": ("Fret above 24", "The game cannot display notes above the 24th fret.", False),
    "I39": ("Note after the song end", "A note or chord comes after the END phrase or the end of the audio.", False),
    "I40": ("Technique on a note without sustain",
            "Vibrato, tremolo and slides need sustain. Lengthen the note.", False),
    "I41": ("Low bass tuning without workaround",
            "The game does not detect notes in this low a bass tuning without the 220 Hz tuning workaround.", True),
    "I42": ("Bass tuning does not fit the tuning pitch",
            "With a 220 Hz tuning pitch the string offsets should all be positive.", False),
}


# What the export changed on a note, so the issue cannot happen or the note can
# be exported at all: code -> (title, help).
# Shown where it happened, never important: the chart is still fine to ship.
FIXED = {
    "I29": ("Dead note left out of the chord",
            "Rocksmith needs the pitch of every chord note, so the export leaves the dead note out. "
            "Mute every string of the chord to keep it."),
    "slide": ("Slide dropped: no target on its string",
              "A shift or legato slide moves along one string, but the next note is on another string or open. "
              "Put the target on the slide's string."),
    "late-fx": ("Late slide or vibrato covers the whole note",
                "The note is bent, and a bend cannot be cut, so Rocksmith plays the effect "
                "from the start of the note."),
    "grace": ("Grace note left out", "There is no room before its note on that string."),
    "slide-in": ("Slide-in left out",
                 "Rocksmith plays a slide-in as a short note before this one, sliding into it, but there is "
                 "no room for it on that string or no fret to start it from."),
    "slide-open": ("Slide dropped: open string", "An open string cannot slide. Fret the note to keep the slide."),
    "fret": ("Note moved down to fret 24", "Rocksmith has no frets above 24."),
    "unvoiced": ("Note skipped", "The note has no string or fret."),
    "finger": ("Chord without fingering", "Some fretted notes of this grip have no finger; Rocksmith shows them without one."),
    "hand": ("Hand position guessed", "The note has no hand position from the editor, so the export placed the hand."),
    "shape-grip": ("Arpeggio or handshape exported as plain notes",
                   "Its notes do not form one grip: a string is played on two frets, or only one string is used. "
                   "Put every note of a string on the same fret, or remove the shape."),
    "shape-mixed": ("Arpeggio or handshape exported as plain notes",
                    "A note outside the shape is played while the shape is held. Every note between its first "
                    "and last note belongs to it: add that note to the shape, or move it out."),
    "shape-hand": ("Hand position change inside an arpeggio or handshape",
                   "The hand holds the grip for the whole shape, so the export keeps it where the shape begins "
                   "and ignores this change. Move the hand anchor before or after the shape, or change the fingering."),
}


def fixed(code: str, seconds: float) -> Issue:
    title, help_ = FIXED[code]
    return Issue(code, round(seconds, 3), title, help_, False)


def _issue(code: str, ms: int | None) -> Issue:
    title, help_, important = ISSUES[code]
    return Issue(code, None if ms is None else ms / 1000, title, help_, important)


# ---- the XML view DLC Builder checks (SngToXml.fs) ---------------------------

def _ms(seconds: float) -> int:
    """SngToXml's secToMs: the time as stored (float32), rounded half to even."""
    return int(round(struct.unpack("<f", struct.pack("<f", seconds))[0] * 1000.0))


@dataclass(eq=False)
class _Note:
    time: int
    string: int
    fret: int
    sustain: int = 0
    mask: int = 0
    vibrato: int = 0
    slide_to: int = -1
    unpitch_to: int = -1
    bends: list = field(default_factory=list)   # [(ms, step)]

    def has(self, flag: int) -> bool:
        return bool(self.mask & flag)

    link_next = property(lambda self: self.has(S.PARENT))
    harmonic = property(lambda self: self.has(S.HARMONIC))
    pinch = property(lambda self: self.has(S.PINCHHARMONIC))
    ignore = property(lambda self: self.has(S.IGNORE))
    fret_hand_mute = property(lambda self: self.has(S.MUTE))
    tremolo = property(lambda self: self.has(S.TREMOLO))
    pull_off = property(lambda self: self.has(S.PULLOFF))
    hopo = property(lambda self: self.has(S.HAMMERON) or self.has(S.PULLOFF))
    is_bend = property(lambda self: bool(self.bends))
    is_slide = property(lambda self: self.slide_to != -1)
    is_unpitched = property(lambda self: self.unpitch_to != -1)
    is_vibrato = property(lambda self: self.vibrato != 0)


@dataclass(eq=False)
class _Chord:
    time: int
    chord_id: int
    mask: int
    notes: list   # [_Note]; empty when the SNG chord has no chord panel

    link_next = property(lambda self: bool(self.mask & S.PARENT))
    ignore = property(lambda self: bool(self.mask & S.IGNORE))
    high_density = property(lambda self: bool(self.mask & S.HIGHDENSITY))
    fret_hand_mute = property(lambda self: bool(self.mask & S.FRETHANDMUTE))


@dataclass(eq=False)
class _Anchor:
    time: int
    fret: int
    width: int


@dataclass
class _Level:
    notes: list
    chords: list
    anchors: list
    handshapes: list   # [(chord_id, start, end)], fingerprints and arpeggios by start


@dataclass
class _Arrangement:
    phrases: list            # names
    iterations: list         # [(time, phrase_id)]
    sections: list           # [(name, time)]
    tone_times: set
    templates: list          # S.ChordTemplate
    song_length: int
    is_bass: bool
    levels: list


def _bends(values) -> list:
    return [(_ms(b.time), b.step) for b in values]


def _view(song: S.SNG, is_bass: bool) -> _Arrangement:
    levels = []
    for level in song.levels:
        notes, chords = [], []
        for n in level.notes:
            if not n.mask & S.CHORD:
                notes.append(_Note(_ms(n.time), n.string, n.fret, _ms(n.sustain), n.mask, n.vibrato,
                                   n.slide_to, n.slide_unpitch_to, _bends(n.bend_values)))
                continue
            chord_notes = []
            if n.mask & S.CHORDPANEL:
                template = song.chords[n.chord_id]
                cn = (song.chord_notes[n.chord_notes_id]
                      if 0 <= n.chord_notes_id < len(song.chord_notes) else None)
                for s in range(6):
                    if template.frets[s] == -1:
                        continue
                    note = _Note(_ms(n.time), s, template.frets[s], _ms(n.sustain))
                    if cn is not None:
                        note.mask, note.vibrato = cn.mask[s], cn.vibrato[s]
                        note.slide_to, note.unpitch_to = cn.slide_to[s], cn.slide_unpitch_to[s]
                        note.bends = _bends(cn.bend_data[s])
                    chord_notes.append(note)
            chords.append(_Chord(_ms(n.time), n.chord_id, n.mask, chord_notes))
        handshapes = sorted(((fp.chord_id, _ms(fp.start_time), _ms(fp.end_time))
                             for fp in [*level.handshapes, *level.arpeggios]), key=lambda h: h[1])
        levels.append(_Level(notes, chords,
                             [_Anchor(_ms(a.start_time), a.fret, a.width) for a in level.anchors],
                             handshapes))
    return _Arrangement(
        phrases=[p.name for p in song.phrases],
        iterations=[(_ms(pi.start_time), pi.phrase_id) for pi in song.phrase_iterations],
        sections=[(s.name, _ms(s.start_time)) for s in song.sections],
        tone_times={_ms(t) for t, _ in song.tones},
        templates=song.chords,
        song_length=_ms(song.metadata.song_length),
        is_bass=is_bass,
        levels=levels,
    )


# ---- Utils.fs ----------------------------------------------------------------

def _find_by_time(items: list, time: int):
    for item in items:
        if item.time == time:
            return item
        if item.time > time:
            return None
    return None


def _active_anchor(level: _Level, time: int):
    """tryFindActiveAnchor: the anchor in force at `time` (the first one if none yet)."""
    anchors = level.anchors
    if not anchors:
        return None
    index = 0
    while index < len(anchors) and anchors[index].time <= time:
        index += 1
    return anchors[max(0, index - 1)]


def _last_anchor_at_or_before(anchors: list, time: int):
    return next((a for a in reversed(anchors) if a.time <= time), None)


def _previous_note_on_same_string(notes: list, index: int):
    """(previous note on the string or None, whether other strings sound in between)."""
    start = notes[index]
    between = False
    for n in reversed(notes[:index]):
        if n.time == start.time:
            continue
        if n.string != start.string:
            between = True
            continue
        return n, between
    return None, between


def _fret_or_slide_end(n: _Note) -> int:
    if n.is_slide:
        return n.slide_to
    if n.is_unpitched:
        return n.unpitch_to
    return n.fret


def _previous_chord_using_string(arr: _Arrangement, chords: list, string: int, time: int):
    for chord in reversed(chords):
        if chord.time >= time:
            continue
        template = arr.templates[chord.chord_id] if 0 <= chord.chord_id < len(arr.templates) else None
        if template is None or template.frets[string] <= -1:
            continue
        fret = next((_fret_or_slide_end(cn) for cn in chord.notes if cn.string == string),
                    template.frets[string])
        return chord, fret
    return None


def _next_note_on_same_string(notes: list, index: int, note: _Note):
    if index == -1:
        return next((n for n in notes if n.time > note.time and n.string == note.string), None)
    return next((n for n in notes[index + 1:] if n.string == note.string), None)


# ---- InstrumentalChecker.fs ------------------------------------------------------

def _noguitar_sections(arr: _Arrangement) -> list:
    out = []
    for i, (name, start) in enumerate(arr.sections):
        end = arr.sections[i + 1][1] if i + 1 < len(arr.sections) else arr.song_length
        if name.startswith("noguitar"):
            out.append((start, end))
    return out


def _end_time(arr: _Arrangement) -> int:
    if arr.iterations:
        time, phrase_id = arr.iterations[-1]
        if arr.phrases[phrase_id].lower() == "end":
            return time
    return arr.song_length


def _in_noguitar(sections: list, time: int) -> bool:
    return any(start <= time < end for start, end in sections)


def _check_link_next(level: _Level, index: int, note: _Note):
    end = note.time + note.sustain
    if any(c.time == end and c.notes and any(cn.string == note.string for cn in c.notes)
           for c in level.chords):
        return _issue("I03", note.time)
    target = _next_note_on_same_string(level.notes, index, note)
    if target is None:
        return _issue("I04", note.time)
    if target.time - end > 1:
        return _issue("I08", note.time)
    if note.fret != target.fret:
        slide_to = note.slide_to if note.slide_to != -1 else note.unpitch_to
        if slide_to == target.fret:
            return None
        if slide_to != -1:
            return _issue("I05", note.time)
        return _issue("I06", target.time)
    if note.is_bend:
        last = note.bends[-1][1]
        first = target.bends[0][1] if target.is_bend and target.time == target.bends[0][0] else 0.0
        if last != first:
            return _issue("I07", target.time)
    return None


def _phrase_change_on_sustain(arr: _Arrangement, note: _Note) -> bool:
    return any(note.time < time <= note.time + note.sustain
               and not arr.phrases[phrase_id].startswith("mover")
               for time, phrase_id in arr.iterations)


def _overlapping_bend(bends: list):
    for a, b in zip(bends, bends[1:]):
        if a[0] == b[0]:
            return _issue("I34", b[0])
    return None


def _needs_sustain(n: _Note) -> bool:
    return n.sustain < 5 and (n.tremolo or n.is_vibrato or n.is_slide or n.is_unpitched)


def _check_notes(arr: _Arrangement, level: _Level) -> list:
    ng = _noguitar_sections(arr)
    end_time = _end_time(arr)
    out = []
    for i, note in enumerate(level.notes):
        time = note.time
        previous, others_between = _previous_note_on_same_string(level.notes, i)
        anchor_here = _find_by_time(level.anchors, time)

        if note.link_next and note.is_unpitched:
            out.append(_issue("I09", time))
        if note.link_next and _phrase_change_on_sustain(arr, note):
            out.append(_issue("I10", time))
        if note.harmonic and note.pinch:
            out.append(_issue("I11", time))
        if not note.ignore and note.fret == 7 and note.harmonic and note.sustain > 0:
            out.append(_issue("I13", time))
        if note.is_bend:
            if note.harmonic:
                out.append(_issue("I35", time))
            if all(step == 0.0 for _, step in note.bends):
                out.append(_issue("I14", time))
            overlap = _overlapping_bend(note.bends)
            if overlap:
                out.append(overlap)
        if time in arr.tone_times:
            out.append(_issue("I15", time))
        if note.link_next:
            linked = _check_link_next(level, i, note)
            if linked:
                out.append(linked)
        if _in_noguitar(ng, time):
            out.append(_issue("I16", time))

        if note.hopo and not others_between:
            chord_before = _previous_chord_using_string(arr, level.chords, note.string, time)
            if previous is None:
                if chord_before is not None and chord_before[1] == note.fret:
                    out.append(_issue("I31", time))
            elif chord_before is not None and chord_before[0].time > previous.time:
                if chord_before[1] == note.fret:
                    out.append(_issue("I31", time))
            elif _fret_or_slide_end(previous) == note.fret:
                out.append(_issue("I31", time))

        if note.is_slide:
            slide_anchor = _find_by_time(level.anchors, time + note.sustain)
            active = _active_anchor(level, time) if slide_anchor is not None else None
            if active is not None:
                slide_end = note.slide_to
                undetermined = (slide_anchor.width != active.width and slide_anchor.width > 4
                                and slide_end != slide_anchor.fret + slide_anchor.width)
                if not undetermined:
                    def finger(anchor, fret):
                        return min(4, max(1, 1 + fret - (anchor.width - 4)))
                    start_finger = finger(active, note.fret - active.fret)
                    end_finger = finger(slide_anchor, slide_end - slide_anchor.fret)
                    from_low = active.fret == 1 and active.fret - end_finger < 0
                    if not from_low and start_finger != end_finger:
                        out.append(_issue("I32", time))

        if anchor_here is not None:
            before = _active_anchor(level, time - 10)
            if before is not None and before is not anchor_here and note.pull_off and note.fret > 0:
                out.append(_issue("I33", time))
        if arr.is_bass and note.string >= 4:
            out.append(_issue("I36", time))
        if note.fret > 24:
            out.append(_issue("I38", time))
        if time >= end_time:
            out.append(_issue("I39", time))
        if _needs_sustain(note):
            out.append(_issue("I40", time))
    return out


def _strange_fingering(arr: _Arrangement, chord: _Chord) -> bool:
    if not 0 <= chord.chord_id < len(arr.templates):
        return False
    template = arr.templates[chord.chord_id]
    fingers, frets = list(template.fingers), list(template.frets)
    lowest = next((f for f in sorted(fingers) if f > 0), None)
    if lowest is None:
        return False
    fretted = [fret for i, fret in enumerate(frets) if not (i < len(fingers) and fingers[i] == 0) and fret > 0]
    lowest_fret = frets[fingers.index(lowest)]
    return any(fret < lowest_fret for fret in fretted)


def _barre_over_open_strings(arr: _Arrangement, chord: _Chord) -> bool:
    if not 0 <= chord.chord_id < len(arr.templates):
        return False
    template = arr.templates[chord.chord_id]
    fingers, frets = list(template.fingers), list(template.frets)
    for finger in range(5):
        if finger not in fingers:
            continue
        low = fingers.index(finger)
        high = len(fingers) - 1 - fingers[::-1].index(finger)
        if high > low and 0 in frets[low:high]:
            return True
    return False


def _muted_string(chord: _Chord) -> bool:
    return (not chord.fret_hand_mute and any(n.fret_hand_mute for n in chord.notes)
            and not all(n.fret_hand_mute for n in chord.notes))


def _check_chords(arr: _Arrangement, level: _Level) -> list:
    ng = _noguitar_sections(arr)
    end_time = _end_time(arr)
    out = []
    for chord in level.chords:
        time = chord.time
        notes = chord.notes
        if notes:
            if not chord.ignore and any(n.sustain > 0 and n.fret == 7 and n.harmonic for n in notes):
                out.append(_issue("I13", time))
            if any(n.link_next and n.is_unpitched for n in notes):
                out.append(_issue("I09", time))
            if any(n.harmonic and n.pinch for n in notes):
                out.append(_issue("I11", time))
            if any(n.is_bend and all(step == 0.0 for _, step in n.bends) for n in notes):
                out.append(_issue("I14", time))
            if any(_needs_sustain(n) for n in notes):
                out.append(_issue("I40", time))
            overlap = next((o for n in notes if n.is_bend for o in [_overlapping_bend(n.bends)] if o), None)
            if overlap:
                out.append(overlap)
            for n in notes:
                if n.link_next:
                    linked = _check_link_next(level, -1, n)
                    if linked:
                        out.append(linked)
            anchor_here = _find_by_time(level.anchors, time)
            if anchor_here is not None:
                before = _active_anchor(level, time - 10)
                if (before is not None and before is not anchor_here
                        and any(n.pull_off and n.fret > 0 for n in notes)):
                    out.append(_issue("I33", time))
            if arr.is_bass and any(n.string >= 4 for n in notes):
                out.append(_issue("I36", time))
        if chord.link_next and not any(n.link_next for n in notes):
            out.append(_issue("I18", time))
        if time in arr.tone_times:
            out.append(_issue("I15", time))
        if notes and not chord.high_density:
            if _strange_fingering(arr, chord):
                out.append(_issue("I27", time))
            if _barre_over_open_strings(arr, chord):
                out.append(_issue("I28", time))
            if _muted_string(chord):
                out.append(_issue("I29", time))
        if _in_noguitar(ng, time):
            out.append(_issue("I16", time))
        if time >= end_time:
            out.append(_issue("I39", time))
    return out


def _check_handshapes(arr: _Arrangement, level: _Level) -> list:
    anchors = level.anchors

    def same_anchor_with_first_finger(neighbour, active) -> bool:
        if neighbour is None:
            return False
        chord_id, start, _ = neighbour
        return 1 in arr.templates[chord_id].fingers and _last_anchor_at_or_before(anchors, start) is active

    out = []
    shapes = level.handshapes
    for i, (chord_id, start, _) in enumerate(shapes):
        active = _last_anchor_at_or_before(anchors, start)
        template = arr.templates[chord_id]
        if any(f in (0, 1) for f in template.fingers) or active is None:
            continue
        wrong = any(fret == active.fret and finger != -1
                    for fret, finger in zip(template.frets, template.fingers))
        previous = shapes[i - 1] if i > 0 else None
        following = shapes[i + 1] if i + 1 < len(shapes) else None
        if wrong and not (same_anchor_with_first_finger(previous, active)
                          or same_anchor_with_first_finger(following, active)):
            out.append(_issue("I20", start))
    return out


def _check_anchors(arr: _Arrangement, level: _Level) -> list:
    mover_times = [time for time, phrase_id in arr.iterations if arr.phrases[phrase_id].startswith("mover")]

    def at_mover(time: int) -> bool:
        return any(abs(t - time) <= 1 for t in mover_times)

    boundaries = {time for time, _ in arr.iterations} | {time for _, time in arr.sections}
    slide_ends = [n.time + n.sustain for n in level.notes if n.is_unpitched]
    out = [_issue("I23", a.time) for a in level.anchors
           if any(abs(a.time - end) < 4 for end in slide_ends) and not at_mover(a.time)]
    for a in level.anchors:
        if any(start < a.time < end for _, start, end in level.handshapes) and not at_mover(a.time):
            out.append(_issue("I22" if a.time in boundaries else "I21", a.time))
    return out


def _check_phrases(arr: _Arrangement) -> list:
    if len(arr.iterations) < 2:
        return []
    out = []
    level = arr.levels[0] if arr.levels else None
    if level is not None:
        firsts = [items[0].time for items in (level.notes, level.chords) if items]
        if firsts and min(firsts) < arr.iterations[1][0]:
            out.append(_issue("I25", min(firsts)))
    if not any(name.lower() == "end" for name in arr.phrases):
        out.append(_issue("I26", None))
    if len(arr.iterations) > 100:
        out.append(_issue("I30", None))
    if level is not None:
        times = {n.time for n in level.notes} | {c.time for c in level.chords}
        out += [_issue("I37", time) for time, phrase_id in arr.iterations
                if arr.phrases[phrase_id].lower() == "mover1" and time in times]
    return out


def check_bass_tuning(tuning: list, cent_offset: float) -> list:
    """checkBassTuning: tuning offsets per string, cent offset from 440 Hz."""
    pitch = 440.0 * 2 ** (cent_offset / 1200.0)
    out = []
    if pitch > 230.0 and any(t < -4 for t in tuning):
        out.append(_issue("I41", None))
    if pitch <= 220.0 and any(t < 0 for t in tuning):
        out.append(_issue("I42", None))
    return out


def check(song: S.SNG, *, is_bass: bool, cent_offset: float = 0.0) -> list[Issue]:
    """Every issue DLC Builder would report for this arrangement, in its order."""
    arr = _view(song, is_bass)
    found = check_bass_tuning(list(song.metadata.tuning), cent_offset) if is_bass else []
    found += _check_phrases(arr)
    for level in arr.levels:
        for step in (_check_notes, _check_chords, _check_handshapes, _check_anchors):
            found += step(arr, level)
    unique = list(dict.fromkeys(found))
    general = [i for i in unique if i.time is None]
    timed = sorted((i for i in unique if i.time is not None), key=lambda i: i.time)
    # DLC Builder sorts general issues as time 0; a stable sort keeps them first.
    return general + timed
