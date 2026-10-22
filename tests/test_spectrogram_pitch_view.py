import tempfile
import unittest
from pathlib import Path

import numpy as np

from rs_studio import pipeline
from rs_studio.spectrogram_intensity import intensity_tile


class PitchViewTests(unittest.TestCase):
    def test_pitch_view_lights_the_weak_fundamental(self):
        # F#2 whose 2nd harmonic is much louder than the fundamental (like the
        # distorted guitar that motivated the pitch view).
        import soundfile as sf
        sr, f0 = 22050, 92.5
        t = np.arange(sr * 2) / sr
        y = sum(a * np.sin(2 * np.pi * f0 * k * t) for k, a in [(1, .15), (2, 1), (3, .3), (4, .2)])
        with tempfile.TemporaryDirectory() as folder:
            audio = Path(folder) / 'tone.wav'
            sf.write(audio, y / 2, sr)
            brightest = {}
            for view in ('energy', 'fundamental', 'fine', 'fine-sharp', 'fundamental-sharp'):
                png = Path(folder) / f'{view}.png'
                meta = pipeline.compute_spectrogram(audio, png, view=view)
                tile = intensity_tile(png, audio, 40, 1)  # mid-note, away from the abrupt start
                rows = np.frombuffer(tile[8:], '<u2')  # one column, highest pitch first
                per = meta['height'] // 73  # fine view: 3 rows per semitone, middle one on the note
                brightest[view] = meta['midi_high'] - int(np.argmax(rows)) // per
        self.assertEqual(brightest['energy'], 54)  # F#3: the loud overtone
        self.assertEqual(brightest['fundamental'], 42)  # F#2: the note that is heard
        self.assertEqual(brightest['fine'], 54)  # fine rows line up with the semitone grid
        self.assertEqual(brightest['fine-sharp'], 54)
        self.assertEqual(brightest['fundamental-sharp'], 42)

    def test_unknown_view_rejected(self):
        with self.assertRaises(ValueError):
            pipeline.compute_spectrogram(Path('missing.wav'), Path('out.png'), view='bogus')


if __name__ == '__main__':
    unittest.main()
