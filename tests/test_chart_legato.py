import unittest

from rs_studio.rocksmith import sng as S
from rs_studio.rocksmith.chart import compile_track


def _notes(slide):
    # Two notes on the A string (GP string 5): fret 5 sliding to fret 7, with a
    # gap between them in the editor.
    return [
        {"string": 5, "fret": 5, "start": 1.0, "end": 1.3, "pitch": 50, "slide": slide},
        {"string": 5, "fret": 7, "start": 1.5, "end": 2.0, "pitch": 52},
    ]


def _compile(slide):
    track = {"name": "Lead", "tuning": [64, 59, 55, 50, 45, 40], "notes": _notes(slide)}
    grid = {"bpm": 120, "offset": 0, "tsNum": 4}
    return compile_track(track, grid, 10.0).sng.levels[0].notes


class LegatoSlideLinkTest(unittest.TestCase):
    def test_legato_target_is_a_child_and_needs_no_pick(self):
        source, target = _compile("legato")
        self.assertTrue(source.mask & S.SLIDE)
        self.assertTrue(source.mask & S.PARENT)
        self.assertEqual(source.slide_to, 7)
        # held exactly until the target, across the editor's gap
        self.assertAlmostEqual(source.time + source.sustain, target.time)
        self.assertTrue(target.mask & S.CHILD)
        self.assertEqual(target.parent_prev_note, 0)

    def test_shift_target_stays_a_picked_note(self):
        source, target = _compile("shift")
        self.assertTrue(source.mask & S.SLIDE)
        self.assertFalse(source.mask & S.PARENT)
        self.assertFalse(target.mask & S.CHILD)
        self.assertEqual(target.parent_prev_note, -1)


def _late(slide, extra=None, slide_start=0.6):
    # Fret 5 held for 60% of the note, then sliding to fret 7.
    notes = _notes(slide)
    notes[0] = {**notes[0], "end": 1.5, "slideStart": slide_start, **(extra or {})}
    track = {"name": "Lead", "tuning": [64, 59, 55, 50, 45, 40], "notes": notes}
    compiled = compile_track(track, {"bpm": 120, "offset": 0, "tsNum": 4}, 10.0)
    return compiled.sng.levels[0].notes, compiled


class LateSlideStartTest(unittest.TestCase):
    def test_late_legato_slide_is_hold_then_linked_slide(self):
        (hold, glide, target), _ = _late("legato", {"fx": {"accent": True, "vibrato": True}})
        self.assertAlmostEqual(hold.time, 1.0)
        self.assertEqual(hold.fret, 5)
        self.assertFalse(hold.mask & S.SLIDE)
        self.assertTrue(hold.mask & S.PARENT)
        self.assertTrue(hold.mask & S.ACCENT)
        self.assertAlmostEqual(hold.time + hold.sustain, glide.time)
        self.assertAlmostEqual(glide.time, 1.3)
        self.assertEqual(glide.fret, 5)
        self.assertTrue(glide.mask & S.CHILD)
        self.assertEqual(glide.parent_prev_note, 0)
        self.assertFalse(glide.mask & S.ACCENT)
        self.assertTrue(glide.mask & S.VIBRATO)
        self.assertTrue(glide.mask & S.SLIDE)
        self.assertTrue(glide.mask & S.PARENT)
        self.assertEqual(glide.slide_to, 7)
        self.assertAlmostEqual(glide.time + glide.sustain, target.time)
        self.assertTrue(target.mask & S.CHILD)
        self.assertEqual(target.parent_prev_note, 1)

    def test_late_shift_slide_keeps_target_picked(self):
        (hold, glide, target), _ = _late("shift")
        self.assertTrue(hold.mask & S.PARENT)
        self.assertTrue(glide.mask & S.CHILD and glide.mask & S.SLIDE)
        self.assertFalse(glide.mask & S.PARENT)
        self.assertFalse(target.mask & S.CHILD)

    def test_slide_start_at_pick_is_one_note(self):
        notes, _ = _late("legato", slide_start=0)
        self.assertEqual(len(notes), 2)

    def test_double_stop_slides_late_as_linked_single_notes(self):
        """As EOF writes it: the chord holds and links on, and what slides goes out
        as single notes at one time, each a Child carrying its own slide."""
        notes, fixes = _sng([
            {"string": 5, "fret": 4, "start": 1.0, "end": 2.0, "pitch": 44, "slide": "shift", "slideStart": 0.6},
            {"string": 2, "fret": 3, "start": 1.0, "end": 2.0, "pitch": 58, "slide": "shift", "slideStart": 0.6},
            {"string": 5, "fret": 6, "start": 2.0, "end": 3.0, "pitch": 46},
            {"string": 2, "fret": 6, "start": 2.0, "end": 3.0, "pitch": 61}])
        chord, a, b, target = notes
        self.assertTrue(chord.mask & S.CHORD and chord.mask & S.PARENT)
        self.assertAlmostEqual(a.time, 1.6)
        self.assertEqual(a.time, b.time)
        for piece in (a, b):
            self.assertTrue(piece.mask & S.SINGLE and piece.mask & S.CHILD and piece.mask & S.SLIDE)
            self.assertEqual(piece.parent_prev_note, 0)
        self.assertEqual((a.slide_to, b.slide_to), (6, 6))
        self.assertTrue(target.mask & S.CHORD, "the shift's target is picked as a chord")
        self.assertNotIn("late-fx", [code for code, _ in fixes])


def _sng(notes):
    track = {"name": "Lead", "tuning": [64, 59, 55, 50, 45, 40], "notes": notes}
    compiled = compile_track(track, {"bpm": 120, "offset": 0, "tsNum": 4}, 10.0)
    return compiled.sng.levels[0].notes, compiled.fixes


class LateVibratoTest(unittest.TestCase):
    def test_late_vibrato_is_plain_hold_then_linked_vibrato(self):
        (hold, wobble), _ = _sng([{"string": 5, "fret": 5, "start": 1.0, "end": 2.0, "pitch": 50,
                                   "fx": {"vibrato": True, "accent": True}, "vibratoStart": 0.5}])
        self.assertFalse(hold.mask & S.VIBRATO)
        self.assertTrue(hold.mask & S.ACCENT and hold.mask & S.PARENT)
        self.assertAlmostEqual(hold.time + hold.sustain, wobble.time)
        self.assertAlmostEqual(wobble.time, 1.5)
        self.assertTrue(wobble.mask & S.VIBRATO and wobble.mask & S.CHILD)
        self.assertFalse(wobble.mask & S.ACCENT)

    def test_vibrato_then_late_slide_is_three_linked_pieces(self):
        (hold, wobble, glide, target), _ = _sng([
            {"string": 5, "fret": 5, "start": 1.0, "end": 2.0, "pitch": 50, "slide": "legato",
             "slideStart": 0.75, "fx": {"vibrato": True}, "vibratoStart": 0.25},
            {"string": 5, "fret": 7, "start": 2.0, "end": 2.5, "pitch": 52}])
        self.assertEqual([round(n.time, 3) for n in (hold, wobble, glide)], [1.0, 1.25, 1.75])
        self.assertFalse(hold.mask & S.VIBRATO)
        self.assertTrue(wobble.mask & S.VIBRATO and wobble.mask & S.CHILD and wobble.mask & S.PARENT)
        self.assertFalse(wobble.mask & S.SLIDE)
        self.assertTrue(glide.mask & S.SLIDE and glide.mask & S.VIBRATO and glide.mask & S.CHILD)
        self.assertTrue(target.mask & S.CHILD)

    def test_vibrato_after_slide_start_covers_the_slide(self):
        notes, _ = _sng([
            {"string": 5, "fret": 5, "start": 1.0, "end": 2.0, "pitch": 50, "slide": "shift",
             "slideStart": 0.5, "fx": {"vibrato": True}, "vibratoStart": 0.8},
            {"string": 5, "fret": 7, "start": 2.0, "end": 2.5, "pitch": 52}])
        self.assertEqual(len(notes), 3)
        self.assertTrue(notes[1].mask & S.VIBRATO and notes[1].mask & S.SLIDE)


class GraceNoteTest(unittest.TestCase):
    def test_grace_is_a_short_lower_note_hammered_from(self):
        (grace, main), warnings = _sng([{"string": 5, "fret": 7, "start": 1.0, "end": 1.5, "pitch": 52, "grace": "whole"}])
        self.assertEqual(grace.fret, 5)
        self.assertAlmostEqual(grace.time, 1.0 - 0.08)
        self.assertEqual(main.fret, 7)
        self.assertTrue(main.mask & S.HAMMERON)
        self.assertFalse(grace.mask & S.HAMMERON)

    def test_grace_stops_at_the_open_string(self):
        (grace, main), _ = _sng([{"string": 5, "fret": 1, "start": 1.0, "end": 1.5, "pitch": 46, "grace": "whole"}])
        self.assertEqual(grace.fret, 0)

    def test_grace_without_room_is_left_out(self):
        notes, fixes = _sng([
            {"string": 5, "fret": 3, "start": 0.97, "end": 1.0, "pitch": 48},
            {"string": 5, "fret": 7, "start": 1.0, "end": 1.5, "pitch": 52, "grace": "half"}])
        self.assertEqual(len(notes), 2)
        self.assertIn(("grace", 1.0), fixes)


class BendContinuationTest(unittest.TestCase):
    def test_bend_held_into_the_next_note_links_it(self):
        (bend, release), _ = _sng([
            {"string": 3, "fret": 7, "start": 1.0, "end": 1.5, "pitch": 62, "bend": "full"},
            {"string": 3, "fret": 7, "start": 1.5, "end": 2.0, "pitch": 62, "bend": "custom",
             "bendPoints": [[0, 2], [1, 0]]}])
        self.assertTrue(bend.mask & S.PARENT)
        self.assertAlmostEqual(bend.time + bend.sustain, release.time)
        self.assertTrue(release.mask & S.CHILD)

    def test_unrelated_bends_stay_picked(self):
        (a, b), _ = _sng([
            {"string": 3, "fret": 7, "start": 1.0, "end": 1.5, "pitch": 62, "bend": "full"},
            {"string": 3, "fret": 7, "start": 1.5, "end": 2.0, "pitch": 62, "bend": "full"}])
        self.assertFalse(a.mask & S.PARENT)
        self.assertFalse(b.mask & S.CHILD)


if __name__ == "__main__":
    unittest.main()
