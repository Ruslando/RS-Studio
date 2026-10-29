"""The Rocksmith key belongs to the project: fixed at its first export, as DLC Builder keeps it."""
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from rs_studio import server
from rs_studio.rocksmith import builder

HERE = "http://127.0.0.1:8000"


class PackageKeyTests(unittest.TestCase):
    def test_a_kept_key_wins(self):
        spec = {"metadata": {"title": "Song", "artist": "Band"}, "rocksmith": {"dlcKey": "MTTKept1", "keySeed": "abc"}}
        self.assertEqual(builder.package_key(spec), "MTTKept1")

    def test_a_seed_separates_projects_of_one_song(self):
        spec = lambda seed: {"metadata": {"title": "Song", "artist": "Band"}, "rocksmith": {"keySeed": seed}}  # noqa: E731
        self.assertNotEqual(builder.package_key(spec("aaaaaaaaaaaa")), builder.package_key(spec("bbbbbbbbbbbb")))

    def test_without_a_seed_the_old_key(self):
        """Projects from before keep the key their songs are in the game with."""
        spec = {"metadata": {"title": "Song", "artist": "Band"}, "rocksmith": {}}
        self.assertEqual(builder.package_key(spec), builder._dlc_key("Band", "Song"))


class ProjectKeyTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="rs-key-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        runs = self.root / "runs"
        runs.mkdir()
        for patcher in (patch.object(server, "RUNS_DIR", runs),
                        patch.object(server, "_project_input", lambda *a, **k: self.root / "song.wav")):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.built = []

        def build(spec, audio, cover_art_path=None, phrase_levels=None):
            self.built.append(spec["rocksmith"]["dlcKey"])
            return b"psarc", [], "song.psarc"
        patcher = patch.object(builder, "build_cdlc", build)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(server.app, base_url=HERE)

    def export(self, job, title, **rocksmith):
        payload = {"metadata": {"title": title, "artist": "Band"}, "rocksmith": rocksmith}
        self.assertEqual(self.client.post(f"/api/projects/{job}/rocksmith", json=payload).status_code, 200)
        return self.built[-1]

    def new_project(self):
        return self.client.post("/api/projects/new").json()["job"]

    def test_the_key_is_fixed_at_the_first_export(self):
        job = self.new_project()
        first = self.export(job, "Song")
        self.assertEqual(server._read_manifest(job)["rocksmithKey"], first)
        self.assertEqual(self.export(job, "Song (Remastered)"), first, "renaming keeps the key")

    def test_two_projects_of_one_song_get_two_keys(self):
        self.assertNotEqual(self.export(self.new_project(), "Song"), self.export(self.new_project(), "Song"))

    def test_a_project_from_before_keeps_its_old_key(self):
        job = self.new_project()
        m = server._read_manifest(job)
        del m["rocksmithKeySeed"]
        server._write_manifest(job, m)
        self.assertEqual(self.export(job, "Song"), builder._dlc_key("Band", "Song"))

    def test_the_browser_cannot_choose_the_key(self):
        job = self.new_project()
        self.assertNotEqual(self.export(job, "Song", dlcKey="MTTOther1", keySeed="x"), "MTTOther1")


if __name__ == "__main__":
    unittest.main()
