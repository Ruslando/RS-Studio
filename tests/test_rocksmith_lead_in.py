import unittest

from rs_studio.rocksmith import builder
from rs_studio.rocksmith.chart import compile_track


def _spec(lead=None):
    spec = {
        "grid": {"bpm": 120, "offset": 0.5, "tsNum": 4, "tempoMap": [{"t": 8.0, "bpm": 90}]},
        "sections": [{"t": 0.5, "text": "Intro", "sectionType": "intro"}],
        "tracks": [{
            "name": "Lead", "tuning": [64, 59, 55, 50, 45, 40],
            "notes": [{"string": 5, "fret": 5, "start": 0.5, "end": 1.0, "pitch": 50}],
            "toneMarkers": [{"t": 0, "tone": "crunch"}, {"t": 4.0, "tone": "lead"}],
            "phraseBoundaries": [{"t": 2.5}],
        }],
    }
    if lead is not None:
        spec["rocksmith"] = {"leadingSilence": lead}
    return spec


class LeadInTest(unittest.TestCase):
    def test_absent_means_none(self):
        spec = _spec()
        self.assertEqual(builder._lead_in_seconds(spec), 0.0)
        self.assertIs(builder._with_lead_in(spec, 0.0), spec)

    def test_everything_timed_moves_and_the_source_is_untouched(self):
        spec = _spec(5)
        lead = builder._lead_in_seconds(spec)
        moved = builder._with_lead_in(spec, lead)
        track = moved["tracks"][0]
        self.assertEqual(track["notes"][0]["start"], 5.5)
        self.assertEqual(track["notes"][0]["end"], 6.0)
        self.assertEqual(track["phraseBoundaries"], [{"t": 7.5}])
        self.assertEqual(moved["sections"][0]["t"], 5.5)
        self.assertEqual(moved["grid"]["tempoMap"][0]["t"], 13.0)
        # the base tone stays the base tone; the switch moves with the music
        self.assertEqual([m["t"] for m in track["toneMarkers"]], [0, 9.0])

    def test_a_track_on_its_own_timing_moves_its_grid_and_sections_too(self):
        spec = _spec(5)
        spec["tracks"][0]["grid"] = {"bpm": 140, "offset": 0.0, "tsNum": 7, "tempoMap": [{"t": 6.0, "bpm": 100}]}
        spec["tracks"][0]["sections"] = [{"t": 1.0, "text": "Riff", "sectionType": "riff"}]
        moved = builder._with_lead_in(spec, builder._lead_in_seconds(spec))
        track = moved["tracks"][0]
        self.assertEqual(track["grid"]["tempoMap"][0]["t"], 11.0)
        self.assertEqual(track["sections"][0]["t"], 6.0)
        self.assertEqual(moved["grid"]["tempoMap"][0]["t"], 13.0)   # the song's still moves once
        self.assertEqual(spec["tracks"][0]["notes"][0]["start"], 0.5)

    def test_bar_lines_run_back_into_the_silence_in_phase(self):
        moved = builder._with_lead_in(_spec(5), 5.0)
        # 2s measures; the first downbeat was at 0.5s, so it is now at 5.5s and
        # the grid starts 1.5s in, two whole measures earlier.
        self.assertAlmostEqual(moved["grid"]["offset"], 1.5)
        notes = compile_track(moved["tracks"][0], moved["grid"], 20.0).sng.levels[0].notes
        self.assertAlmostEqual(notes[0].time, 5.5)

    def test_the_first_note_comes_at_ten_seconds_or_later(self):
        """EOF reports a first note before 10 s as an error: the silence grows to reach it."""
        self.assertEqual(builder._package_lead_in(_spec(5), [0]), 9.5)    # first note at 0.5 s
        self.assertEqual(builder._package_lead_in(_spec(12), [0]), 12.0)  # more was asked for
        spec = _spec(0)
        spec["tracks"][0]["notes"][0].update(start=30.0, end=31.0)
        spec["sections"][0]["t"] = 30.0
        self.assertEqual(builder._package_lead_in(spec, [0]), 0.0, "late enough already")

    def test_a_whole_empty_measure_comes_first(self):
        spec = _spec(0)
        spec["tracks"][0]["notes"][0].update(start=30.0, end=31.0)
        # A section on the first beat would start the first phrase there: one measure more.
        self.assertEqual(builder._package_lead_in(spec, [0]), 2.0)
        # 20 BPM: a 12 s measure does not fit into 10 s of silence; whole measures are added.
        slow = _spec(10)
        slow["grid"] = {"bpm": 20, "offset": 0.0, "tsNum": 4}
        slow["sections"] = []
        slow["tracks"][0]["notes"][0].update(start=0.0, end=1.0)
        lead = builder._package_lead_in(slow, [0])
        self.assertEqual(lead, 22.0)
        moved = builder._with_lead_in(slow, lead)
        first_beat = moved["grid"]["offset"]
        self.assertGreaterEqual(moved["tracks"][0]["notes"][0]["start"], first_beat + 12.0)

    def test_clamped(self):
        self.assertEqual(builder._lead_in_seconds(_spec(999)), builder.MAX_LEAD_IN)
        self.assertEqual(builder._lead_in_seconds(_spec(-3)), 0.0)
        self.assertEqual(builder._lead_in_seconds(_spec("x")), 0.0)


if __name__ == "__main__":
    unittest.main()
