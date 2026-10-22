import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from rs_studio.spectrogram_intensity import write_intensity, intensity_tile


class IntensityTests(unittest.TestCase):
    def test_values_tiles_and_zoomed_out_peaks(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'spec.png'
            original = np.array([[0, .2, .8, .1, 1], [.9, .1, .4, .3, .6]])
            write_intensity(Path(str(image) + '.intensity'), original)
            data = intensity_tile(image, Path('unused'), 1, 3)
            self.assertEqual(struct.unpack('<II', data[:8]), (3, 2))
            actual = np.frombuffer(data[8:], dtype='<u2').reshape(2, 3) / 65535
            np.testing.assert_allclose(actual, original[:, 1:4], atol=1/65535)
            reduced = intensity_tile(image, Path('unused'), 0, 1024, 2)
            self.assertEqual(struct.unpack('<II', reduced[:8]), (3, 2))
            actual = np.frombuffer(reduced[8:], dtype='<u2').reshape(2, 3) / 65535
            np.testing.assert_allclose(actual, [[.2, .8, 1], [.9, .4, .6]], atol=1/65535)

    def test_old_project_computes_data_once_without_replacing_png(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'spec.png'
            image.write_bytes(b'original')
            def compute(audio, out, view='energy'):
                out.write_bytes(b'regenerated')
                write_intensity(Path(str(out) + '.intensity'), np.array([[.5]]))
            with patch('rs_studio.pipeline.compute_spectrogram', side_effect=compute) as render:
                for _ in range(2):
                    intensity_tile(image, Path('audio'), 0, 1024)
                self.assertEqual(render.call_count, 1)
            self.assertEqual(image.read_bytes(), b'original')

    def test_intensity_is_bundled_with_new_projects(self):
        from rs_studio import server
        manifest = {'stems': [{'spectrogram': {'image': 'spec.png', 'intensity': 'spec.png.intensity'}, 'audio_rel': 'mix.ogg'}]}
        self.assertEqual(server._project_assets(manifest), ['spec.png', 'spec.png.intensity', 'mix.ogg'])

    def test_endpoint_returns_numeric_data_and_rejects_invalid_stride(self):
        from rs_studio import server
        from fastapi import HTTPException
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / 'spec.png'
            write_intensity(Path(str(image) + '.intensity'), np.array([[.1, .9]]))
            with patch.object(server, '_read_manifest', return_value={'stems': [{'id': 'mix', 'audio_rel': 'audio'}]}), \
                 patch.object(server, '_project_file_or_404', return_value=Path('audio')), \
                 patch.object(server, 'api_spectrogram', return_value=type('Image', (), {'path': image})()):
                response = server.api_intensity('job', 'mix', stride=2)
                self.assertEqual(struct.unpack('<II', response.body[:8]), (1, 1))
                self.assertAlmostEqual(struct.unpack('<H', response.body[8:])[0] / 65535, .9, places=4)
                with self.assertRaises(HTTPException):
                    server.api_intensity('job', 'mix', stride=3)
