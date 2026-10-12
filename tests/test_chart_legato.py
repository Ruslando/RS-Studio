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


if __name__ == "__main__":
    unittest.main()
