import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from rs_studio import server


class SavePolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rs-save-policy-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.patch = patch.object(server, "RUNS_DIR", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.job = "policy-project"
        (self.root / self.job).mkdir()
        server._write_manifest(self.job, server._blank_manifest(self.job))

    def test_project_save_round_trips_view_and_audio_order(self):
        manifest = server._read_manifest(self.job)
        manifest["stems"] = [{"id": key, "name": key, "spectrogram": {}} for key in ["mix", "bass", "guitar"]]
        server._write_manifest(self.job, manifest)
        view = {"zoomX": 3, "zoomY": 2, "left": 120, "top": 40, "time": 15, "activeLane": "second"}
        server._apply_save_payload(self.job, {"view": view, "stemSettings": [{"id": key} for key in ["guitar", "mix", "bass"]]})
        restored = server._response_from_manifest(server._read_manifest(self.job))
        self.assertEqual(restored["view"], view)
        self.assertEqual([stem["id"] for stem in restored["stems"]], ["mix", "guitar", "bass"])

    def test_cover_draft_preserves_saved_cover_until_applied(self):
        def image(color):
            data = io.BytesIO()
            Image.new("RGB", (16, 16), color).save(data, "PNG")
            data.seek(0)
            return data

        manifest = server._read_manifest(self.job)
        server._store_cover_art(self.job, manifest, image("red"), "old.png")
        before = server._read_manifest(self.job)
        original_bytes = (self.root / self.job / "cover_art.png").read_bytes()
        staged = json.loads(server._store_cover_art(self.job, before, image("blue"), "new.png", draft=True).body)["metadata"]
        self.assertEqual(server._read_manifest(self.job), before)
        self.assertEqual((self.root / self.job / "cover_art.png").read_bytes(), original_bytes)
        self.assertTrue(Path(server.api_project_cover_get(self.job, staged["coverArt"]).path).exists())
        server._apply_save_payload(self.job, {"metadata": staged})
        self.assertEqual(server._read_manifest(self.job)["metadata"]["coverArt"], staged["coverArt"])
        self.assertEqual(Path(server.api_project_cover_get(self.job).path).name, staged["coverArt"])
