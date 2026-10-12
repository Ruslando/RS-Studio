import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rs_studio import updates


class UpdateTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
