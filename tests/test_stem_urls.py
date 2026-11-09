import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class StemUrlVersionTests(unittest.TestCase):
    def test_replaced_audio_gets_a_new_url(self):
        """A reload must not be answered from the browser cache with the old audio."""
        from rs_studio import server
        with tempfile.TemporaryDirectory() as root:
            job_dir = Path(root) / "urljob"
            job_dir.mkdir()
            audio = job_dir / "playback_mix.opus"
            audio.write_bytes(b"old")
            m = {"job": "urljob", "stems": [{"id": "mix", "name": "Full song", "audio_rel": audio.name,
                                             "spectrogram": {"image": "missing.png"}}]}
            with patch.object(server, "RUNS_DIR", Path(root)):
                first = server._response_from_manifest(m)["stems"][0]
                os.utime(audio, ns=(audio.stat().st_atime_ns, audio.stat().st_mtime_ns + 10**9))
                second = server._response_from_manifest(m)["stems"][0]
        self.assertIn("?v=", first["audio_url"])
        self.assertNotEqual(first["audio_url"], second["audio_url"])
        self.assertEqual(first["spectrogram"]["url"], "/api/spectrogram/urljob/mix.png")   # no file, no version


if __name__ == "__main__":
    unittest.main()
