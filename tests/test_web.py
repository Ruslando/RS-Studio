"""The browser code, checked without a browser.

Runs every tests/web/*.test.mjs under Node, so they are part of the one test
command, and scans all of web/ for names that are used but defined nowhere: a
helper deleted from one file while its callers stayed only fails when somebody
clicks the button that reaches it.
"""
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Loaded by <script> tags in index.html, not imported.
PAGE_GLOBALS = {"Tone", "alphaTab"}
# TypeScript's "cannot find name", "no such export" and "no such module".
BROKEN_NAME = re.compile(r"^(web[\\/](?!vendor)\S+\(\d+,\d+\)): error TS(?:2304|2552|2305|2307|2724): (.*)$", re.M)


def _run(*command):
    # shutil.which finds npx.cmd on Windows, which a bare name does not.
    return subprocess.run([shutil.which(command[0]) or command[0], *command[1:]], cwd=ROOT,
                          capture_output=True, text=True, encoding="utf-8", errors="replace")


class WebTests(unittest.TestCase):
    def test_node_tests(self):
        files = sorted((ROOT / "tests/web").glob("*.test.mjs"))
        self.assertTrue(files)
        for file in files:
            with self.subTest(file.name):
                result = _run("node", str(file))
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_every_name_used_in_web_is_defined(self):
        result = _run("npx", "--yes", "--package", "typescript@5.6.3", "tsc", "--allowJs", "--checkJs", "--noEmit",
                      "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
                      "--lib", "es2023,dom,dom.iterable,webworker", "web/main.js", "web/voicing-worker.js")
        # Type errors are expected (the code carries no types); a run that printed
        # none at all did not run.
        self.assertIn("error TS", result.stdout, result.stdout + result.stderr)
        broken = [f"{where}: {what}" for where, what in BROKEN_NAME.findall(result.stdout)
                  if not any(f"'{name}'" in what for name in PAGE_GLOBALS)]
        self.assertEqual(broken, [])


if __name__ == "__main__":
    unittest.main()
