import importlib.util
import shutil
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "tools/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_preview_publishes_only_after_upload_and_restores_project_version(self):
        calls = []
        def run(*command, **kwargs):
            calls.append(command)
            if command[:3] == ("gh", "release", "create"):
                self.assertTrue(Path(command[command.index("--notes-file") + 1]).read_text().startswith(release.SETUP_HINT))
            return ""
        with patch("sys.argv", ["release.py", "0.5.0-rc.1", "--preview"]), patch.object(release, "check"), \
                patch.object(release, "run", side_effect=run), patch.object(release, "set_version") as set_version, \
                patch.object(release, "build", return_value=[Path("setup.exe")]) as build:
            release.main()
        set_version.assert_called_once_with("0.5.0-rc.1")
        self.assertEqual(build.call_args.args[0], "0.5.0-rc.1")
        self.assertEqual(build.call_args.kwargs["channel"], "preview")
        self.assertFalse(any(command[:2] == ("git", "commit") for command in calls))
        self.assertTrue(any(command[:2] == ("git", "checkout") for command in calls))
        create = next(command for command in calls if command[:3] == ("gh", "release", "create"))
        self.assertIn("--draft", create)
        self.assertIn("--prerelease", create)
        self.assertEqual(create[3], "v0.5.0-rc.1")
        self.assertIn("--latest=false", calls[-1])

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
