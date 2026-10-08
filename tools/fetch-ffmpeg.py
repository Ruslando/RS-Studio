"""Stage the FFmpeg binaries the desktop build bundles into vendor/ffmpeg/.

    python tools/fetch-ffmpeg.py

The app shells out to ffmpeg.exe for audio decoding, and the PyInstaller spec
packs whatever it finds in vendor/ffmpeg/ into the frozen build. The binaries
are too large to commit, so this fetches them.

FFmpeg licensing depends on its build configuration. This project stages only
LGPL builds for the desktop package and records the URL, binary version and
configure flags in vendor/ffmpeg/build-record.json.

This does not trust the URL. It downloads, then reads the configure flags
out of the binary itself and REFUSES to install a build that is not LGPL. Point
--url at any FFmpeg archive you like — the gate is the same.
"""
from __future__ import annotations

import argparse
import io
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

# BtbN publishes GPL and LGPL variants. Use FFmpeg 8 shared libraries:
# the pinned TorchCodec release supports FFmpeg 4-8, not master/FFmpeg 9.
# "shared" gives loose .dll files rather than one static exe, which is also what
# satisfies the LGPL relink duty — a user can swap a library for their own.
# Rolling builds can change. The generated build-record.json identifies the
# exact executable staged for a particular desktop release.
DEFAULT_URL = ("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
               "ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip")

OUT = Path("vendor/ffmpeg")

# Flags and components excluded by this LGPL-only staging recipe. This is not the complete
# list of GPL-capable components in FFmpeg; the --enable-gpl flag covers
# components that are not individually named here.
GPL_FLAGS = ("--enable-gpl", "--enable-nonfree")
GPL_LIBS = ("libx264", "libx265", "libxavs2", "libxvid", "librubberband",
            "libvidstab", "frei0r")


def fetch(url: str) -> bytes:
    print("fetching %s" % url)
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    print("  %.1f MB" % (len(data) / 1e6))
    return data


def extract(data: bytes, url: str, into: Path) -> None:
    """Pull the archive's bin/ payload and its license text into `into`, flat."""
    if url.endswith(".zip"):
        archive = zipfile.ZipFile(io.BytesIO(data))
        names = archive.namelist()
        read = archive.read
    else:
        archive = tarfile.open(fileobj=io.BytesIO(data))
        names = archive.getnames()
        read = lambda n: archive.extractfile(n).read()  # noqa: E731

    wanted = [n for n in names
              if "/bin/" in n and not n.endswith("/")
              or n.rsplit("/", 1)[-1] in ("LICENSE.txt", "LICENSE", "COPYING.LGPLv3")]
    if not wanted:
        sys.exit("archive has no bin/ directory — is this an FFmpeg build?")

    for name in wanted:
        target = into / name.rsplit("/", 1)[-1]
        target.write_bytes(read(name))
    print("  extracted %d files" % len(wanted))


def configuration(exe: Path) -> str:
    """The configure flags the binary was built with, from its own banner."""
    out = subprocess.run([str(exe), "-hide_banner", "-version"],
                         capture_output=True, text=True, timeout=60).stdout
    match = re.search(r"^\s*configuration:\s*(.+)$", out, re.M)
    if not match:
        sys.exit("could not read configure flags from %s" % exe.name)
    return match.group(1)


def build_string(exe: Path) -> str:
    out = subprocess.run([str(exe), "-hide_banner", "-version"],
                         capture_output=True, text=True, timeout=60).stdout
    match = re.search(r"ffmpeg version (\S+)", out)
    return match.group(1) if match else "unknown"


def check_lgpl(flags: str) -> list[str]:
    """Every reason this build may not ship. Empty list means it is clean."""
    problems = [f for f in GPL_FLAGS if f in flags]
    problems += ["--enable-%s" % lib for lib in GPL_LIBS
                 if "--enable-%s" % lib in flags]
    return problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=DEFAULT_URL,
                        help="archive to fetch (default: BtbN FFmpeg 8.1 win64 LGPL shared)")
    parser.add_argument("--keep-gpl", action="store_true",
                        help="install even if the build is GPL. You are then "
                             "responsible for the licensing of what you ship.")
    args = parser.parse_args()

    if not Path("pyproject.toml").exists():
        sys.exit("run this from the repository root")

    data = fetch(args.url)
    with tempfile.TemporaryDirectory() as temp:
        staging = Path(temp)
        extract(data, args.url, staging)

        exes = [p for p in staging.iterdir() if p.stem == "ffmpeg"]
        if not exes:
            sys.exit("no ffmpeg executable in the archive")
        exe = exes[0]
        if not exe.suffix:                      # POSIX build: needs +x to run
            exe.chmod(0o755)

        flags = configuration(exe)
        version = build_string(exe)
        if not any(p.name.startswith("avcodec-") and p.suffix == ".dll"
                   for p in staging.iterdir()):
            sys.exit("archive must contain shared FFmpeg DLLs for TorchCodec")
        if not (staging / "avcodec-62.dll").exists():
            sys.exit("this desktop recipe requires FFmpeg 8 (avcodec-62.dll)")
        problems = check_lgpl(flags)

        print("\nbuild:   %s" % version)
        if problems:
            print("license: GPL — %s" % ", ".join(problems))
            if not args.keep_gpl:
                sys.exit("\nREFUSED. This desktop recipe stages LGPL builds only.\n"
                         "Nothing was written to %s.\n"
                         "Fetch an LGPL build, or pass --keep-gpl if you know\n"
                         "what you are doing and will document the changed licensing."
                         % OUT)
            print("         installing anyway (--keep-gpl)")
        else:
            print("license: LGPL — no GPL component enabled")

        license_files = [p for p in staging.iterdir()
                         if p.name in {"LICENSE.txt", "LICENSE", "COPYING.LGPLv3"}]
        if not license_files:
            sys.exit("archive has no license text; refusing to stage the build")
        (staging / "build-record.json").write_text(json.dumps({
            "download_url": args.url,
            "ffmpeg_version": version,
            "configuration": flags,
            "executable_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
            "lgpl_configuration": not bool(problems),
            "source_information": "https://github.com/BtbN/FFmpeg-Builds",
        }, indent=2) + "\n", encoding="utf-8")

        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.iterdir():
            old.unlink()
        for item in staging.iterdir():
            shutil.move(str(item), str(OUT / item.name))

    print("\n-> %s" % OUT)
    print("\nBuild provenance is recorded in vendor/ffmpeg/build-record.json.")
    print("\nconfigure flags, for that record:\n  %s" % flags)


if __name__ == "__main__":
    main()
