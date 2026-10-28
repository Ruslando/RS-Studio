"""Crowd events: the user's, and DLC Builder's for what the user leaves out."""
import unittest

from rs_studio.rocksmith import checker
from rs_studio.rocksmith.chart import _crowd_events, compile_track

TUNING = [64, 59, 55, 50, 45, 40]


def _compile(events):
    notes = [{"string": 6, "fret": 3, "pitch": 43, "start": 2.0, "end": 2.5, "hand": 1}]
    track = {"name": "Lead", "tuning": TUNING, "notes": notes, "crowdEvents": events}
    return compile_track(track, {"bpm": 120, "offset": 0, "tsNum": 4}, 30.0)


class CrowdEventTest(unittest.TestCase):
    def test_dlc_builder_defaults(self):
        self.assertEqual(sorted(_crowd_events([], 0.0, 2.0, 30.0, 120.0)),
                         [(0.0, "e1"), (2.6, "E3"), (5.1, "E13"), (21.0, "D3"), (30.0, "E13")])
        self.assertEqual(_crowd_events([], 0.0, None, 30.0, 80.0)[0], (0.0, "e0"))
        self.assertEqual(_crowd_events([], 0.0, None, 30.0, 180.0)[0], (0.0, "e2"))

    def test_the_users_events_replace_their_kind(self):
        mine = [{"t": 1.0, "code": "e2"}, {"t": 3.0, "code": "E3"}, {"t": 4.0, "code": "E13"},
                {"t": 5.0, "code": "B0"}, {"t": 6.0, "code": "x"}]
        self.assertEqual(sorted(_crowd_events(mine, 0.0, 2.0, 30.0, 120.0)),
                         [(1.0, "e2"), (3.0, "E3"), (4.0, "E13"), (21.0, "D3"), (30.0, "E13")])

    def test_written_in_time_order_and_checked(self):
        song = _compile([{"t": 3.0, "code": "E3"}, {"t": 3.5, "code": "e2"}]).sng
        times = [t for t, _ in song.events]
        self.assertEqual(times, sorted(times))
        codes = [(i.code, i.time) for i in checker.check(song, is_bass=False)]
        self.assertIn(("I02", 3.5), codes, "a crowd speed inside the intro applause")

    def test_intro_applause_without_its_end(self):
        song = _compile([{"t": 3.0, "code": "E3"}, {"t": 4.0, "code": "D3"}]).sng
        song.events = [e for e in song.events if e[1] != "E13"]
        self.assertIn(("I01", 3.0), [(i.code, i.time) for i in checker.check(song, is_bass=False)])


if __name__ == "__main__":
    unittest.main()
