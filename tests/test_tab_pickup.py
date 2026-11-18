"""Notes before the grid start become a pickup bar in the Guitar Pro export."""
import io
import unittest

import guitarpro as gp

from rs_studio.tab import build_gp5

STANDARD = [64, 59, 55, 50, 45, 40]                     # hi -> lo, as the editor sends it


class PickupTests(unittest.TestCase):
    def test_notes_before_the_grid_start_keep_their_order_in_a_short_first_bar(self):
        # 120 BPM, bar 1 at 1.5 s: three beats of pickup before it.
        pitches = [40, 43, 45, 47, 50]
        notes = [{"start": i * 0.5, "end": i * 0.5 + 0.4, "pitch": p} for i, p in enumerate(pitches)]
        data, _ = build_gp5({"tracks": [{"name": "Bass", "tuning": STANDARD, "notes": notes}],
                             "grid": {"bpm": 120, "offset": 1.5, "tsNum": 4, "tsDen": 4}})
        track = gp.parse(io.BytesIO(data)).tracks[0]
        played = [track.strings[n.string - 1].value + n.value for m in track.measures
                  for v in m.voices for b in v.beats for n in b.notes if n.type == gp.NoteType.normal]
        self.assertEqual(played, pitches, "nothing piles onto the first beat of bar 1")
        first = track.measures[0].header.timeSignature
        self.assertEqual((first.numerator, first.denominator.value), (3, 4), "the pickup is three beats")
        self.assertEqual(track.measures[1].header.timeSignature.numerator, 4)


if __name__ == "__main__":
    unittest.main()
