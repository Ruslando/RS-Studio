"""Phrases without the editor's sections, as DLC Builder's PhraseGenerator makes them."""
import unittest

from rs_studio.rocksmith.chart import compile_track

TUNING = [64, 59, 55, 50, 45, 40]
FAST = {"bpm": 240, "offset": 0, "tsNum": 4}   # a measure a second: eight measures, eight seconds


def _note(t, d=0.2, string=3, fret=5, **fx):
    return {"string": string, "fret": fret, "pitch": TUNING[string - 1] + fret, "start": t, "end": t + d,
            "hand": 5, **fx}


def _phrases(notes, length=30.0):
    song = compile_track({"name": "L", "tuning": TUNING, "notes": notes}, FAST, length).sng
    return ([round(p.start_time, 3) for p in song.phrase_iterations],
            [(s.name, s.number, round(s.start_time, 3)) for s in song.sections])


def _steady(start, end):
    return [_note(start + k * 0.5) for k in range(int((end - start) * 2))]


class AutomaticPhraseTest(unittest.TestCase):
    def test_every_eight_measures(self):
        times, _ = _phrases(_steady(1.0, 20.0))
        self.assertEqual(times, [0.0, 1.0, 9.0, 17.0, 30.0])

    def test_a_phrase_moves_off_a_linked_note_to_the_nearer_side(self):
        notes = [n for n in _steady(1.0, 20.0) if not 8.0 <= n["start"] < 10.0]
        notes += [_note(8.6, 0.8, linkNext=True), _note(9.4, 0.5)]   # linked 8.6 to 9.9, across 9.0
        times, _ = _phrases(notes)
        self.assertIn(8.6, times, "nearer to 9.0 than the end at 9.9")
        self.assertNotIn(9.0, times)

    def test_a_phrase_moves_off_a_sustain(self):
        notes = [n for n in _steady(1.0, 20.0) if not 8.0 <= n["start"] < 10.0]
        notes += [_note(8.2, 1.3), _note(10.0)]   # held 8.2 to 9.5, across 9.0
        times, _ = _phrases(notes)
        self.assertIn(9.5, times, "nearer to 9.0 than the start at 8.2")

    def test_a_long_gap_is_noguitar_and_the_next_phrase_starts_on_the_next_note(self):
        times, sections = _phrases(_steady(1.0, 8.0) + _steady(12.0, 22.0))
        self.assertEqual(times, [0.0, 1.0, 9.0, 12.0, 20.0, 30.0])
        self.assertEqual(sections, [("riff", 1, 1.0), ("noguitar", 1, 9.0), ("riff", 2, 12.0),
                                    ("riff", 3, 20.0), ("noguitar", 2, 30.0)])

    def test_no_phrase_within_two_seconds_of_the_one_before(self):
        notes = [_note(1.0), _note(2.0, 7.5), _note(9.6)]   # held 2.0 to 9.5: off 9.0 is 2.0 or 9.5
        times, _ = _phrases(notes)
        self.assertEqual(times, [0.0, 1.0, 9.5, 30.0], "2.0 is too close to 1.0, so the later side")


if __name__ == "__main__":
    unittest.main()
