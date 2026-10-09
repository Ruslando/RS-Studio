import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rs_studio.paths import data_root, resource_root


class InstallationPathTests(unittest.TestCase):
    def test_bootstrap_resources_and_data_are_independent_of_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "versions/app/v2"
            data = Path(tmp) / "data"
            with patch.dict(os.environ, {"RS_STUDIO_APP_ROOT": str(app), "RS_STUDIO_DATA_ROOT": str(data)}):
                self.assertEqual(resource_root(), app.resolve())
                self.assertEqual(data_root(), data.resolve())

    def test_portable_build_keeps_existing_paths(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            with patch.object(sys, "frozen", True, create=True), patch.object(sys, "_MEIPASS", str(Path(tmp) / "_internal"), create=True), patch.object(sys, "executable", str(Path(tmp) / "RS Studio.exe")):
                self.assertEqual(resource_root(), Path(tmp) / "_internal")
                self.assertEqual(data_root(), Path(tmp))


if __name__ == "__main__":
    unittest.main()
