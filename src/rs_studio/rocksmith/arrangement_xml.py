"""Rocksmith arrangement XML, as DLC Builder writes it when it imports a package.

A port of Rocksmith2014.NET's SNG-to-XML conversion (Conversion/SngToXml.fs and
ConvertInstrumental.sngToXml) and of the abridged XML its XML library saves
(Rocksmith2014.XML, InstrumentalArrangement.Save): the same elements, attributes,
order and number formats, so the arrangement files in RS Studio's project zip are
the ones DLC Builder's import of the package would produce.
"""
from __future__ import annotations

import struct

import numpy as np

from . import sng as S

# SNG note mask bits looked at when a note or chord becomes XML (SNG/Types/Masks.fs).
_NOTE_TECHNIQUES = (S.ACCENT | S.HAMMERON | S.HARMONIC | S.IGNORE | S.MUTE | S.PALMMUTE | S.PARENT
                    | S.PINCHHARMONIC | S.PLUCK | S.PULLOFF | S.RIGHTHAND | S.SLAP | S.TREMOLO)
_CHORD_TECHNIQUES = S.ACCENT | S.FRETHANDMUTE | S.HIGHDENSITY | S.IGNORE | S.PALMMUTE | S.PARENT
_CHORD_MASK_NOP = 0x02
_ARRANGEMENT_PROPERTIES = (
    "represent", "bonusArr", "standardTuning", "nonStandardChords", "barreChords", "powerChords",
    "dropDPower", "openChords", "fingerPicking", "pickDirection", "doubleStops", "palmMutes",
    "harmonics", "pinchHarmonics", "hopo", "tremolo", "slides", "unpitchedSlides", "bends",
    "tapping", "vibrato", "fretHandMutes", "slapPop", "twoFingerPicking", "fifthsAndOctaves",
    "syncopation", "bassPick", "sustain", "pathLead", "pathRhythm", "pathBass")


def _f32(value: float) -> float:
    """The value as the SNG stores it (float32): DLC Builder converts what it reads back."""
    return struct.unpack("<f", struct.pack("<f", float(value)))[0]


def _ms(seconds: float) -> int:
    """Utils.secToMs: float32 seconds to whole milliseconds, ties to even like Math.Round."""
    return int(round(_f32(seconds) * 1000.0))


def _time(ms: int) -> str:
    """Utils.TimeCodeToString: milliseconds as seconds with three decimals, by digits."""
    s = str(ms)
    if len(s) <= 3:
        return "0." + s.rjust(3, "0")
    return s[:-3] + "." + s[-3:]


def _float(value: float) -> str:
    """A float32 as .NET's float.ToString() writes it: the shortest text that reads back."""
    return np.format_float_positional(np.float32(value), trim="-")


def _escape(text: str, attribute: bool) -> str:
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if attribute:
        text = text.replace('"', "&quot;").replace("\t", "&#x9;").replace("\n", "&#xA;").replace("\r", "&#xD;")
    return text


class _Writer:
    """XmlWriter with Indent = true: two spaces, CRLF, `<a b="c" />` for an empty element."""

    def __init__(self):
        self.lines = ['<?xml version="1.0" encoding="utf-8"?>']
        self.depth = 0

    def _attrs(self, attrs) -> str:
        return "".join(f' {key}="{_escape(str(value), True)}"' for key, value in attrs)

    def empty(self, name: str, attrs=()) -> None:
        self.lines.append("  " * self.depth + f"<{name}{self._attrs(attrs)} />")

    def text(self, name: str, value) -> None:
        if value is None or value == "":
            self.empty(name)
        else:
            self.lines.append("  " * self.depth + f"<{name}>{_escape(str(value), False)}</{name}>")

    def open(self, name: str, attrs=()) -> None:
        self.lines.append("  " * self.depth + f"<{name}{self._attrs(attrs)}>")
        self.depth += 1

    def close(self, name: str) -> None:
        self.depth -= 1
        self.lines.append("  " * self.depth + f"</{name}>")

    def element(self, name: str, attrs, children=None) -> None:
        """An element whose children are written by `children(writer)`, if it has any."""
        if children is None:
            self.empty(name, attrs)
        else:
            self.open(name, attrs)
            children(self)
            self.close(name)

    def counted(self, name: str, item: str, values, attrs_of, children_of=lambda _: None) -> None:
        """Utils.SerializeWithCount: `<name count="n">` around one `<item>` per value."""
        values = list(values)
        if not values:
            self.empty(name, [("count", 0)])
            return
        self.open(name, [("count", len(values))])
        for value in values:
            self.element(item, attrs_of(value), children_of(value))
        self.close(name)

    def bytes(self) -> bytes:
        return "\r\n".join(self.lines).encode("utf-8")


def _bend_values(values) -> list:
    return [(_ms(bv.time), _f32(bv.step)) for bv in values]


def _bend_attrs(value) -> list:
    time, step = value
    return [("time", _time(time))] + ([("step", f"{step:.3f}")] if step != 0 else [])


def _note_attrs(n: dict) -> list:
    """Note.WriteXml, abridged: only what differs from the default is written."""
    mask = n["mask"]
    out = [("time", _time(n["time"])), ("string", n["string"]), ("fret", n["fret"])]
    if n["sustain"] > 0:
        out.append(("sustain", _time(n["sustain"])))
    if mask & S.PARENT:
        out.append(("linkNext", 1))
    if mask & S.ACCENT:
        out.append(("accent", 1))
    if n["bends"]:
        out.append(("bend", _float(n["max_bend"])))
    if mask & S.HAMMERON:
        out.append(("hammerOn", 1))
    if mask & S.HARMONIC:
        out.append(("harmonic", 1))
    if mask & (S.HAMMERON | S.PULLOFF):
        out.append(("hopo", 1))
    if mask & S.IGNORE:
        out.append(("ignore", 1))
    if n["left_hand"] != -1:
        out.append(("leftHand", n["left_hand"]))
    if mask & S.MUTE:
        out.append(("mute", 1))
    if mask & S.PALMMUTE:
        out.append(("palmMute", 1))
    if mask & S.PLUCK:
        out.append(("pluck", 1))
    if mask & S.PULLOFF:
        out.append(("pullOff", 1))
    if mask & S.SLAP:
        out.append(("slap", 1))
    if n["slide_to"] != -1:
        out.append(("slideTo", n["slide_to"]))
    if mask & S.TREMOLO:
        out.append(("tremolo", 1))
    if mask & S.PINCHHARMONIC:
        out.append(("harmonicPinch", 1))
    if n["pick_direction"]:
        out.append(("pickDirection", 1))
    if mask & S.RIGHTHAND:
        out.append(("rightHand", 1))
    if n["slide_unpitch_to"] != -1:
        out.append(("slideUnpitchTo", n["slide_unpitch_to"]))
    if n["tap"] != 0:
        out.append(("tap", n["tap"]))
    if n["vibrato"] != 0:
        out.append(("vibrato", n["vibrato"]))
    return out


def _note_children(n: dict):
    if not n["bends"]:
        return None
    return lambda w: w.counted("bendValues", "bendValue", n["bends"], _bend_attrs)


def _note(note: S.Note) -> dict:
    """SngToXml.convertNote."""
    return {
        # Only the technique bits become XML flags; the pick direction is its own field.
        "mask": note.mask & _NOTE_TECHNIQUES,
        "pick_direction": note.pick_direction > 0,
        "time": _ms(note.time), "string": note.string, "fret": note.fret, "sustain": _ms(note.sustain),
        "vibrato": note.vibrato & 0xFF, "slide_to": note.slide_to, "slide_unpitch_to": note.slide_unpitch_to,
        "left_hand": note.left_hand, "max_bend": _f32(note.max_bend), "bends": _bend_values(note.bend_values),
        "tap": max(0, note.tap),   # -1 in the SNG, 0 in the XML
    }


def _chord_notes(song: S.SNG, chord: S.Note) -> list[dict]:
    """SngToXml.createChordNotes: a note per fretted string of the template."""
    template = song.chords[chord.chord_id]
    extra = song.chord_notes[chord.chord_notes_id] if 0 <= chord.chord_notes_id < len(song.chord_notes) else None
    out = []
    for i in range(6):
        if template.frets[i] == -1:
            continue
        n = {"mask": 0, "pick_direction": False, "time": _ms(chord.time), "string": i,
             "fret": template.frets[i], "sustain": _ms(chord.sustain), "vibrato": 0, "slide_to": -1,
             "slide_unpitch_to": -1, "left_hand": template.fingers[i], "max_bend": 0.0, "bends": [], "tap": 0}
        if extra is not None:
            # The chord note's own bend never gets a maximum: DLC Builder writes bend="0".
            n.update(mask=extra.mask[i] & _NOTE_TECHNIQUES, slide_to=extra.slide_to[i],
                     slide_unpitch_to=extra.slide_unpitch_to[i], vibrato=extra.vibrato[i] & 0xFF,
                     bends=_bend_values(extra.bend_data[i]))
        out.append(n)
    return out


def _chord(song: S.SNG, chord: S.Note):
    """SngToXml.convertChord: attributes and, for a chord with a panel, its chord notes."""
    mask = chord.mask & _CHORD_TECHNIQUES
    attrs = [("time", _time(_ms(chord.time))), ("chordId", chord.chord_id)]
    for flag, name in ((S.PARENT, "linkNext"), (S.ACCENT, "accent"), (S.FRETHANDMUTE, "fretHandMute"),
                       (S.HIGHDENSITY, "highDensity"), (S.IGNORE, "ignore"), (S.PALMMUTE, "palmMute")):
        if mask & flag:
            attrs.append((name, 1))
    notes = _chord_notes(song, chord) if chord.mask & S.CHORDPANEL else []
    children = None
    if notes:
        def children(w):
            for n in notes:
                w.element("chordNote", _note_attrs(n), _note_children(n))
    return attrs, children


def _level(song: S.SNG, level: S.Level):
    def write(w: _Writer) -> None:
        notes = [n for n in level.notes if n.chord_id == -1]
        chords = [n for n in level.notes if n.chord_id != -1]
        w.counted("notes", "note", [_note(n) for n in notes], _note_attrs, _note_children)
        built = [_chord(song, c) for c in chords]
        w.counted("chords", "chord", built, lambda c: c[0], lambda c: c[1])
        w.counted("anchors", "anchor", level.anchors, lambda a: [
            ("time", _time(_ms(a.start_time))), ("fret", a.fret), ("width", f"{a.width:.3f}")])
        # Handshapes and arpeggios are one list in the XML, by start time.
        shapes = sorted(level.handshapes + level.arpeggios, key=lambda fp: _ms(fp.start_time))
        w.counted("handShapes", "handShape", shapes, lambda fp: [
            ("chordId", fp.chord_id), ("startTime", _time(_ms(fp.start_time))),
            ("endTime", _time(_ms(fp.end_time)))])
    return write


def arrangement_xml(song: S.SNG, attrs: dict) -> bytes:
    """The arrangement XML for one SNG and its manifest attributes."""
    w = _Writer()
    beats = [(_ms(b.time), b.measure if b.mask & 1 else -1) for b in song.beats]
    start_beat = beats[0][0] if beats else 0
    tone_names = [attrs.get(f"Tone_{slot}") or "" for slot in "ABCD"]
    props = attrs.get("ArrangementProperties") or {}
    meta = song.metadata

    w.open("song", [("version", 8)])
    w.text("title", attrs.get("SongName"))
    w.text("arrangement", attrs.get("ArrangementName"))
    w.text("part", meta.part)
    w.text("offset", f"{start_beat / -1000:.3f}")
    w.text("centOffset", _float(attrs.get("CentOffset") or 0))
    w.text("songLength", _time(_ms(meta.song_length)))
    if attrs.get("SongNameSort") is not None:
        w.text("songNameSort", attrs["SongNameSort"])
    w.text("startBeat", _time(start_beat))
    w.text("averageTempo", f"{_f32(attrs.get('SongAverageTempo') or 0):.3f}")
    w.empty("tuning", [(f"string{i}", meta.tuning[i]) for i in range(6)])
    w.text("capo", max(meta.capo_fret_id, 0))
    w.text("artistName", attrs.get("ArtistName"))
    if attrs.get("ArtistNameSort") is not None:
        w.text("artistNameSort", attrs["ArtistNameSort"])
    w.text("albumName", attrs.get("AlbumName"))
    if attrs.get("AlbumNameSort") is not None:
        w.text("albumNameSort", attrs["AlbumNameSort"])
    w.text("albumYear", int(attrs.get("SongYear") or 0))
    w.text("crowdSpeed", "1")
    w.empty("arrangementProperties", [(key, 1 if props.get(key) else 0) for key in _ARRANGEMENT_PROPERTIES])
    w.text("lastConversionDateTime", meta.last_conversion_date_time)

    w.counted("phrases", "phrase", song.phrases, lambda p: [("maxDifficulty", p.max_difficulty), ("name", p.name)]
              + [(name, 1) for name, on in (("disparity", p.disparity), ("ignore", p.ignore), ("solo", p.solo)) if on])

    def hero(pi):
        if not any(pi.difficulty):
            return None
        return lambda w: w.counted("heroLevels", "heroLevel", list(enumerate(pi.difficulty, 1)),
                                   lambda h: [("hero", h[0]), ("difficulty", h[1] & 0xFF)])
    # HeroLevels writes its own count of 3 whatever the values: counted() gives the same.
    w.counted("phraseIterations", "phraseIteration", song.phrase_iterations,
              lambda pi: [("time", _time(_ms(pi.start_time))), ("phraseId", pi.phrase_id)], hero)
    w.empty("newLinkedDiffs", [("count", 0)])        # RS Studio writes none (sng.serialize)
    w.empty("phraseProperties", [("count", 0)])      # nor phrase extra info
    w.counted("chordTemplates", "chordTemplate", song.chords, lambda c: [
        ("chordName", c.name),
        ("displayName", c.name + ("-arp" if c.mask == S.CHORD_MASK_ARPEGGIO else "-nop" if c.mask == _CHORD_MASK_NOP else "")),
        *[(f"finger{i}", c.fingers[i]) for i in range(6) if c.fingers[i] != -1],
        *[(f"fret{i}", c.frets[i]) for i in range(6) if c.frets[i] != -1]])
    w.counted("ebeats", "ebeat", beats, lambda b: [("time", _time(b[0]))] + ([("measure", b[1])] if b[1] != -1 else []))

    if attrs.get("Tone_Base"):
        w.text("tonebase", attrs["Tone_Base"])
    for slot, name in zip("abcd", tone_names):
        if name:
            w.text(f"tone{slot}", name)
    w.counted("tones", "tone", song.tones, lambda t: [
        ("time", _time(_ms(t[0]))), ("id", t[1]),
        ("name", tone_names[t[1]] if 0 <= t[1] < 4 and attrs is not None else "N/A")])
    w.counted("sections", "section", song.sections, lambda s: [
        ("name", s.name), ("number", s.number), ("startTime", _time(_ms(s.start_time)))])
    w.counted("events", "event", song.events, lambda e: [("time", _time(_ms(e[0]))), ("code", e[1])])
    w.element("transcriptionTrack", [("difficulty", -1)], lambda w: (
        w.empty("notes", [("count", 0)]), w.empty("chords", [("count", 0)]),
        w.empty("anchors", [("count", 0)]), w.empty("handShapes", [("count", 0)])))
    w.counted("levels", "level", song.levels, lambda lv: [("difficulty", lv.difficulty)], lambda lv: _level(song, lv))
    w.close("song")
    return w.bytes()
