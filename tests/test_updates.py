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

    def test_source_runs_report_unsupported(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(updates.check()["supported"])

    def test_installation_config_and_launcher_are_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "bootstrap-release.json").write_text(json.dumps({"manifest_url": "https://example.com/m.json"}))
            env = {"RS_STUDIO_INSTALL_ROOT": tmp, "RS_STUDIO_LAUNCHER": json.dumps(["RS Studio.exe"])}
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(updates._config()["manifest_url"], "https://example.com/m.json")
                self.assertEqual(updates._launcher(), ["RS Studio.exe"])

    def test_update_without_launcher_is_refused(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(RuntimeError):
            updates.start_install()


if __name__ == "__main__":
    unittest.main()
