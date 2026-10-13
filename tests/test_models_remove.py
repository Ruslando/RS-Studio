import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rs_studio import models


class RemoveModelTests(unittest.TestCase):
    def test_remove_deletes_files_and_partials_and_reads_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            weights, config = Path(tmp) / "model.ckpt", Path(tmp) / "model.yaml"
            weights.write_bytes(b"w")
            config.with_name("model.yaml.part").write_bytes(b"c")
            catalog = [{"id": "x", "label": "X", "kind": "Stem separation", "url": "https://example.invalid/x",
                        "files": [weights, config]},
                       # With files of its own, so only the bundled rule can refuse it.
                       {"id": "lib", "label": "Lib", "kind": "Note detection", "bundled": True,
                        "files": [Path(tmp) / "lib.bin"]}]
            with patch.object(models, "_catalog", return_value=catalog):
                models.remove("x")
                self.assertEqual(list(Path(tmp).iterdir()), [])
                self.assertEqual(models.status()[0]["state"], "missing")
                with self.assertRaises(KeyError):
                    models.remove("lib")  # ships inside a library
                with self.assertRaises(KeyError):
                    models.remove("nope")

    def test_remove_refuses_a_running_download(self):
        catalog = [{"id": "x", "label": "X", "kind": "Stem separation", "url": "https://example.invalid/x",
                    "files": [Path("unused")]}]
        with patch.object(models, "_catalog", return_value=catalog), patch.dict(models._jobs, {"x": {"state": "running"}}):
            with self.assertRaises(RuntimeError):
                models.remove("x")


if __name__ == "__main__":
    unittest.main()
