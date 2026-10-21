"""Sustain tails follow the note value at the song's main tempo, not the raw length."""
import unittest

from rs_studio.rocksmith import chart

STANDARD = [64, 59, 55, 50, 45, 40]


def _tails(bpm, beats, tempo_map=None, gap=0.0):
    """Sustain of a run of notes `beats` long each, ended `gap` seconds early."""
    grid = {"bpm": bpm, "offset": 0.0, "tsNum": 4, "tsDen": 4, "tempoMap": tempo_map or []}
    step = 60.0 / bpm * beats
    notes = [{"start": 1 + i * 2 * step, "end": 1 + i * 2 * step + step - gap, "pitch": 45 + i % 5,
              "string": 5, "fret": i % 5} for i in range(8)]
    sng = chart.compile_track({"name": "G", "tuning": STANDARD, "notes": notes}, grid, 30.0).sng
    return [n.sustain > 0 for n in sng.levels[-1].notes]


class SustainTests(unittest.TestCase):
    def test_eighths_sustain_on_slow_songs_only(self):
        self.assertTrue(all(_tails(60, 0.5)))
        self.assertTrue(all(_tails(120, 0.5)))
        self.assertFalse(any(_tails(160, 0.5)))
        self.assertTrue(all(_tails(160, 1)), "quarters keep their tail")

    def test_a_few_ms_short_does_not_flip_the_note(self):
        self.assertTrue(all(_tails(120, 0.5, gap=0.008)))
        self.assertFalse(any(_tails(160, 0.5, gap=-0.008)), "nor does a few ms long")

    def test_a_brief_tempo_change_does_not_split_the_song(self):
        # 160 BPM with one short stretch at 100: eighths stay plain throughout.
        self.assertFalse(any(_tails(160, 0.5, tempo_map=[{"t": 3.0, "bpm": 100}, {"t": 5.0, "bpm": 160}])))


def _sustains(notes, bpm=120):
    grid = {"bpm": bpm, "offset": 0.0, "tsNum": 4, "tsDen": 4, "tempoMap": []}
    sng = chart.compile_track({"name": "G", "tuning": STANDARD, "notes": notes}, grid, 30.0).sng
    return [round(n.sustain, 4) for n in sng.levels[-1].notes]


def _note(start, end, string, fret=3):
    return {"start": start, "end": end, "pitch": STANDARD[5 - string] + fret, "string": string, "fret": fret}


class NoteGapTests(unittest.TestCase):
    # 120 BPM, 4/4: a measure is 2 s, so the gap is 1/32 of it, 62.5 ms.
    def test_a_tail_played_up_to_the_next_note_ends_a_32nd_early(self):
        self.assertEqual(_sustains([_note(1, 2, 5), _note(2, 3, 4)])[0], 0.9375)

    def test_a_tail_into_the_same_string_is_cut(self):
        self.assertEqual(_sustains([_note(1, 2.5, 5), _note(2, 3, 5, fret=5)])[0], 0.9375)

    def test_a_tail_ringing_over_other_strings_rings(self):
        self.assertEqual(_sustains([_note(1, 3, 5), _note(2, 3, 4)])[0], 2.0)

    def test_a_tail_ending_well_before_the_next_note_is_kept(self):
        self.assertEqual(_sustains([_note(1, 1.8, 5), _note(2, 3, 4)])[0], 0.8)


if __name__ == "__main__":
    unittest.main()
