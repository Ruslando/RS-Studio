import importlib.util
import shutil
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "tools/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_preview_commits_version_before_tagging_and_publishes_after_upload(self):
        calls = []
        def run(*command, **kwargs):
            calls.append(command)
            if command[:3] == ("gh", "release", "create"):
                self.assertTrue(Path(command[command.index("--notes-file") + 1]).read_text().startswith(release.SETUP_HINT))
            return ""
        with patch("sys.argv", ["release.py", "0.5.0-rc.2", "--preview"]), \
                patch.object(release, "check", return_value="release-candidate"), \
                patch.object(release, "current_version", return_value="0.5.0rc1"), \
                patch.object(release, "check_version_metadata") as metadata, \
                patch.object(release, "run", side_effect=run), patch.object(release, "set_version") as set_version, \
                patch.object(release, "build", return_value=[Path("setup.exe")]) as build:
            release.main()
        set_version.assert_called_once_with("0.5.0-rc.2")
        metadata.assert_called_once_with(expected="0.5.0-rc.2")
        self.assertEqual(build.call_args.args[0], "0.5.0-rc.2")
        self.assertEqual(build.call_args.kwargs["channel"], "preview")
        commit = next(i for i, command in enumerate(calls) if command[:2] == ("git", "commit"))
        tag = next(i for i, command in enumerate(calls) if command[:2] == ("git", "tag"))
        push = next(i for i, command in enumerate(calls) if command[:2] == ("git", "push"))
        self.assertLess(commit, tag)
        self.assertLess(tag, push)
        self.assertEqual(calls[push], ("git", "push", "origin", "release-candidate", "v0.5.0-rc.2"))
        self.assertFalse(any(command[:2] == ("git", "checkout") for command in calls))
        create = next(command for command in calls if command[:3] == ("gh", "release", "create"))
        self.assertIn("--draft", create)
        self.assertIn("--prerelease", create)
        self.assertEqual(create[3], "v0.5.0-rc.2")
        self.assertLess(push, calls.index(create))
        self.assertIn("--latest=false", calls[-1])

    def test_preview_allows_release_candidate_and_stable_requires_main(self):
        for branch, preview, allowed in [("main", False, True), ("main", True, True),
                                          ("release-candidate", True, True),
                                          ("release-candidate", False, False), ("feature", True, False)]:
            with self.subTest(branch=branch, preview=preview), \
                    patch.object(release, "check_version_metadata"), \
                    patch.object(release, "SIGNING_KEY") as key, \
                    patch.object(release.shutil, "which", return_value="gh"), \
                    patch.object(release, "run", side_effect=lambda *cmd, **kw: branch if cmd[:2] == ("git", "rev-parse") else ""):
                key.is_file.return_value = True
                args = SimpleNamespace(version="0.5.0-rc.2", prerelease=preview, dry_run=False)
                if allowed:
                    self.assertEqual(release.check(args), branch)
                else:
                    with self.assertRaisesRegex(SystemExit, "Releases are made from main"):
                        release.check(args)

    def test_version_is_set_in_all_three_files_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, _, _ in release.VERSION_FILES:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, root / name)
            before = (root / "uv.lock").read_text(encoding="utf-8")
            release.set_version("9.8.7-beta", root)
            self.assertEqual(release.check_version_metadata(root, expected="9.8.7-beta"), "9.8.7-beta")
            self.assertEqual(release.current_version(root), "9.8.7-beta")
            self.assertIn('version = "9.8.7-beta"', (root / "pyproject.toml").read_text(encoding="utf-8"))
            after = (root / "uv.lock").read_text(encoding="utf-8")
            self.assertIn('name = "rs-studio"\nversion = "9.8.7-beta"', after)
            # Only the rs-studio entry changes in the lockfile.
            self.assertEqual(sum(a != b for a, b in zip(before.splitlines(), after.splitlines())), 1)


if __name__ == "__main__":
    unittest.main()
