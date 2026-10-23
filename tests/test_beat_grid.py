"""A tempo marker a little off the beat starts the next measure cleanly."""
import unittest

from rs_studio.rocksmith.chart import _gen_beats


class BeatGridTest(unittest.TestCase):
    def test_no_sliver_measure_before_an_off_beat_marker(self):
        step = 60 / 173
        five = 0.9 + 124 * step
        grid = {"bpm": 173, "offset": 0.9, "tsNum": 4, "tempoMap": [
            {"t": five + 0.0002, "bpm": 173, "tsNum": 5},
            {"t": five + 5 * step + 0.0014, "bpm": 173, "tsNum": 4},  # 1.4 ms late
        ]}
        times = [t for t, _, _ in _gen_beats(grid, 60)]
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertGreater(min(gaps), step * 0.9)
        bars = [t for t, _, beat in _gen_beats(grid, 60) if beat == 0]
        self.assertTrue(any(abs(b - a - 5 * step) < 0.01 for a, b in zip(bars, bars[1:])), "the 5/4 bar is whole")


if __name__ == "__main__":
    unittest.main()
