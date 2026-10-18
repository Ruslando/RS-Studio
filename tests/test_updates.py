import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rs_studio import updates


class UpdateTests(unittest.TestCase):
    def test_channel_api_saves_preferences_and_rejects_unknown_channels(self):
        from fastapi.testclient import TestClient
        from rs_studio.server import app
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"RS_STUDIO_DATA_ROOT": tmp}, clear=True):
            client = TestClient(app, base_url="http://127.0.0.1:8000")
            self.assertEqual(client.get("/api/update/channel").json()["channel"], "stable")
            response = client.post("/api/update/channel", json={"channel": "preview"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(client.get("/api/update/channel").json()["channel"], "preview")
            self.assertEqual(client.post("/api/update/channel", json={"channel": []}).status_code, 400)
            self.assertEqual(client.get("/api/update/channel").json()["channel"], "preview")

    def test_versions_compare_as_releases(self):
        self.assertTrue(updates._newer("0.1.2-alpha", "0.1.1-alpha"))
        self.assertTrue(updates._newer("0.2.0", "0.1.9"))
        self.assertFalse(updates._newer("0.1.1-alpha", "0.1.1-alpha"))
        self.assertFalse(updates._newer("0.1.0", "0.1.1-alpha"))

    def test_source_runs_cannot_install_but_learn_of_a_new_release(self):
        for latest, available in (("9.0.0", True), (updates.__version__, False)):
            with patch.dict(os.environ, {}, clear=True), \
                    patch.object(updates, "_latest_release", return_value={"latest": latest, "notes": "New"}):
                state = updates.check()
            self.assertEqual((state["supported"], state["can_install"], state["available"]), (False, False, available))

    def test_installation_config_and_launcher_are_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "bootstrap-release.json").write_text(json.dumps({"manifest_url": "https://example.com/m.json"}))
            env = {"RS_STUDIO_INSTALL_ROOT": tmp, "RS_STUDIO_LAUNCHER": json.dumps(["RS Studio.exe"])}
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(updates._config()["manifest_url"], "https://example.com/m.json")
                self.assertEqual(updates._launcher(), ["RS Studio.exe"])

    def test_runtime_reports_the_installed_build_and_whether_cuda_can_be_added(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(updates.runtime(), {"supported": False})  # a source run
        runtimes = {"core": {"download_bytes": 100}, "cuda": {"download_bytes": 350, "cuda_archs": [86]}}
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "current.json").write_text(json.dumps({"payload": {"runtimes": runtimes}, "runtime": "core"}))
            env = {"RS_STUDIO_INSTALL_ROOT": tmp, "RS_STUDIO_LAUNCHER": json.dumps(["RS Studio"])}
            for launcher_version, can_install in ((2, False), (3, True)):  # --runtime exists from launcher 3
                Path(tmp, "bootstrap-release.json").write_text(json.dumps({"launcher_version": launcher_version}))
                with patch.dict(os.environ, env, clear=True):
                    state = updates.runtime()
                self.assertEqual((state["runtime"], state["can_install"]), ("core", can_install))
                self.assertEqual(state["cuda"]["extra_bytes"], 250)
                self.assertIn("useful", state["cuda"])

    def test_update_without_launcher_is_refused(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(RuntimeError):
            updates.start_install()

    def test_channel_is_persisted_without_changing_installer_trust(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"RS_STUDIO_INSTALL_ROOT": tmp}, clear=True):
            path = Path(tmp, "bootstrap-release.json")
            config = {"launcher_version": 4, "manifest_url": "https://example.com/m.json", "public_key": {"n": "trusted"}}
            path.write_text(json.dumps(config))
            self.assertEqual(updates.channel_state()["channel"], "stable")
            self.assertEqual(updates.set_channel("preview")["channel"], "preview")
            self.assertEqual(json.loads(path.read_text()), {**config, "channel": "preview"})
            self.assertEqual(updates.set_channel("stable")["channel"], "stable")

    def test_old_launcher_and_invalid_channel_are_rejected(self):
        with patch.object(updates, "_config", return_value={"launcher_version": 3}):
            self.assertFalse(updates.channel_state()["can_change_channel"])
            with self.assertRaises(RuntimeError):
                updates.set_channel("preview")
            for invalid in ("nightly", None, []):
                with self.assertRaises(ValueError):
                    updates.set_channel(invalid)

    def test_source_channel_survives_restart(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"RS_STUDIO_DATA_ROOT": tmp}, clear=True):
            updates.set_channel("preview")
            self.assertEqual(updates.channel_state(), {"channel": "preview", "can_change_channel": True})

    def test_returning_to_regular_releases_offers_older_stable(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"RS_STUDIO_INSTALL_ROOT": tmp}, clear=True):
            Path(tmp, "bootstrap-release.json").write_text(json.dumps({"launcher_version": 4, "channel": "stable"}))
            Path(tmp, "current.json").write_text(json.dumps({"payload": {"channel": "preview"}}))
            with patch.object(updates, "_installer") as installer:
                installer.return_value.fetch_manifest.return_value = {"payload": {"version": "0.2.3-alpha"}}
                self.assertTrue(updates.check()["available"])
                Path(tmp, "current.json").write_text(json.dumps({"payload": {"channel": "stable"}}))
                self.assertFalse(updates.check()["available"])


if __name__ == "__main__":
    unittest.main()
