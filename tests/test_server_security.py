"""What the local server refuses: other sites, paths out of a project, internal addresses.

Runs the real app in-process on a throwaway project folder.
"""
import io
import json
import shutil
import socket
import tempfile
import unittest
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from rs_studio import server

HERE = "http://127.0.0.1:8000"


def _chart(files: dict) -> bytes:
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content if isinstance(content, (bytes, str)) else json.dumps(content))
    return data.getvalue()


class ServerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="rs-server-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.runs = self.root / "runs"
        self.runs.mkdir()
        patcher = patch.object(server, "RUNS_DIR", self.runs)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(server.app, base_url=HERE)

    def import_chart(self, files):
        return self.client.post("/api/projects/import", files={"file": ("song.chart", _chart(files))})

    # ---- who may talk to the server --------------------------------------
    def test_only_this_app_may_call_the_server(self):
        get = lambda **headers: self.client.get("/api/version", headers=headers).status_code
        self.assertEqual(get(), 200, "a local client without browser headers")
        self.assertEqual(get(Origin=HERE, **{"Sec-Fetch-Site": "same-origin"}), 200, "the app's own page")
        for reason, headers in (
            ("a page on another site", {"Origin": "https://evil.example"}),
            ("another local port", {"Origin": "http://127.0.0.1:9999"}),
            ("a cross-site request without Origin", {"Sec-Fetch-Site": "cross-site"}),
            ("another site in the same browser", {"Sec-Fetch-Site": "same-site"}),
            ("a foreign name pointed at this machine", {"Host": "evil.example:8000"}),
            ("a look-alike host", {"Host": "127.0.0.1.evil.example"}),
            ("credentials in the host", {"Host": "user@127.0.0.1:8000"}),
        ):
            with self.subTest(reason):
                self.assertEqual(get(**headers), 403)
        self.assertEqual(self.client.post("/api/cache/clear", headers={"Origin": "https://evil.example"}).status_code, 403,
                         "not for requests that change something either")

    # ---- project files that are not what they claim ------------------------
    def test_project_file_cannot_write_outside_its_folder(self):
        response = self.import_chart({"project.json": {"stems": []}, "../../escaped.txt": "x"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Unsafe path", response.json()["detail"])
        self.assertFalse((self.root / "escaped.txt").exists())
        self.assertEqual(list(self.runs.iterdir()), [], "nothing of a refused import is kept")

    def test_broken_project_files_are_refused_and_leave_nothing_behind(self):
        for reason, body, status in (
            ("not an archive", b"plain text", 400),
            ("no project inside", _chart({"notes.txt": "x"}), 400),
            ("project is not an object", _chart({"project.json": [1, 2]}), 400),
            ("project is not JSON", _chart({"project.json": "{"}), 400),
        ):
            with self.subTest(reason):
                response = self.client.post("/api/projects/import", files={"file": ("song.chart", body)})
                self.assertEqual(response.status_code, status)
        with patch.object(server, "_PROJECT_MAX_UNPACKED_BYTES", 1000):
            self.assertEqual(self.import_chart({"project.json": {}, "big.bin": bytes(5000)}).status_code, 413,
                             "an archive that unpacks past the limit")
        with patch.object(server, "_PROJECT_MAX_FILES", 2):
            self.assertEqual(self.import_chart({"project.json": {}, "a": "", "b": ""}).status_code, 413)
        self.assertEqual(list(self.runs.iterdir()), [])

    def test_imported_project_cannot_point_at_files_outside_itself(self):
        secret = self.root / "secret.txt"
        secret.write_text("private")
        stem = {"id": "mix", "name": "Full song", "audio_rel": "../../secret.txt",
                "spectrogram": {"image": "../../secret.txt", "duration": 1.0}}
        own = {"id": "own", "name": "Own", "audio_rel": "own.wav", "spectrogram": {"image": "own.png", "duration": 1.0}}
        response = self.import_chart({"project.json": {"name": "x", "stems": [stem, own],
                                                       "metadata": {"coverArt": "../../secret.txt"}},
                                      "own.wav": b"RIFF", "own.png": b"png"})
        self.assertEqual(response.status_code, 200)
        job = response.json()["job"]
        self.assertEqual(self.client.get(f"/api/audio/{job}/own").content, b"RIFF", "its own files are served")
        self.assertEqual(self.client.get(f"/api/audio/{job}/mix").status_code, 404)
        self.assertEqual(self.client.get(f"/api/spectrogram/{job}/mix.png").status_code, 404)
        self.assertEqual(self.client.get(f"/api/projects/{job}/cover").status_code, 404)
        exported = self.client.post(f"/api/projects/{job}/export", json={})
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            self.assertEqual(sorted(archive.namelist()), ["own.png", "own.wav", "project.json"], "nor packed into an export")
        self.client.delete(f"/api/projects/{job}")
        self.assertEqual(secret.read_text(), "private", "nor deleted with the project")

    def test_project_ids_cannot_be_paths(self):
        for job in ("a.b", "a b", "x..y", "%2e%2e"):
            with self.subTest(job):
                self.assertIn(self.client.get(f"/api/projects/{job}").status_code, (400, 404))
                self.assertEqual(self.client.delete(f"/api/projects/{job}").status_code, 400)
        with self.assertRaises(HTTPException):
            server._job_dir("../outside")
        self.assertEqual(server._safe_project_file(self.runs, "a/../b.wav"), (self.runs / "b.wav").resolve())
        for rel in ("", None, ".", "..", "../x", "a/../../x", str(self.root / "secret.txt")):
            with self.subTest(rel):
                self.assertIsNone(server._safe_project_file(self.runs, rel))

    def test_oversized_upload_is_refused_and_removed(self):
        target = self.root / "upload.wav"
        with self.assertRaises(HTTPException) as refused:
            server._save_upload(io.BytesIO(bytes(11)), target, limit=10)
        self.assertEqual(refused.exception.status_code, 413)
        self.assertFalse(target.exists())
        server._save_upload(io.BytesIO(bytes(10)), target, limit=10)
        self.assertEqual(target.stat().st_size, 10)

    # ---- the one place the server fetches a URL for the user ----------------
    def test_cover_art_is_only_fetched_from_public_addresses(self):
        def resolves_to(*addresses):
            return patch.object(socket, "getaddrinfo", return_value=[(None, None, None, "", (address, 443)) for address in addresses])

        for address in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fc00::1", "224.0.0.1"):
            with self.subTest(address), resolves_to(address), self.assertRaises(HTTPException):
                server._require_public_url("https://cover.example/a.png")
        with resolves_to("93.184.216.34", "10.0.0.5"), self.assertRaises(HTTPException):
            server._require_public_url("https://cover.example/a.png")      # one private address is enough
        with resolves_to("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"):
            server._require_public_url("https://cover.example/a.png")
        for url in ("file:///C:/Windows/win.ini", "ftp://cover.example/a.png", "https:///a.png", "javascript:alert(1)"):
            # Refused for what it is, wherever its host would resolve to.
            with self.subTest(url), resolves_to("93.184.216.34"), self.assertRaises(HTTPException):
                server._require_public_url(url)
        # A public host that redirects inward is checked again at every hop.
        request = urllib.request.Request("https://cover.example/a.png")
        with resolves_to("127.0.0.1"), self.assertRaises(HTTPException):
            server._PublicOnlyRedirectHandler().redirect_request(request, None, 302, "Found", {}, "http://localhost/admin")
        with resolves_to("127.0.0.1"):
            response = self.client.post("/api/projects/abc/cover-url", json={"url": "http://router.local/logo.png"})
        self.assertIn(response.status_code, (400, 404))


if __name__ == "__main__":
    unittest.main()
