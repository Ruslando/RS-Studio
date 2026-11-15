"""Reopened projects retain their full-song source for CDLC export."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from rs_studio import server
from rs_studio.rocksmith import builder


class ProjectAudioTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="rs-audio-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.manifest = {"inputRel": "upload_mix.mp3", "stems": [
            {"id": "bass", "name": "Bass", "audio_rel": "bass.opus", "spectrogram": {}},
            {"id": "mix", "name": "Full song", "audio_rel": "playback_mix.opus",
             "spectrogram": {}, "muted": True},
        ]}
        (self.root / "playback_mix.opus").write_bytes(b"full song")
        (self.root / "bass.opus").write_bytes(b"bass only")

    def test_original_upload_is_preferred(self):
        original = self.root / "upload_mix.mp3"
        original.write_bytes(b"original")
        self.assertEqual(server._project_input(self.root, self.manifest), original)

    def test_legacy_input_is_preferred_over_playback(self):
        self.manifest.pop("inputRel")
        original = self.root / "input.wav"
        original.write_bytes(b"original")
        self.assertEqual(server._project_input(self.root, self.manifest), original)

    def test_missing_recorded_source_does_not_select_stale_upload(self):
        (self.root / "input.mp3").write_bytes(b"superseded song")
        self.assertEqual(server._project_input(self.root, self.manifest).name,
                         "playback_mix.opus")

    def test_missing_full_song_does_not_use_another_stem(self):
        (self.root / "playback_mix.opus").unlink()
        with self.assertRaises(HTTPException) as raised:
            server._project_input(self.root, self.manifest, "Song audio missing")
        self.assertEqual((raised.exception.status_code, raised.exception.detail),
                         (404, "Song audio missing"))

    def test_playback_cannot_escape_project(self):
        self.manifest["stems"][1]["audio_rel"] = "../outside.opus"
        with self.assertRaises(HTTPException):
            server._project_input(self.root, self.manifest)

    def test_imported_and_resaved_chart_exports_with_full_song(self):
        chart = io.BytesIO()
        with zipfile.ZipFile(chart, "w") as archive:
            archive.writestr("project.json", json.dumps(self.manifest))
            archive.writestr("playback_mix.opus", b"full song")
            archive.writestr("bass.opus", b"bass only")
        with patch.object(server, "RUNS_DIR", self.root), TestClient(
                server.app, base_url="http://127.0.0.1:8000") as client:
            def import_chart(data):
                response = client.post("/api/projects/import", files={"file": ("song.chart", data)})
                self.assertEqual(response.status_code, 200, response.text)
                return response.json()["job"]

            def build(spec, audio, **kwargs):
                self.assertEqual(audio.name, "playback_mix.opus")
                self.assertEqual(audio.read_bytes(), b"full song")
                return b"psarc", [], "song_p.psarc"

            job = import_chart(chart.getvalue())
            with patch.object(builder, "build_cdlc", side_effect=build) as build_cdlc:
                for _ in range(2):
                    response = client.post(f"/api/projects/{job}/rocksmith", json={})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.content, b"psarc")
                    saved = client.post(f"/api/projects/{job}/export", json={})
                    self.assertEqual(saved.status_code, 200, saved.text)
                    with zipfile.ZipFile(io.BytesIO(saved.content)) as archive:
                        portable = json.loads(archive.read("project.json"))
                        self.assertEqual(portable["inputRel"], "playback_mix.opus")
                        self.assertEqual(archive.namelist().count("playback_mix.opus"), 1)
                    job = import_chart(saved.content)
                self.assertEqual(build_cdlc.call_count, 2)

    def test_save_preserves_original_full_song_across_reopening(self):
        with patch.object(server, "RUNS_DIR", self.root), TestClient(
                server.app, base_url="http://127.0.0.1:8000") as client:
            job = client.post("/api/projects/new").json()["job"]
            job_dir = self.root / job
            (job_dir / "upload_mix.mp3").write_bytes(b"original recording")
            (job_dir / "playback_mix.opus").write_bytes(b"compressed playback")
            (job_dir / "bass.opus").write_bytes(b"bass only")
            manifest = server._read_manifest(job)
            manifest.update(self.manifest)
            server._write_manifest(job, manifest)
            for _ in range(2):
                saved = client.post(f"/api/projects/{job}/export", json={})
                self.assertEqual(saved.status_code, 200, saved.text)
                with zipfile.ZipFile(io.BytesIO(saved.content)) as archive:
                    portable = json.loads(archive.read("project.json"))
                    self.assertEqual(portable["inputRel"], "upload_mix.mp3")
                    self.assertEqual(archive.read(portable["inputRel"]), b"original recording")
                    self.assertEqual(archive.namelist().count("upload_mix.mp3"), 1)
                imported = client.post("/api/projects/import", files={
                    "file": ("song.chart", saved.content)})
                self.assertEqual(imported.status_code, 200, imported.text)
                job = imported.json()["job"]
                source = server._project_input(self.root / job, server._read_manifest(job))
                self.assertEqual(source.read_bytes(), b"original recording")

    def test_export_reports_how_to_restore_missing_full_song(self):
        with patch.object(server, "RUNS_DIR", self.root), TestClient(
                server.app, base_url="http://127.0.0.1:8000") as client:
            job = client.post("/api/projects/new").json()["job"]
            response = client.post(f"/api/projects/{job}/rocksmith", json={})
            self.assertEqual(response.status_code, 404)
            self.assertIn("Upload or replace the Full song audio", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
