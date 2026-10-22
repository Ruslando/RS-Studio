import unittest

import numpy as np

from rs_studio.audio_bounds import audible_end


class AudibleEndTests(unittest.TestCase):
    def test_trailing_silence_is_excluded_but_release_margin_is_kept(self):
        samples = np.r_[np.zeros(1000), np.ones(2000), np.zeros(2000)]
        self.assertAlmostEqual(audible_end(samples, 1000), 3.1)

    def test_fade_is_retained_down_to_sixty_db(self):
        samples = np.r_[np.ones(1000), np.full(1000, .002), np.zeros(1000)]
        self.assertAlmostEqual(audible_end(samples, 1000), 2.1)

    def test_full_length_and_silence_are_not_shortened(self):
        for samples in (np.ones(1505), np.zeros(1505)):
            self.assertAlmostEqual(audible_end(samples, 1000), 1.505)
        self.assertEqual(audible_end([], 1000), 0)

    def test_stereo_does_not_cancel_opposite_channels(self):
        samples = np.stack([np.r_[np.ones(1000), np.zeros(1000)], np.r_[-np.ones(1000), np.zeros(1000)]], axis=1)
        self.assertAlmostEqual(audible_end(samples, 1000), 1.1)
