import unittest
from unittest.mock import patch

from rs_studio import server


class SongEndPersistenceTests(unittest.TestCase):
    def test_detected_end_and_manual_override_survive_save_and_restore(self):
        manifest = server._blank_manifest("song-end-test")
        manifest.update(duration=20, stems=[{"id": "mix", "name": "Mix", "spectrogram": {"songEnd": 18}}])
        self.assertEqual(server._response_from_manifest(manifest)["songEnd"], 18)
        with patch.object(server, "_read_manifest", return_value=manifest), patch.object(server, "_write_manifest") as write:
            saved = server._apply_save_payload("song-end-test", {
                "sectionMarkers": [{"id": "end", "t": 19.25, "text": "End", "sectionType": "end"}]})
            write.assert_called_once()
        restored = server._response_from_manifest(saved)
        self.assertEqual(restored["songEnd"], 19.25)
        self.assertEqual(restored["sectionMarkers"][0]["sectionType"], "end")

    def test_old_recording_uses_full_duration_not_an_isolated_stem_end(self):
        manifest = server._blank_manifest("song-end-test")
        manifest.update(duration=20, stems=[{"id": "mix", "name": "Mix", "spectrogram": {}},
            {"id": "guitar", "name": "Guitar", "spectrogram": {"songEnd": 10}}])
        self.assertEqual(server._response_from_manifest(manifest)["songEnd"], 20)

    def test_score_end_can_expand_with_score_duration(self):
        manifest = server._blank_manifest("song-end-test")
        manifest.update(duration=10, songEnd=10)
        with patch.object(server, "_read_manifest", return_value=manifest), patch.object(server, "_write_manifest"):
            saved = server._apply_save_payload("song-end-test", {"scoreDuration": 15,
                "sectionMarkers": [{"id": "end", "t": 15, "text": "End", "sectionType": "end"}]})
        self.assertEqual(server._response_from_manifest(saved)["songEnd"], 15)
