"""Arpeggio and handshape frames from the editor's grip shapes (web/shapes.js)."""
import unittest

from rs_studio.rocksmith import checker, sng as S
from rs_studio.rocksmith.chart import compile_track

TUNING = [64, 59, 55, 50, 45, 40]   # E standard, high to low


def _am(kind, shape="shape_1", **extra):
    # An open A minor grip picked string by string: A, E, A, C, E (GP strings 5..1).
    grip = [(5, 0, 45), (4, 2, 52), (3, 2, 57), (2, 1, 60), (1, 0, 64)]
    return [{"string": s, "fret": f, "pitch": p, "start": 1.0 + k * 0.25, "end": 1.25 + k * 0.25,
             "hand": 1, "shapeId": shape, "shapeKind": kind, "shapeName": "Am", **extra}
            for k, (s, f, p) in enumerate(grip)]


def _compile(notes, phrases=None):
    track = {"name": "Lead", "tuning": TUNING, "notes": notes}
    return compile_track(track, {"bpm": 120, "offset": 0, "tsNum": 4}, 10.0, phrase_boundaries=phrases)


class GripOnlyTest(unittest.TestCase):
    def test_a_grip_only_note_shapes_the_frame_and_is_not_played(self):
        # Only A and E picked; the C on the B string is held, not played.
        notes = [n for n in _am("handshape") if n["string"] in (5, 4, 3)]
        held = {"string": 2, "fret": 1, "pitch": 60, "start": 1.0, "end": 1.75, "hand": 1,
                "shapeId": "shape_1", "shapeKind": "handshape", "shapeName": "Am", "gripOnly": True,
                "grace": True}
        compiled = _compile(notes + [held])
        level = compiled.sng.levels[0]
        self.assertEqual(len(level.notes), 3, "the held note is not a note, nor is its grace")
        template = compiled.sng.chords[level.handshapes[0].chord_id]
        self.assertEqual(template.frets[4], 1, "but it is in the grip")
        self.assertNotIn("grip-only", [code for code, _ in compiled.fixes])

    def test_a_grip_only_note_outside_a_shape_is_reported(self):
        lone = {"string": 2, "fret": 1, "pitch": 60, "start": 3.0, "end": 3.5, "hand": 1, "gripOnly": True}
        compiled = _compile(_am("handshape") + [lone])
        self.assertIn(("grip-only", 3.0), compiled.fixes)
        self.assertEqual(len(compiled.sng.levels[0].notes), 5)


class ShapeExportTest(unittest.TestCase):
    def test_arpeggio_frames_single_notes_with_an_arp_grip(self):
        compiled = _compile(_am("arpeggio"))
        level = compiled.sng.levels[0]
        self.assertEqual(len(level.arpeggios), 1)
        self.assertEqual(level.handshapes, [])
        template = compiled.sng.chords[level.arpeggios[0].chord_id]
        self.assertTrue(template.mask & S.CHORD_MASK_ARPEGGIO)
        self.assertEqual(template.name, "Am")
        self.assertEqual(sorted(f for f in template.frets if f >= 0), [0, 0, 1, 2, 2])
        self.assertEqual(len(level.notes), 5, "every note stays its own timed event")
        for note in level.notes:
            self.assertTrue(note.mask & S.ARPEGGIO)
            self.assertEqual(note.finger_print_id, (-1, 0))

    def test_handshape_frames_single_notes_with_a_plain_grip(self):
        compiled = _compile(_am("handshape"))
        level = compiled.sng.levels[0]
        self.assertEqual(level.arpeggios, [])
        self.assertEqual(len(level.handshapes), 1)
        template = compiled.sng.chords[level.handshapes[0].chord_id]
        self.assertFalse(template.mask & S.CHORD_MASK_ARPEGGIO)
        for note in level.notes:
            self.assertFalse(note.mask & S.ARPEGGIO)
            self.assertEqual(note.finger_print_id, (0, -1))

    def test_handshapes_keep_time_order_with_automatic_chord_runs(self):
        # A strummed power chord before the handshape: its automatic fingerprint first.
        chord = [{"string": s, "fret": f, "pitch": p, "start": 0.2, "end": 0.6, "hand": 1}
                 for s, f, p in ((6, 1, 41), (5, 3, 48))]
        compiled = _compile(chord + _am("handshape"))
        level = compiled.sng.levels[0]
        self.assertEqual(len(level.handshapes), 2)
        self.assertLess(level.handshapes[0].start_time, level.handshapes[1].start_time)
        shape_notes = [n for n in level.notes if n.time >= 1.0]
        self.assertTrue(all(n.finger_print_id == (1, -1) for n in shape_notes))

    def test_a_string_on_two_frets_is_no_grip(self):
        notes = _am("arpeggio")
        notes.append({**notes[1], "fret": 4, "pitch": 54, "start": 2.5, "end": 2.75})
        compiled = _compile(notes)
        self.assertEqual(compiled.sng.levels[0].arpeggios, [])
        self.assertIn("shape-grip", [code for code, _ in compiled.fixes])

    def test_an_outside_note_at_a_shape_onset_breaks_it(self):
        notes = _am("arpeggio")
        notes.append({"string": 6, "fret": 0, "pitch": 40, "start": 1.0, "end": 1.2, "hand": 1})
        compiled = _compile(notes)
        self.assertEqual(compiled.sng.levels[0].arpeggios, [])
        self.assertIn("shape-mixed", [code for code, _ in compiled.fixes])

    def test_an_outside_note_between_shape_notes_breaks_it(self):
        # A shape is a stretch of time, as in EOF: what is played inside belongs to it.
        notes = _am("handshape")
        notes.append({"string": 6, "fret": 3, "pitch": 43, "start": 1.6, "end": 1.7, "hand": 1})
        compiled = _compile(notes)
        level = compiled.sng.levels[0]
        self.assertEqual([fp for fp in level.handshapes if fp.start_time == 1.0], [])
        self.assertIn("shape-mixed", [code for code, _ in compiled.fixes])

    def test_two_shapes_side_by_side_both_export(self):
        notes = _am("arpeggio") + [
            {**n, "start": n["start"] + 2.0, "end": n["end"] + 2.0, "shapeId": "shape_2", "shapeKind": "handshape"}
            for n in _am("handshape")]
        level = _compile(notes).sng.levels[0]
        self.assertEqual(len(level.arpeggios), 1)
        self.assertEqual(len(level.handshapes), 1)

    def test_grace_note_and_slide_in_inside_a_shape_keep_it(self):
        notes = _am("arpeggio")
        # The export writes both as extra short notes inside the shape's stretch.
        notes[2]["grace"] = "half"                                  # G string, fret 2
        notes[3] = {**notes[3], "fret": 3, "slide": "inBelow"}     # B string, slid into from below
        compiled = _compile(notes)
        codes = [code for code, _ in compiled.fixes]
        self.assertNotIn("grace", codes, "the grace note was written")
        self.assertNotIn("slide-in", codes, "the slide-in was written")
        self.assertEqual(len(compiled.sng.levels[0].notes), 7, "five shape notes and two helpers")
        self.assertEqual(len(compiled.sng.levels[0].arpeggios), 1)
        self.assertNotIn("shape-mixed", codes)

    def test_the_frame_ends_where_the_next_note_starts(self):
        notes = _am("handshape")
        notes[-1]["end"] = 3.0                 # the last note rings on
        notes.append({"string": 6, "fret": 3, "pitch": 43, "start": 2.5, "end": 2.7, "hand": 1})
        frame = next(fp for fp in _compile(notes).sng.levels[0].handshapes if fp.start_time == 1.0)
        self.assertLess(frame.end_time, 2.5)

    def test_the_hand_stays_put_inside_a_shape_and_the_change_is_reported(self):
        notes = _am("handshape")
        notes[3]["hand"] = 3   # a hand anchor (or the fingering) moves the hand mid-shape
        compiled = _compile(notes)
        inside = [a for a in compiled.sng.levels[0].anchors if 1.0 < a.start_time < 2.25]
        self.assertEqual(inside, [])
        self.assertIn(("shape-hand", 1.75), compiled.fixes)
        self.assertEqual(len(compiled.sng.levels[0].handshapes), 1, "the shape itself still exports")

    def test_a_steady_hand_inside_a_shape_is_not_reported(self):
        self.assertNotIn("shape-hand", [code for code, _ in _compile(_am("arpeggio")).fixes])

    def test_the_users_name_is_the_grip_name(self):
        compiled = _compile(_am("arpeggio", shapeName="Am(add9)"))
        template = compiled.sng.chords[compiled.sng.levels[0].arpeggios[0].chord_id]
        self.assertEqual(template.name, "Am(add9)")


    def test_frame_note_times_as_dlc_builder_finds_them(self):
        """convertHandshape: the first note inside, and the last one's end unless it reaches the frame's end."""
        for kind in ("handshape", "arpeggio"):
            with self.subTest(kind):
                notes = _am(kind)
                notes[0]["end"] = 2.5   # the low A rings past the last note, so the frame does too
                level = _compile(notes).sng.levels[0]
                [frame] = level.arpeggios if kind == "arpeggio" else level.handshapes
                last = level.notes[-1]
                self.assertEqual((frame.first_note_time, frame.end_time), (1.0, 2.5))
                self.assertEqual(frame.last_note_time, last.time + last.sustain)
                self.assertLess(frame.last_note_time, frame.end_time)
                # The last note held to the frame's end: no last note time.
                level = _compile(_am(kind)).sng.levels[0]
                [frame] = level.arpeggios if kind == "arpeggio" else level.handshapes
                self.assertEqual(frame.last_note_time, -1.0)

    def test_a_phrase_start_inside_a_shape_cuts_its_frame(self):
        # A phrase starts on the beat at 1.5 s, between the 2nd and 3rd note.
        for kind in ("handshape", "arpeggio"):
            with self.subTest(kind):
                compiled = _compile(_am(kind), phrases=[{"t": 1.5}])
                level = compiled.sng.levels[0]
                frames = level.arpeggios if kind == "arpeggio" else level.handshapes
                # The first piece ends a 32nd note (at 120 bpm) before the second, as DLC
                # Builder's shortenHandshapes ends a handshape before the next one.
                self.assertEqual([(f.start_time, f.end_time) for f in frames][0][1], 1.5 - 0.5 / 8)
                self.assertEqual(len(frames), 2)
                self.assertEqual(frames[0].chord_id, frames[1].chord_id, "both pieces hold the same grip")
                self.assertEqual(frames[1].first_note_time, 1.5)
                slot = 1 if kind == "arpeggio" else 0
                self.assertEqual([n.finger_print_id[slot] for n in level.notes], [0, 0, 1, 1, 1])
                codes = [i.code for i in checker.check(compiled.sng, is_bass=False)]
                self.assertNotIn("I22", codes)
                self.assertNotIn("I21", codes)


if __name__ == "__main__":
    unittest.main()
