import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

from rs_studio.audio_channels import channel_assets


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class AudioChannelTests(unittest.TestCase):
    def test_channel_content_cache_and_invalidation(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'stereo.wav'
            samples = np.column_stack([np.full(1024, .25), np.full(1024, -.5)])
            sf.write(source, samples, 22050, subtype='PCM_24')
            left, _ = channel_assets(source, 'left')
            right, _ = channel_assets(source, 'right')
            side, _ = channel_assets(source, 'side')
            for path, expected in [(left, .25), (right, -.5), (side, .375)]:
                audio, rate = sf.read(path)
                self.assertEqual(audio.ndim, 1)
                self.assertEqual(rate, 22050)
                np.testing.assert_allclose(audio, expected, atol=1e-5)
            def render(audio, out, view='energy', cents=0.0):
                Path(out).write_bytes(b'png')
            with patch('rs_studio.pipeline.compute_spectrogram', side_effect=render) as compute:
                _, image = channel_assets(source, 'left', spectrogram=True)
                self.assertEqual(image.read_bytes(), b'png')
                channel_assets(source, 'left', spectrogram=True)
                self.assertEqual(compute.call_count, 1)
            self.assertEqual(channel_assets(source, 'left')[0], left)
            sf.write(source, samples * .5, 22050, subtype='PCM_24')
            fresh, _ = channel_assets(source, 'left')
            self.assertNotEqual(fresh, left)
            np.testing.assert_allclose(sf.read(fresh)[0], .125, atol=1e-5)

    def test_mono_reuses_original_and_invalid_channel_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'mono.wav'
            sf.write(source, np.zeros(1024), 22050)
            for channel in ['stereo', 'left', 'right']:
                self.assertEqual(channel_assets(source, channel, spectrogram=True), (source, None))
            self.assertFalse((source.parent / 'channel-cache').exists())
            with self.assertRaises(ValueError):
                channel_assets(source, '../bad')


class ChannelPersistenceTests(unittest.TestCase):
    def test_channel_roundtrip_and_validation(self):
        from rs_studio import server
        manifest = {'job': 'channeltest', 'stems': [
            {'id': 'mix', 'name': 'Mix', 'spectrogram': {}, 'audio_rel': 'mix.wav'}]}
        with patch.object(server, '_read_manifest', return_value=manifest), patch.object(server, '_write_manifest'):
            server._apply_save_payload('channeltest', {'stemSettings': [{'id': 'mix', 'channel': 'right'}]})
            self.assertEqual(server._response_from_manifest(manifest)['stems'][0]['channel'], 'right')
            server._apply_save_payload('channeltest', {'stemSettings': [{'id': 'mix', 'channel': 'invalid'}]})
            self.assertEqual(manifest['stems'][0]['channel'], 'right')
            del manifest['stems'][0]['channel']
            self.assertEqual(server._response_from_manifest(manifest)['stems'][0]['channel'], 'stereo')

    def test_spectrogram_endpoint_selects_channel_and_mono_fallback(self):
        from rs_studio import server
        manifest = {'stems': [{'id': 'mix', 'spectrogram': {'image': 'mix.png'}, 'audio_rel': 'mix.wav'}]}
        with patch.object(server, '_read_manifest', return_value=manifest), \
             patch.object(server, '_project_file_or_404', side_effect=lambda job, path, label: Path(path)), \
             patch('rs_studio.audio_channels.channel_assets', return_value=(Path('right.flac'), Path('right.png'))) as assets:
            self.assertEqual(server.api_spectrogram('test', 'mix', 'right').path, Path('right.png'))
            assets.assert_called_once_with(Path('mix.wav'), 'right', spectrogram=True, view='energy', cents=0.0)
            assets.return_value = (Path('mix.wav'), None)
            self.assertEqual(server.api_spectrogram('test', 'mix', 'left').path, Path('mix.png'))

    def test_saved_view_roundtrip(self):
        from rs_studio import server
        manifest = {'job': 'viewtest', 'stems': [], 'editLanes': [{'id': 'lead', 'active': True}]}
        view = {'stem': 'guitar', 'zoomX': 8, 'zoomY': 2, 'speed': '1'}
        with patch.object(server, '_read_manifest', return_value=manifest), patch.object(server, '_write_manifest'):
            server._apply_save_payload('viewtest', {'view': view})
            restored = server._response_from_manifest(manifest)
            self.assertEqual(restored['view'], view)
            self.assertTrue(restored['editLanes'][0]['active'])
            server._apply_save_payload('viewtest', {'name': 'renamed'})
            self.assertEqual(manifest['view'], view, 'unrelated saves preserve the view')
