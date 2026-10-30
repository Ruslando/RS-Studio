import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from starlette.datastructures import UploadFile

from rs_studio import pipeline, server


class ReplacedFullSongTests(unittest.TestCase):
    """Replacing the full song must make it the separation source (it kept the old one)."""

    def test_replace_full_song_then_separate_uses_new_file_and_records_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp)
            (job_dir / "input.mp3").write_bytes(b"old song")
            stale = job_dir / "stems" / "roformer" / "vocals.wav"
            stale.parent.mkdir(parents=True)
            stale.write_bytes(b"old vocals")
            m = {"job": "j", "inputRel": "input.mp3", "filename": "old.mp3", "stems": [
                {"id": "mix", "name": "Full song", "audio_rel": "playback_mix.opus", "spectrogram": {}},
                {"id": "bass", "name": "Bass", "audio_rel": "playback_bass.opus", "spectrogram": {}},
            ]}
            saved = {}

            def view(stem_id):
                (job_dir / f"playback_{stem_id}.opus").write_bytes(b"x")
                return pipeline.StemView(stem_id, stem_id, job_dir / f"playback_{stem_id}.opus", {"duration": 1.0})

            seen = {}

            def add_stem(jd, source, backend, part, out_id):
                seen["source"] = source.name
                seen["cached"] = pipeline._separated_wav(jd, backend, source, part)
                return view(out_id), None

            with patch.object(server, "_read_manifest", side_effect=lambda job: m), \
                 patch.object(server, "_write_manifest", side_effect=lambda job, mm: saved.update(mm)), \
                 patch.object(server, "_job_dir", return_value=job_dir), \
                 patch.object(server, "_cache_busted", return_value=({}, "u")), \
                 patch.object(server.pipeline, "ingest_stem", side_effect=lambda src, jd, sid, name: view(sid)), \
                 patch.object(server.pipeline, "list_separators", return_value=[{"id": "roformer"}]), \
                 patch.object(server.processing, "run", side_effect=lambda _id, fn, *a, output_dir=None: fn(*a)), \
                 patch.object(server.pipeline, "add_stem", side_effect=add_stem):
                server.api_stem_replace("j", "mix", UploadFile(io.BytesIO(b"instrumental"), filename="inst.wav"))
                resp = server.api_stem_recreate("j", "bass", {"backend": "roformer", "part": "vocals"})

            self.assertEqual(seen["source"], "upload_mix.wav")
            self.assertIsNone(seen["cached"])            # old song's vocals are gone
            self.assertFalse((job_dir / "input.mp3").exists())
            self.assertEqual(saved["stems"][1]["separation"], {"backend": "roformer", "part": "vocals", "source": "song"})
            self.assertEqual(json.loads(resp.body)["stem"]["separation"]["part"], "vocals")


if __name__ == "__main__":
    unittest.main()
