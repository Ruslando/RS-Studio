"""How a repeated chord is drawn: in full, or as a repeat (EOF's High Density)."""
import unittest

from rs_studio.rocksmith import sng as S
from rs_studio.rocksmith.chart import compile_track

TUNING = [64, 59, 55, 50, 45, 40]


def _chord(t, **top):
    return [{"string": 6, "fret": 3, "pitch": 43, "start": t, "end": t + 0.5, "hand": 1},
            {"string": 5, "fret": 5, "pitch": 50, "start": t, "end": t + 0.5, "hand": 1, **top}]


def _drawn(*chords):
    notes = [n for c in chords for n in c]
    level = compile_track({"name": "L", "tuning": TUNING, "notes": notes},
                          {"bpm": 120, "offset": 0, "tsNum": 4}, 10.0).sng.levels[0]
    return [("full" if n.mask & S.CHORDPANEL else "repeat" if n.mask & S.HIGHDENSITY else "?",
             n.chord_notes_id != -1) for n in level.notes]


class ChordDensityTest(unittest.TestCase):
    def test_repeats_are_drawn_as_repeats(self):
        self.assertEqual([d for d, _ in _drawn(_chord(1.0), _chord(1.5), _chord(2.0))],
                         ["full", "repeat", "repeat"])

    def test_a_chord_with_its_own_technique_is_full_and_keeps_it(self):
        drawn = _drawn(_chord(1.0), _chord(1.5, fx={"vibrato": True}), _chord(2.0))
        self.assertEqual(drawn[1], ("full", True), "the vibrato would be lost on a repeat")

    def test_overrides(self):
        self.assertEqual(_drawn(_chord(1.0), _chord(1.5, chordDisplay="full"))[1][0], "full")
        self.assertEqual(_drawn(_chord(1.0), _chord(1.5, fx={"vibrato": True}), )[1][0], "full")
        drawn = _drawn(_chord(1.0), _chord(1.5, fx={"vibrato": True}, chordDisplay="repeat"))
        self.assertEqual(drawn[1], ("repeat", True), "a forced repeat still carries its technique")


class NoteStatusTest(unittest.TestCase):
    def _level(self, notes):
        return compile_track({"name": "L", "tuning": TUNING, "notes": notes},
                             {"bpm": 120, "offset": 0, "tsNum": 4}, 10.0)

    def test_ignore_leaves_a_note_and_its_chord_out_of_the_score(self):
        single = [{"string": 6, "fret": 3, "pitch": 43, "start": 3.0, "end": 3.2, "hand": 1, "ignore": True}]
        level = self._level(_chord(1.0, ignore=True) + single).sng.levels[0]
        self.assertTrue(all(n.mask & S.IGNORE for n in level.notes))
        self.assertEqual(sum(level.notes_in_pi_excl_ignored), 0)

    def test_fingerless_chord_has_no_fingers_and_no_warning(self):
        notes = [{**n, "finger": 1} for n in _chord(1.0, fingerless=True)]
        compiled = self._level(notes)
        self.assertEqual(compiled.sng.chords[0].fingers, [-1] * 6)
        unfingered = self._level(_chord(1.0))   # no finger from the fretboard: a warning
        self.assertIn("finger", [code for code, _ in unfingered.fixes])
        self.assertNotIn("finger", [code for code, _ in self._level(_chord(1.0, fingerless=True)).fixes])


if __name__ == "__main__":
    unittest.main()
