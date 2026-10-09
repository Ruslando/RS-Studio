import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "tools/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_version_is_set_in_all_three_files_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, _, _ in release.VERSION_FILES:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, root / name)
            before = (root / "uv.lock").read_text(encoding="utf-8")
            release.set_version("9.8.7-beta", root)
            self.assertEqual(release.current_version(root), "9.8.7-beta")
            self.assertIn('version = "9.8.7-beta"', (root / "pyproject.toml").read_text(encoding="utf-8"))
            after = (root / "uv.lock").read_text(encoding="utf-8")
            self.assertIn('name = "rs-studio"\nversion = "9.8.7-beta"', after)
            # Only the rs-studio entry changes in the lockfile.
            self.assertEqual(sum(a != b for a, b in zip(before.splitlines(), after.splitlines())), 1)


if __name__ == "__main__":
    unittest.main()
