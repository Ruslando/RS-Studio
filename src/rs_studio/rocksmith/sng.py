"""SNG 2014 binary writer + encryption (PC platform, little-endian).

Field layout transcribed from Rocksmith2014.NET (src/Rocksmith2014.SNG/Types).
The packed file is: magic 0x4A, header 3, IV[16], AES-CTR(int32 plainLength +
zlib(payload)), then 56 unused zero bytes.
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

SNG_KEY_PC = bytes.fromhex("CB648DF3D12A16BF71701414E69619EC171CCA5D2A142E3E59DE7ADDA18A3A30")

# NoteMask flags
CHORD = 0x02
OPEN = 0x04
FRETHANDMUTE = 0x08
TREMOLO = 0x10
HARMONIC = 0x20
PALMMUTE = 0x40
SLAP = 0x80
PLUCK = 0x100
HAMMERON = 0x200
PULLOFF = 0x400
SLIDE = 0x800
BEND = 0x1000
SUSTAIN = 0x2000
TAP = 0x4000
PINCHHARMONIC = 0x8000
VIBRATO = 0x10000
MUTE = 0x20000
IGNORE = 0x40000
LEFTHAND = 0x80000
RIGHTHAND = 0x100000
HIGHDENSITY = 0x200000
UNPITCHEDSLIDE = 0x400000
SINGLE = 0x800000
CHORDNOTES = 0x1000000
DOUBLESTOP = 0x2000000
ACCENT = 0x4000000
PARENT = 0x8000000
CHILD = 0x10000000
ARPEGGIO = 0x20000000
CHORDPANEL = 0x80000000

# ChordMask flags (stored on chord templates, separate from NoteMask above).
CHORD_MASK_ARPEGGIO = 0x01

# Anchor first/last-note placeholders used when an anchor holds no notes.
UNINIT_FIRST_NOTE = 3.4028234663852886e38
UNINIT_LAST_NOTE = 1.1754943508222875e-38

DNA_NONE, DNA_SOLO, DNA_RIFF, DNA_CHORD = 0, 1, 2, 3


@dataclass
class Beat:
    time: float
    measure: int
    beat: int
    phrase_iteration: int
    mask: int  # 1 = first beat of measure, +2 = even measure


@dataclass
class Phrase:
    name: str
    max_difficulty: int = 0
    iteration_count: int = 1
    solo: int = 0
    disparity: int = 0
    ignore: int = 0


@dataclass
class ChordTemplate:
    frets: list  # int8[6], -1 unused
    fingers: list  # int8[6], -1 unknown
    notes: list  # int32[6] midi, -1 unused
    name: str = ""
    mask: int = 0


@dataclass
class BendValue:
    time: float
    step: float


@dataclass
class ChordNotes:
    mask: list  # uint32[6]
    slide_to: list  # int8[6]
    slide_unpitch_to: list  # int8[6]
    vibrato: list  # int16[6]
    bend_data: list  # per string: list[BendValue] (max 32)

    def key(self) -> tuple:
        return (
            tuple(self.mask), tuple(self.slide_to), tuple(self.slide_unpitch_to),
            tuple(self.vibrato),
            tuple(tuple((b.time, b.step) for b in bd) for bd in self.bend_data),
        )


@dataclass
class PhraseIteration:
    phrase_id: int
    start_time: float
    end_time: float
    difficulty: tuple = (0, 0, 0)


@dataclass
class Section:
    name: str
    number: int
    start_time: float
    end_time: float
    start_pi: int
    end_pi: int
    string_mask: list  # int8[36]


@dataclass
class Anchor:
    start_time: float
    end_time: float
    first_note_time: float
    last_note_time: float
    fret: int
    width: int
    phrase_iteration_id: int


@dataclass
class AnchorExtension:
    beat_time: float
    fret: int


@dataclass
class FingerPrint:
    chord_id: int
    start_time: float
    end_time: float
    first_note_time: float
    last_note_time: float


@dataclass
class Note:
    mask: int = 0
    flags: int = 0
    hash: int = 0
    time: float = 0.0
    string: int = -1
    fret: int = -1
    anchor_fret: int = -1
    anchor_width: int = -1
    chord_id: int = -1
    chord_notes_id: int = -1
    phrase_id: int = -1
    phrase_iteration_id: int = -1
    finger_print_id: tuple = (-1, -1)
    next_iter_note: int = -1
    prev_iter_note: int = -1
    parent_prev_note: int = -1
    slide_to: int = -1
    slide_unpitch_to: int = -1
    left_hand: int = -1
    tap: int = -1
    pick_direction: int = 0
    slap: int = -1
    pluck: int = -1
    vibrato: int = 0
    sustain: float = 0.0
    max_bend: float = 0.0
    bend_values: list = field(default_factory=list)


@dataclass
class Level:
    difficulty: int = 0
    anchors: list = field(default_factory=list)
    anchor_extensions: list = field(default_factory=list)
    handshapes: list = field(default_factory=list)  # FingerPrint
    arpeggios: list = field(default_factory=list)  # FingerPrint
    notes: list = field(default_factory=list)
    average_notes_per_iteration: list = field(default_factory=list)  # per phrase
    notes_in_pi_excl_ignored: list = field(default_factory=list)  # per PI
    notes_in_pi_all: list = field(default_factory=list)  # per PI


@dataclass
class MetaData:
    max_score: float = 100_000.0
    max_notes_and_chords: float = 0.0
    max_notes_and_chords_real: float = 0.0
    points_per_note: float = 0.0
    first_beat_length: float = 0.0
    start_time: float = 0.0
    capo_fret_id: int = -1
    last_conversion_date_time: str = ""
    part: int = 1
    song_length: float = 0.0
    tuning: tuple = (0, 0, 0, 0, 0, 0)
    first_note_time: float = 0.0
    max_difficulty: int = 0


@dataclass
class SNG:
    beats: list = field(default_factory=list)
    phrases: list = field(default_factory=list)
    chords: list = field(default_factory=list)  # ChordTemplate
    chord_notes: list = field(default_factory=list)  # ChordNotes
    phrase_iterations: list = field(default_factory=list)
    tones: list = field(default_factory=list)  # (time, tone_id)
    dnas: list = field(default_factory=list)  # (time, dna_id)
    sections: list = field(default_factory=list)
    levels: list = field(default_factory=list)
    metadata: MetaData = field(default_factory=MetaData)


def _name32(s: str, length: int = 32) -> bytes:
    raw = s.encode("utf-8")[: length - 1]
    return raw + bytes(length - len(raw))


def _bend_values(out: bytearray, values: list) -> None:
    out += struct.pack("<i", len(values))
    for bv in values:
        out += struct.pack("<ffi", bv.time, bv.step, 0)


def serialize(sng: SNG) -> bytes:
    """Serialize to the plain (unencrypted) SNG byte layout."""
    out = bytearray()

    out += struct.pack("<i", len(sng.beats))
    for b in sng.beats:
        out += struct.pack("<fhhii", b.time, b.measure, b.beat, b.phrase_iteration, b.mask)

    out += struct.pack("<i", len(sng.phrases))
    for p in sng.phrases:
        out += struct.pack("<bbbbii", p.solo, p.disparity, p.ignore, 0,
                           p.max_difficulty, p.iteration_count)
        out += _name32(p.name)

    out += struct.pack("<i", len(sng.chords))
    for c in sng.chords:
        out += struct.pack("<I6b6b6i", c.mask, *c.frets, *c.fingers, *c.notes)
        out += _name32(c.name)

    out += struct.pack("<i", len(sng.chord_notes))
    for cn in sng.chord_notes:
        out += struct.pack("<6I", *cn.mask)
        for bd in cn.bend_data:  # BendData32: 32 fixed slots + used count
            for i in range(32):
                bv = bd[i] if i < len(bd) else None
                out += struct.pack("<ffi", bv.time if bv else 0.0, bv.step if bv else 0.0, 0)
            out += struct.pack("<i", len(bd))
        out += struct.pack("<6b", *cn.slide_to)
        out += struct.pack("<6b", *cn.slide_unpitch_to)
        out += struct.pack("<6h", *cn.vibrato)

    out += struct.pack("<i", 0)  # vocals (no symbols sections when 0)

    out += struct.pack("<i", len(sng.phrase_iterations))
    for pi in sng.phrase_iterations:
        out += struct.pack("<iff3i", pi.phrase_id, pi.start_time, pi.end_time, *pi.difficulty)

    out += struct.pack("<i", 0)  # phrase extra info
    out += struct.pack("<i", 0)  # new linked difficulties
    out += struct.pack("<i", 0)  # actions
    out += struct.pack("<i", 0)  # events

    out += struct.pack("<i", len(sng.tones))
    for time, tone_id in sng.tones:
        out += struct.pack("<fi", time, tone_id)

    out += struct.pack("<i", len(sng.dnas))
    for time, dna_id in sng.dnas:
        out += struct.pack("<fi", time, dna_id)

    out += struct.pack("<i", len(sng.sections))
    for s in sng.sections:
        out += _name32(s.name)
        out += struct.pack("<iffii", s.number, s.start_time, s.end_time, s.start_pi, s.end_pi)
        out += struct.pack("<36b", *s.string_mask)

    out += struct.pack("<i", len(sng.levels))
    for lvl in sng.levels:
        out += struct.pack("<i", lvl.difficulty)

        out += struct.pack("<i", len(lvl.anchors))
        for a in lvl.anchors:
            out += struct.pack("<ffffb3xii", a.start_time, a.end_time, a.first_note_time,
                               a.last_note_time, a.fret, a.width, a.phrase_iteration_id)

        out += struct.pack("<i", len(lvl.anchor_extensions))
        for ax in lvl.anchor_extensions:
            out += struct.pack("<fbihb", ax.beat_time, ax.fret, 0, 0, 0)

        for fps in (lvl.handshapes, lvl.arpeggios):
            out += struct.pack("<i", len(fps))
            for fp in fps:
                out += struct.pack("<iffff", fp.chord_id, fp.start_time, fp.end_time,
                                   fp.first_note_time, fp.last_note_time)

        out += struct.pack("<i", len(lvl.notes))
        for n in lvl.notes:
            # 27 values, grouped to match the argument lines below so the format
            # can be read against them instead of counted:
            #   III f     mask, flags, hash / time
            #   4b        string, fret, anchor_fret, anchor_width
            #   4i        chord_id, chord_notes_id, phrase_id, phrase_iteration_id
            #   2h        finger_print_id[2]
            #   3h        next_iter_note, prev_iter_note, parent_prev_note  (int16 --
            #             this is the 32,767-note ceiling chart.py enforces)
            #   7b        slide_to, slide_unpitch_to, left_hand, tap,
            #             pick_direction, slap, pluck
            #   h ff      vibrato / sustain, max_bend
            # Field-by-field meanings: docs/format-reference.md.
            out += struct.pack(
                "<IIIf4b4i2h3h7bhff",
                n.mask, n.flags, n.hash, n.time,
                n.string, n.fret, n.anchor_fret, n.anchor_width,
                n.chord_id, n.chord_notes_id, n.phrase_id, n.phrase_iteration_id,
                *n.finger_print_id,
                n.next_iter_note, n.prev_iter_note, n.parent_prev_note,
                n.slide_to, n.slide_unpitch_to, n.left_hand, n.tap,
                n.pick_direction, n.slap, n.pluck,
                n.vibrato, n.sustain, n.max_bend,
            )
            _bend_values(out, n.bend_values)

        out += struct.pack("<i", len(lvl.average_notes_per_iteration))
        out += struct.pack(f"<{len(lvl.average_notes_per_iteration)}f",
                           *lvl.average_notes_per_iteration)
        for arr in (lvl.notes_in_pi_excl_ignored, lvl.notes_in_pi_all):
            out += struct.pack("<i", len(arr))
            out += struct.pack(f"<{len(arr)}i", *arr)

    m = sng.metadata
    out += struct.pack("<ddddffb", m.max_score, m.max_notes_and_chords,
                       m.max_notes_and_chords_real, m.points_per_note,
                       m.first_beat_length, m.start_time, m.capo_fret_id)
    out += _name32(m.last_conversion_date_time)
    out += struct.pack("<hf", m.part, m.song_length)
    out += struct.pack(f"<i{len(m.tuning)}h", len(m.tuning), *m.tuning)
    # first_note_time really is written twice: the metadata block carries both
    # `firstNoteTime` and `firstNoteTimeAgain`, which RS2014 stores redundantly.
    # Not a copy-paste slip -- see docs/format-reference.md.
    out += struct.pack("<ffi", m.first_note_time, m.first_note_time, m.max_difficulty)

    return bytes(out)


def pack(plain: bytes) -> bytes:
    """Compress + encrypt a plain SNG for a PC psarc.

    The fixed key and all-zero IV below are NOT a mistake and NOT a security
    control. This is the format: Rocksmith 2014 ships that key in the game
    binary and reads every PC SNG with a zero IV, so any other choice produces a
    file the game cannot open. Nothing secret is being protected -- the plaintext
    is a chart the user authored and is about to install themselves.

    (In any other context a fixed AES-CTR key/nonce pair would be a critical
    finding, because reusing a keystream lets two ciphertexts be XORed against
    each other. Stated here because a public repo attracts exactly one kind of
    drive-by report.)
    """
    payload = struct.pack("<i", len(plain)) + zlib.compress(plain, 9)
    enc = Cipher(algorithms.AES(SNG_KEY_PC), modes.CTR(bytes(16))).encryptor()
    return (struct.pack("<ii", 0x4A, 3) + bytes(16)
            + enc.update(payload) + enc.finalize() + bytes(56))


def unpack(data: bytes) -> bytes:
    """Decrypt + decompress a packed SNG.

    Raises rather than asserting: `python -O` strips assert statements, and this
    is the only thing that checks a packed SNG is what it claims to be.
    """
    magic, header = struct.unpack("<ii", data[:8])
    if magic != 0x4A or header != 3:
        raise ValueError(f"not a packed SNG (magic={magic:#x}, header={header})")
    iv, payload = data[8:24], data[24:len(data) - 56]
    dec = Cipher(algorithms.AES(SNG_KEY_PC), modes.CTR(iv)).decryptor()
    plain = dec.update(payload) + dec.finalize()
    (length,) = struct.unpack("<i", plain[:4])
    out = zlib.decompress(plain[4:])
    if len(out) != length:
        raise ValueError(f"SNG length mismatch: header says {length}, got {len(out)}")
    return out
