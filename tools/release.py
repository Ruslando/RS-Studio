"""Publish a release in one step: version, tag, packages, setup EXE and GitHub release.

    build/cpu-venv/Scripts/python tools/release.py 0.2.2-alpha --notes notes.txt
    build/cpu-venv/Scripts/python tools/release.py 0.2.2-alpha --dry-run   # build only

Needs the GitHub CLI (winget install GitHub.cli; gh auth login), the release
signing key, staged FFmpeg (tools/fetch-ffmpeg.py) and this build environment.
Nothing is pushed or published until every build step has succeeded.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_URL = "https://github.com/Ruslando/RS-Studio"
SIGNING_KEY = ROOT / ".local-tools/bootstrap-signing-key.pem"
# sm_ architectures compiled into the cu126 PyTorch wheels (torch._C._cuda_getArchFlags()).
CUDA_ARCHS = "50,60,61,70,75,80,86,90"
VERSION = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$")
SETUP_HINT = "Download **RS-Studio-Setup.exe**. The other files are downloaded by the setup."
# (file, pattern, replacement template); each pattern must match exactly once.
VERSION_FILES = (
    ("pyproject.toml", r'(?m)^version = "[^"]+"$', 'version = "{}"'),
    ("src/rs_studio/__init__.py", r'(?m)^__version__ = "[^"]+"$', '__version__ = "{}"'),
    ("uv.lock", r'(name = "rs-studio"\nversion = )"[^"]+"', r'\g<1>"{}"'),
)


def run(*command, capture=False, env=None) -> str:
    print("$", " ".join(str(part) for part in command), flush=True)
    result = subprocess.run([str(part) for part in command], cwd=ROOT, check=True, text=True,
                            capture_output=capture, env=env)
    return result.stdout.strip() if capture else ""


def current_version(root: Path = ROOT) -> str:
    return re.search(r'(?m)^__version__ = "([^"]+)"$', (root / "src/rs_studio/__init__.py").read_text(encoding="utf-8"))[1]


def set_version(version: str, root: Path = ROOT) -> None:
    for name, pattern, template in VERSION_FILES:
        path = root / name
        text, count = re.subn(pattern, template.format(version), path.read_text(encoding="utf-8"), count=1)
        if count != 1:
            raise SystemExit(f"Version not found in {name}")
        path.write_bytes(text.encode("utf-8"))


def check(args) -> None:
    if not VERSION.fullmatch(args.version):
        raise SystemExit(f"Invalid version: {args.version}")
    if run("git", "rev-parse", "--abbrev-ref", "HEAD", capture=True) != "main":
        raise SystemExit("Releases are made from main.")
    if run("git", "status", "--porcelain", capture=True):
        raise SystemExit("Commit or stash your changes first.")
    if not SIGNING_KEY.is_file():
        raise SystemExit(f"Signing key missing: {SIGNING_KEY}")
    tag = "v" + args.version
    if run("git", "ls-remote", "--tags", "origin", tag, capture=True):
        raise SystemExit(f"{tag} already exists on GitHub.")
    if not args.dry_run:
        if not shutil.which("gh"):
            raise SystemExit("GitHub CLI missing: winget install GitHub.cli, then gh auth login")
        run("gh", "auth", "status", capture=True)
    run(sys.executable, "-m", "unittest", "discover", "-s", "tests", capture=True)


def build(version: str, notes: Path | None) -> list[Path]:
    output, launcher = ROOT / "dist/bootstrap-release", ROOT / "dist/bootstrap-launcher"
    shutil.rmtree(output, ignore_errors=True)
    shutil.rmtree(launcher, ignore_errors=True)
    package = [sys.executable, "tools/package-bootstrap.py", "--version", version, "--signing-key", SIGNING_KEY,
               "--base-url", f"{REPO_URL}/releases/download/v{version}", "--cuda-archs", CUDA_ARCHS, "--output", output]
    run(*package, *(["--notes", notes] if notes else []))
    run(sys.executable, "-m", "PyInstaller", "rs-bootstrap.spec", "--noconfirm", "--distpath", launcher,
        "--workpath", ROOT / "build/bootstrap-launcher",
        env={**os.environ, "RS_BOOTSTRAP_CONFIG": str(output / "bootstrap-release.json")})
    # GitHub turns spaces in asset names into dots; give the setup a clean name.
    setup = output / "RS-Studio-Setup.exe"
    shutil.copy2(launcher / "RS Studio Setup.exe", setup)
    return [setup, output / "bootstrap-manifest.json", output / f"RS-Studio-app-{version}.zip",
            output / "RS-Studio-ffmpeg-windows-x64.zip"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", help="e.g. 0.2.2-alpha (tag v0.2.2-alpha)")
    parser.add_argument("--notes", type=Path, help="Release notes (plain text): shown in the app's update dialog and on GitHub")
    parser.add_argument("--dry-run", action="store_true", help="Build everything, publish nothing")
    args = parser.parse_args()
    check(args)
    tag = "v" + args.version
    bump = current_version() != args.version
    if bump:
        set_version(args.version)
        run("uv", "lock", "--locked")  # the lockfile edit must still match pyproject.toml
    try:
        assets = build(args.version, args.notes)
    except BaseException:
        if bump:
            run("git", "checkout", "--", *(name for name, _, _ in VERSION_FILES))
        raise
    if args.dry_run:
        if bump:
            run("git", "checkout", "--", *(name for name, _, _ in VERSION_FILES))
        print("\nDry run: built", *assets, sep="\n  ")
        return
    if bump:
        run("git", "commit", "-m", f"chore(release): bump version to {args.version}", "--", *(name for name, _, _ in VERSION_FILES))
    run("git", "tag", tag)
    run("git", "push", "origin", "main", tag)
    notes = args.notes.read_text(encoding="utf-8").strip() if args.notes else ""
    body = SETUP_HINT + ("\n\n" + notes if notes else "")
    run("gh", "release", "create", tag, *assets, "--title", tag, "--notes", body, "--latest", "--verify-tag")
    print(f"\nPublished {REPO_URL}/releases/tag/{tag}")


if __name__ == "__main__":
    main()
