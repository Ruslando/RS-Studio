"""DLC Builder's arrangement checks, run on the SNG we are about to ship.

A port of Rocksmith2014.NET (MIT, see NOTICE) at commit 4cf3325:
src/Rocksmith2014.XML.Processing/Checkers/InstrumentalChecker.fs and its
Utils.fs, plus checkBassTuning from samples/DLCBuilder.Domain/Utils.fs. Issue
codes, titles and the "important" set match DLC Builder's, so a list from here
can be compared with what DLC Builder reports for the same psarc.
Help text uses short instructions based on ASD-STE100; checker logic is unchanged.

DLC Builder checks an imported psarc after SngToXml has turned it back into an
XML arrangement. `_view` does the same conversion on our SNG objects, with the
same millisecond rounding, so equality tests (a tone change *on* a note, an
anchor *at* a slide's end) come out as they do there.

Not ported, because the exporter cannot produce what they look for:
vocals (no lyrics) and showlights
(manifest.showlights always writes a fog and a beam note).
"""
from __future__ import annotations

import re
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
    id: str = ""

    def __post_init__(self):
        if not self.id:
            object.__setattr__(self, "id", self.code)

    @property
    def tone(self) -> str:
        # Keep DLC Builder's importance flag for compatibility; severity describes
        # our export: notes explain adaptations, warnings lose information, errors
        # may prevent a usable package or crash the game.
        if self.code in {"I18", "I21", "I25", "I30", "I36"}:
            return "error"
        if self.code == "hand":
            return "note"
        return "warning"

    def in_editor(self, lead: float) -> "Issue":
        """The same issue timed before `lead` seconds of leading silence."""
        return self if self.time is None else replace(self, time=round(self.time - lead, 3))

    def text(self) -> str:
        at = "" if self.time is None else f" at {_clock(self.time)}"
        return f"{self.id}{at}: {self.title}"


def _clock(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    return f"{ms // 60000}:{ms // 1000 % 60:02}.{ms % 1000:03}"


# code -> (title, help, important). Titles are DLC Builder's (i18n/en.json); the
# help says what to change in the editor rather than in EOF.
ISSUES = {
    'I01': ('An applause event is missing the event that ends it',
            'Add an Applause end event after Intro applause.', False),
    'I02': ('Unexpected event between intro applause events',
            'Move this crowd event before Intro applause or after Applause end.', False),
    'I03': ('Note linked to a chord',
            'Rocksmith cannot link a single note to a chord. Change the legato slide to a shift slide, or use a single target note.', False),
    'I04': ('Linked note missing its target',
            'This linked note has no next note on the same string. Add a target note. If it has a legato slide, remove the slide instead.', True),
    'I05': ('Linked slide ends on the wrong fret',
            'The slide ends on a different fret from the next linked note. Change the target note or the slide.', True),
    'I06': ('Linked notes on different frets',
            'Linked notes use different frets without a connecting slide. Use a legato slide between them, or set them to the same fret.', True),
    'I07': ('Linked bend mismatch',
            'Set the last bend value of the first note to the first bend value of the next note.', True),
    'I08': ('Linked note does not reach its target',
            'The linked note ends before its target starts. Extend it to the next note on the same string.', True),
    'I09': ('Unpitched slide with link',
            'An unpitched slide with a link can cause incorrect mastery scores. Remove the slide or change it to a shift slide.', True),
    'I10': ("Phrase changes on a linked note's sustain",
            'Move the phrase boundary outside the linked note. With difficulty levels, this boundary can hide a later note.', True),
    'I11': ('Note is both harmonic and pinch harmonic',
            'Select one harmonic type in the Harmonic menu.', False),
    'I13': ('7th fret harmonic with sustain',
            'Rocksmith cannot detect sustain on a natural harmonic at fret 7. Shorten the note or select Rocksmith > Not scored (Ignore).', False),
    'I14': ('Bend without a bend value',
            'All bend points have a value of zero. Move a bend point above zero, or remove Bend.', True),
    'I15': ('Tone change on a note',
            'Move the tone switch before the note so the tone is active when the note starts.', False),
    'I16': ('Note inside a noguitar section',
            'Move the note outside the No Guitar section, or change the section type.', False),
    'I18': ('Linked chord without linked chord notes',
            "Rocksmith can stop when a chord link has no linked chord notes. Check the chord's legato slide and note lengths.", True),
    'I20': ('Chord fingering does not match the hand position',
            "The hand position does not match this chord's fingering. Change the hand anchor or the finger positions.", False),
    'I27': ('Chord fingering looks wrong',
            'The finger numbers suggest that the fingers cross. Check the fingering and change it if needed.', False),
    'I28': ('Barre over open strings',
            'Change the fingering. An open string is between strings held by the same finger.', False),
    'I29': ('Muted string in a chord that is not muted',
            'Rocksmith cannot combine dead notes with pitched notes in one chord. Remove Dead / muted note, or enable it for every chord note.', True),
    'I21': ('Hand position changes inside a chord shape',
            'Move the hand position change outside the held chord shape. This change can cut off the shape or cause the game to stop.', True),
    'I22': ('Phrase boundary breaks a chord shape',
            'A phrase or section boundary changes the hand position inside a held chord shape. Move the boundary outside the shape.', True),
    'I23': ('Hand position change at the end of an unpitched slide',
            "Move the hand anchor away from the end of the unpitched slide. Rocksmith can fail to show a change at the slide's end.", False),
    'I25': ('The first phrase contains notes',
            'Rocksmith needs an empty first phrase. Increase Leading silence in the export settings, or move the first notes later.', True),
    'I26': ('Missing END phrase',
            'Rocksmith needs an END phrase after the playable notes. The export creates it automatically. If this message remains, report an export error.', False),
    'I30': ('More than 100 phrases',
            'The arrangement has more than 100 phrase occurrences. Remove unnecessary phrase or section markers. Too many phrases can hide difficulty bars or stop the game.', False),
    'I31': ('Hammer-on or pull-off on the same fret',
            "This hammer-on or pull-off starts on the previous note's fret or slide target. Change the fret or remove Hammer-on / pull-off.", False),
    'I32': ('Finger changes during a slide',
            'The hand positions imply different fingers at the start and end of this slide. Change the hand anchors or fingering to keep the same finger.', False),
    'I33': ('Position shift into a pull-off',
            'Move the hand anchor before or after the pull-off note.', False),
    'I34': ('Several bend values at the same time',
            'Move or remove overlapping bend points. Each bend point must have a different time.', True),
    'I35': ('Natural harmonic with bend',
            'This note has a natural harmonic and a bend. Remove Bend or select Pinch in the Harmonic menu.', False),
    'I37': ('Phrase mover on a note',
            'A mover1 phrase starts on a note. Rocksmith requires mover2 or a higher number here. The editor does not allow these reserved phrase names. Report this export error.', False),
    'I36': ('String not available on bass',
            'Move the note to one of the four bass strings.', True),
    'I38': ('Fret above 24',
            'Rocksmith cannot show frets above 24. Move the note to a lower fret, or reduce the capo if used.', False),
    'I39': ('Note after the song end',
            'This note starts at or after the END phrase or the end of the audio. Move it earlier or extend the playable song and its audio.', False),
    'I40': ('Technique on a note without sustain',
            'This note is too short to carry its vibrato, tremolo picking, or slide. Extend the note or remove the technique.', False),
    'I41': ('Low bass tuning without workaround',
            'This bass tuning needs the low-tuning workaround for note detection. The export normally applies it automatically. Check the layer tuning. If the tuning is correct, report this export error.', True),
    'I42': ('Bass tuning does not fit the tuning pitch',
            'The tuning reference is 220 Hz or lower, but a string offset is negative. Check the layer tuning and Concert pitch settings.', False),
}


# What the export changed on a note, so the issue cannot happen or the note can
# be exported at all: code -> (title, help).
# Shown where it happened, never important: the chart is still fine to ship.
FIXED = {
    'I29': ('Dead note removed from the chord',
            'The export leaves this dead note out because other chord notes are not muted. Enable Dead / muted note for every chord note to keep a fully muted chord.'),
    'slide': ('Slide removed: no valid target',
            'The export cannot find a valid target for this slide. Put the next note on the same string at a different fret above fret 0.'),
    'late-fx': ('Slide or vibrato starts with the note',
            'Rocksmith cannot start this effect partway through a bent note. The export starts the slide or vibrato at the beginning of the note.'),
    'grace': ('Grace note removed',
            'The export cannot place a lower note before this note. Check for an open string, the song start, or another note on the same string.'),
    'slide-in': ('Slide-in removed',
            'The slide-in overlaps another note, has no duration, or has no valid start fret. Shorten the slide-in, move the other note, or change the slide direction.'),
    'whammy': ('Whammy removed',
            'The whammy would leave frets 1 to 24, or this note has a bend. Change the whammy curve, move the note, or remove Bend.'),
    'whammy-slide': ('Whammy replaces the slide',
            'The export uses the final whammy slide and leaves out the separate slide out. Remove Whammy bar to keep the separate slide.'),
    'trill': ('Trill removed',
            'The note is too short for the trill, or its upper note is above fret 24. Extend the note or select a smaller trill interval.'),
    'ornament': ('Ornament removed',
            'The note is too short for the figure, or a figure note is outside frets 0 to 24. Extend the note, change its fret, or select another ornament.'),
    'slide-open': ('Slide removed from an open string',
            'An open string cannot slide. Use a fretted note to keep the slide.'),
    'fret': ('Note moved to fret 24',
            'The export limits this note to fret 24, which changes its pitch. Choose a position at fret 24 or below and check the capo.'),
    'unvoiced': ('Note removed: no string or fret',
            'The export leaves out this note because its string or fret is missing or invalid. Assign a valid string and fret position.'),
    'finger': ('Chord has no complete fingering',
            'Some fretted chord notes have no finger number. Assign the missing fingers, or select Rocksmith > No finger numbers (Fingerless).'),
    'hand': ('Export sets the hand position',
            'The export received no hand position for this note, so it sets one. Add a hand anchor to choose the position.'),
    'shape-grip': ('Shape removed: invalid grip',
            'The export writes plain notes because this shape cannot use one grip. Use at least two strings and only one fret on each string.'),
    'shape-mixed': ('Shape removed: another note is inside it',
            'A note outside this shape starts between its first and last notes. Add that note to the shape or move it outside the shape.'),
    'grip-only': ('Grip-only note removed',
            'A grip-only note needs an arpeggio or handshape that contains played notes. Add it to such a shape, or turn off Grip only (Ghost gem).'),
    'phrase-differs': ('Phrases with the same name have different notes',
            'Rocksmith gives phrases with the same name shared difficulty levels and scores. Make their notes match, or give this phrase a different name.'),
    'shape-hand': ('Hand position change removed inside a shape',
            'The export keeps the hand position from the start of this shape. Move the hand anchor outside the shape, or change the fingering.'),
}


def fixed(code: str, seconds: float) -> Issue:
    title, help_ = FIXED[code]
    return Issue(code, round(seconds, 3), title, help_, False,
                 "export.chord-dead-note-removed" if code == "I29" else f"export.{code}")


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
    events: list = field(default_factory=list)   # [(ms, code)]


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
            # DLC Builder's chords have chord notes exactly when they show the panel.
            # A repeat can keep chord notes for its techniques, as the Toolkit builds
            # it (chart._repeats), so those count too.
            if n.mask & S.CHORDPANEL or n.chord_notes_id != -1:
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
        events=[(_ms(t), code) for t, code in song.events],
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


CROWD_NAMES = {"e0": "Crowd slow", "e1": "Crowd normal", "e2": "Crowd fast",
               "E3": "Intro applause", "D3": "Outro applause", "E13": "Applause end"}


def _check_crowd_events(arr: _Arrangement) -> list:
    """InstrumentalChecker.checkCrowdEventPlacement: E3 needs an E13 after it, and
    no crowd event may sit between them. Both look at the first E3 and E13."""
    start = next((t for t, code in arr.events if code == "E3"), None)
    end = next((t for t, code in arr.events if code == "E13"), None)
    if start is None:
        return []
    if end is None:
        return [_issue("I01", start)]
    out = []
    for t, code in arr.events:
        if start < t < end and re.search(r"e[0-2]|E3|D3$", code):
            title, help_, important = ISSUES["I02"]
            name = CROWD_NAMES.get(code, code)   # the editor shows names, never codes
            out.append(Issue("I02", t / 1000, f"Unexpected event ({name}) between intro applause events",
                             help_, important))
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
    found += _check_crowd_events(arr)
    found += _check_phrases(arr)
    for level in arr.levels:
        for step in (_check_notes, _check_chords, _check_handshapes, _check_anchors):
            found += step(arr, level)
    unique = list(dict.fromkeys(found))
    general = [i for i in unique if i.time is None]
    timed = sorted((i for i in unique if i.time is not None), key=lambda i: i.time)
    # DLC Builder sorts general issues as time 0; a stable sort keeps them first.
    return general + timed
