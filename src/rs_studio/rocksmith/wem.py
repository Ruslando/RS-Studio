"""WAV -> .wem conversion for Rocksmith export.

Windows uses a local Wwise installation. Linux uses native oggenc to make
Vorbis audio, then wav2wem's OGG input to wrap it as Wwise Vorbis. The latter
path is experimental until its output has been checked in Rocksmith 2014.

Rocksmith2014.NET's Wwise.fs extracts a template project it ships. This asks the
user's own Wwise to make one instead — `WwiseConsole create-new-project` — then
drops the wav in Originals/SFX, runs generate-soundbank, and picks the converted
wem out of .cache.

WHY NOT BUNDLE THE WHOLE PROJECT, which is one fewer moving part: a Wwise
project is mostly Audiokinetic's, not ours. Even an empty one carries their
Factory Conversion Settings work unit, and redistributing SDK and tool material
is what their licence restricts. The Windows path uses the user's own install.

Only two project work units are bundled now. They were copied byte-for-byte
from the former Wwise 2023 template ZIP, rather than authored from scratch here:
res/music-hierarchy.wwu (a streaming, zero-latency music track whose custom
conversion is mono 48 kHz Vorbis with SeekTableGranularity 4 — the encoding
Rocksmith will read) and res/soundbanks.wwu (a bank containing it). Two XML
files, 7.5 KB, replacing four zips of 170 KB.

The work units are written at their authored schema version, so a newer Wwise
has to migrate them into the project it just made. `migrate` reports a non-zero
exit when it changes something, which is the normal path rather than a failure —
so the conversion below is what decides whether it worked, not that code.

Wwise itself is a free download (non-commercial license) from audiokinetic.com.
"""
from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from importlib import resources
from pathlib import Path


class AudioConverterNotFoundError(RuntimeError):
    pass


class WwiseNotFoundError(AudioConverterNotFoundError):
    pass


_YEAR_RE = r"20(?:19|2\d)"  # 2019 or newer


def find_linux_encoders() -> tuple[str, str]:
    """Return native oggenc and wav2wem executables from PATH."""
    oggenc = shutil.which("oggenc")
    wav2wem = shutil.which("wav2wem")
    missing = [name for name, path in (("oggenc", oggenc), ("wav2wem", wav2wem))
               if path is None]
    if missing:
        raise AudioConverterNotFoundError(
            "Linux Rocksmith export needs " + " and ".join(missing) +
            " on PATH. Install vorbis-tools for oggenc and build wav2wem "
            "(github.com/pas2k/wav2wem) with Go."
        )
    return oggenc, wav2wem


def audio_converter_status() -> dict:
    """Availability and setup details for the export dialog."""
    if sys.platform.startswith("linux"):
        try:
            find_linux_encoders()
        except AudioConverterNotFoundError as exc:
            return {"found": False, "platform": "linux", "detail": str(exc)}
        return {"found": True, "platform": "linux", "detail": ""}
    try:
        console, year = find_wwise_console()
    except WwiseNotFoundError as exc:
        return {"found": False, "platform": "windows", "detail": str(exc)}
    return {"found": True, "platform": "windows", "version": year,
            "path": console, "detail": ""}


def convert_to_wem_linux(wav_path: Path) -> bytes:
    """Encode via native oggenc, then pack the OGG with wav2wem."""
    oggenc, wav2wem = find_linux_encoders()
    with wave.open(str(wav_path), "rb") as source:
        channels = source.getnchannels()
    if channels not in (1, 2):
        raise ValueError("Linux Rocksmith export needs mono or stereo audio")
    with tempfile.TemporaryDirectory(prefix="rs-wem-") as tmp:
        ogg = Path(tmp) / "audio.ogg"
        output = Path(tmp) / "audio.wem"
        encode = [oggenc, "--quiet"]
        if channels == 2:
            encode.append("--downmix")
        encode.extend(["--resample", "48000", "-q", "4", "-o", str(ogg),
                       str(wav_path)])
        for command, name in (
            (encode, "oggenc"),
            ([wav2wem, "-o", str(output), str(ogg)], "wav2wem"),
        ):
            proc = subprocess.run(command, capture_output=True, text=True, timeout=600)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"{name} failed (exit {proc.returncode}): "
                    f"{proc.stderr or proc.stdout or 'no output'}")
        if not output.is_file():
            raise RuntimeError("wav2wem ran but produced no .wem file")
        data = bytearray(output.read_bytes())
        if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE" \
                or data[12:16] != b"fmt ":
            raise RuntimeError("wav2wem produced an invalid WEM header")
        # Match the Rocksmith header adjustment used for Wwise output below.
        data[40:44] = struct.pack("<I", 3)
        return bytes(data)


def find_wwise_console() -> tuple[str, str]:
    """Returns (WwiseConsole.exe path, version year)."""
    candidates = []
    root = os.environ.get("WWISEROOT")
    if root and os.path.isdir(root):
        candidates.append(root)
    bases = [Path(b) / "Audiokinetic" for b in
             (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")) if b]
    # The Audiokinetic Launcher's default install root is <drive>:\Audiokinetic.
    bases.append(Path(os.environ.get("SystemDrive", "C:") + "\\") / "Audiokinetic")
    for ak in bases:
        if ak.is_dir():
            candidates.extend(str(p) for p in sorted(ak.iterdir(), reverse=True))
    for c in candidates:
        m = re.search(_YEAR_RE, os.path.basename(c) or c)
        if not m:
            continue
        exe = Path(c) / "Authoring" / "x64" / "Release" / "bin" / "WwiseConsole.exe"
        if exe.is_file():
            return str(exe), m.group(0)
    raise WwiseNotFoundError(
        "Wwise 2019 or newer not found (checked WWISEROOT, Program Files\\Audiokinetic "
        "and C:\\Audiokinetic). Install it free via the Audiokinetic Launcher to enable "
        ".wem audio conversion."
    )


def convert_to_wem(wav_path: Path, console: str | None = None) -> bytes:
    """Encode a WAV into the WEM bytes a Rocksmith psarc holds.

    Linux uses oggenc + wav2wem. Windows needs an installed WwiseConsole;
    `console` overrides discovery and provides the Wwise version year.
    """
    if sys.platform.startswith("linux"):
        return convert_to_wem_linux(wav_path)
    if console is None:
        console, year = find_wwise_console()
    else:
        m = re.search(_YEAR_RE, console)
        year = m.group(0) if m else "2021"
    workdir = Path(tempfile.mkdtemp(prefix="cw-wwise-"))
    try:
        # Wwise refuses a project whose file is not inside a folder of the same
        # name, so the project is <workdir>/Template/Template.wproj and not
        # <workdir>/Template.wproj.
        project = workdir / "Template" / "Template.wproj"
        made = subprocess.run(
            [console, "create-new-project", str(project), "--quiet"],
            capture_output=True, text=True, timeout=600)
        if made.returncode != 0 or not project.exists():
            raise RuntimeError(
                f"Wwise {year} could not create a template project "
                f"(exit {made.returncode}): {made.stdout or made.stderr or 'no output'}")

        res = resources.files(__package__).joinpath("res")
        for name, unit in (("Interactive Music Hierarchy", "music-hierarchy.wwu"),
                           ("SoundBanks", "soundbanks.wwu")):
            dest = project.parent / name / "Default Work Unit.wwu"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(res.joinpath(unit).read_bytes())

        sfx = project.parent / "Originals" / "SFX"
        sfx.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(wav_path, sfx / "Audio.wav")

        # Bring the injected work units up to this Wwise's schema. Its exit code is
        # not a verdict — it returns non-zero having migrated successfully — so the
        # only check that means anything is whether a wem comes out below.
        subprocess.run([console, "migrate", str(project), "--quiet"],
                       capture_output=True, text=True, timeout=600)

        cmd = [
            console, "generate-soundbank", str(project),
            "--platform", "Windows", "--language", "English(US)",
            "--no-decode", "--quiet",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        # 2019-2023 write .cache/Windows/SFX/*.wem; 2024+ use hashed .cache
        # subfolders — recurse to cover both layouts.
        cache = project.parent / ".cache"
        wems = sorted(cache.rglob("*.wem")) if cache.is_dir() else []
        if proc.returncode != 0 and not wems:
            raise RuntimeError(
                f"Wwise conversion failed (exit {proc.returncode}): "
                f"{proc.stdout or proc.stderr or 'no output'}")
        if not wems:
            raise RuntimeError("Wwise ran but produced no .wem file")

        data = bytearray(wems[0].read_bytes())
        # Rocksmith compatibility fix (Wwise.fs fixHeader): force header field to 3.
        data[40:44] = struct.pack("<I", 3)
        return bytes(data)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
