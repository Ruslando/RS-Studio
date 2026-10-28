"""Phrase names and solo flags from the editor's phrase boundaries."""
import unittest

from rs_studio.rocksmith import checker
from rs_studio.rocksmith.chart import compile_track, phrase_name

TUNING = [64, 59, 55, 50, 45, 40]   # E standard, high to low
GRID = {"bpm": 120, "offset": 0, "tsNum": 4}   # a measure is 2 s


def _riff(at, fret=3):
    # Two notes on the low E, a beat apart, from `at`.
    return [{"string": 6, "fret": fret, "pitch": 40 + fret, "start": at + k * 0.5,
             "end": at + k * 0.5 + 0.25, "hand": 1} for k in range(2)]


def _compile(notes, phrases):
    track = {"name": "Lead", "tuning": TUNING, "notes": notes}
    return compile_track(track, GRID, 12.0, phrase_boundaries=phrases)


class PhraseNameTest(unittest.TestCase):
    def test_names_are_alphanumeric_and_reserved_names_are_refused(self):
        self.assertEqual(phrase_name("Riff A-1"), "RiffA1")
        self.assertEqual(phrase_name("x" * 40), "x" * 32)
        for reserved in ("COUNT", "end", "mover2", ""):
            self.assertEqual(phrase_name(reserved), "")
        self.assertEqual(phrase_name("movers"), "movers")

    def test_alike_names_are_one_phrase_played_twice(self):
        compiled = _compile(_riff(0.0) + _riff(2.0) + _riff(4.0, fret=5),
                            [{"t": 0.0, "name": "riffA", "solo": True}, {"t": 2.0, "name": "RIFFA"},
                             {"t": 4.0}])
        sng = compiled.sng
        names = [p.name for p in sng.phrases]
        self.assertEqual(names, ["riffA", "p3", "END"])
        self.assertEqual(sng.phrases[0].iteration_count, 2)
        self.assertEqual(sng.phrases[0].solo, 1)
        self.assertEqual([pi.phrase_id for pi in sng.phrase_iterations], [0, 0, 1, 2])
        self.assertEqual(sng.levels[0].average_notes_per_iteration[:2], [2.0, 2.0])
        self.assertNotIn("phrase-differs", [code for code, _ in compiled.fixes])
        notes = sng.levels[0].notes
        self.assertEqual({n.phrase_id for n in notes if n.time >= 2.0 and n.time < 4.0}, {0})

    def test_a_named_phrase_with_other_notes_is_reported(self):
        compiled = _compile(_riff(0.0) + _riff(2.0, fret=5),
                            [{"t": 0.0, "name": "riffA"}, {"t": 2.0, "name": "riffA"}])
        self.assertIn(("phrase-differs", 2.0), compiled.fixes)
        self.assertIn("phrase-differs", checker.FIXED)

    def test_an_unnamed_phrase_never_takes_a_users_name(self):
        compiled = _compile(_riff(0.0) + _riff(2.0),
                            [{"t": 0.0, "name": "p2"}, {"t": 2.0}])
        self.assertEqual([p.name for p in compiled.sng.phrases], ["p2", "p2x", "END"])


if __name__ == "__main__":
    unittest.main()
