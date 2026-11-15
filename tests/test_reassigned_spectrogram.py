import warnings
import unittest

import numpy as np

from rs_studio import pipeline


class ReassignedSpectrogramTest(unittest.TestCase):
    def test_near_silence_and_audible_signal(self):
        sr = 22050
        samples = 8192
        rng = np.random.default_rng(0)
        near_silence = (rng.standard_normal(samples) * 1e-39).astype(np.float32)
        tone = np.sin(2 * np.pi * 440 * np.arange(samples) / sr).astype(np.float32)
        n_frames = 1 + samples // pipeline.HOP_LENGTH

        with warnings.catch_warnings():
            warnings.simplefilter("error", RuntimeWarning)
            silent_power = pipeline._reassigned_power(near_silence, sr, n_frames)
            tone_power = pipeline._reassigned_power(tone, sr, n_frames)

        self.assertTrue(np.isfinite(silent_power).all())
        self.assertFalse(silent_power.any())
        self.assertTrue(np.isfinite(tone_power).all())
        self.assertGreater(tone_power.max(), 0)
