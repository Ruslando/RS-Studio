import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from rs_studio.rocksmith import builder


def _sine(sr, seconds, amp=1.0, channels=1):
    t = np.arange(int(sr * seconds)) / sr
    return np.repeat((amp * np.sin(2 * np.pi * 997 * t))[:, None], channels, axis=1)


class LoudnessTest(unittest.TestCase):
    def test_bs1770_reference_tone(self):
        # A full-scale 997 Hz sine reads -3.01 LUFS mono, 0 LUFS stereo, at any rate.
        for sr in (44100, 48000):
            self.assertAlmostEqual(builder.integrated_loudness(_sine(sr, 5), sr), -3.01, places=1)
            self.assertAlmostEqual(builder.integrated_loudness(_sine(sr, 5, channels=2), sr), 0.0, places=1)

    def test_auto_volume_levels_to_minus_16(self):
        self.assertEqual(builder.auto_volume(_sine(48000, 5, 0.1), 48000), 7.0)   # -23 LUFS -> +7 dB
        self.assertEqual(builder.auto_volume(np.zeros((48000 * 2, 2)), 48000), 0.0)


class PreviewTest(unittest.TestCase):
    def test_window_is_a_start_and_a_length(self):
        def window(start, length, song=200):
            return builder.preview_window({"rocksmith": {"preview": {"start": start, "length": length}}}, song, 0)
        self.assertEqual(window(10, 20), (10.0, 30.0))
        self.assertEqual(window(10, 90), (10.0, 40.0))       # at most 30 s
        self.assertEqual(window(10, 1), (10.0, 15.0))        # at least 5 s
        self.assertEqual(window(190, 28), (172.0, 200.0))    # kept inside the song
        self.assertEqual(window(0, 28, song=12), (0.0, 12.0))
        self.assertEqual(builder.preview_window({}, 240, 12), (11.0, 39.0))

    def test_prepare_audio_levels_song_and_clip_each(self):
        sr = 44100
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "song.wav"
            song = _sine(sr, 60, 0.05, 2)
            song[20 * sr:32 * sr] *= 4                         # a loud part in the clip
            sf.write(str(src), song, sr)
            spec = {"rocksmith": {"preview": {"start": 20, "length": 12}}}
            _, preview, length, volume, preview_volume = builder._prepare_audio(src, 0.0, Path(tmp), [], 0.0, spec)
            self.assertAlmostEqual(sf.info(str(preview)).duration, 12.0, places=2)
            self.assertAlmostEqual(length, 60.0, places=2)
            self.assertLess(preview_volume, volume)             # the louder clip is turned down more


if __name__ == "__main__":
    unittest.main()
