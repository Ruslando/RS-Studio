import unittest
from types import SimpleNamespace as NS

from rs_studio.rocksmith import builder, checker


class ToneSwitchTimingTests(unittest.TestCase):
    def test_a_switch_on_a_note_moves_just_ahead_of_it(self):
        song = NS(levels=[NS(notes=[NS(time=1.0), NS(time=2.0)]), NS(notes=[NS(time=0.99)])])
        out = builder._tones_off_notes([(1.0, 1), (1.5, 2), (2.0, 0)], [song])
        times = [t for t, _ in out]
        self.assertEqual([tone for _, tone in out], [1, 2, 0])
        self.assertEqual(times[1], 1.5)                     # off any note: unchanged
        self.assertAlmostEqual(times[2], 2.0 - builder.TONE_LEAD)
        # 0.99 is another level's onset, so the switch at 1.0 goes further back.
        self.assertLess(times[0], 0.99)
        onsets = {checker._ms(t) for t in (0.99, 1.0, 2.0)}
        self.assertFalse(onsets & {checker._ms(t) for t in times})


if __name__ == "__main__":
    unittest.main()
