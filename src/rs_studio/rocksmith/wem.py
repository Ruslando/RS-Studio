"""WAV -> .wem conversion for Rocksmith export.

Windows uses a local Wwise installation. Linux uses the wwise-wem library, which encodes
WAV to Wwise 2013.2 Vorbis itself. That
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
from importlib import resources
from pathlib import Path


class AudioConverterNotFoundError(RuntimeError):
    pass


class WwiseNotFoundError(AudioConverterNotFoundError):
    pass


_YEAR_RE = r"20(?:19|2\d)"  # 2019 or newer
# WwiseConsole is a console program; from the windowed app each call would flash a window.
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _wwise_wem():
    """The pure-library WAV -> Wwise 2013.2 Vorbis encoder, or a setup error."""
    try:
        import wwise_wem
    except ImportError as exc:
        raise AudioConverterNotFoundError(
            "Linux Rocksmith export needs the wwise-wem encoder. Install Rust, then "
            "run: uv sync"
        ) from exc
    return wwise_wem


def audio_converter_status() -> dict:
    """Availability and setup details for the export dialog."""
    if sys.platform.startswith("linux"):
        try:
            _wwise_wem()
        except AudioConverterNotFoundError as exc:
            return {"found": False, "platform": "linux", "detail": str(exc)}
        return {"found": True, "platform": "linux", "detail": ""}
    try:
        console, year = find_wwise_console()
    except WwiseNotFoundError as exc:
        return {"found": False, "platform": "windows", "detail": str(exc)}
    return {"found": True, "platform": "windows", "version": year,
            "path": console, "detail": ""}


_SEEK_INTERVAL = 16384  # frames between seek points, as Wwise writes them


def add_seek_table(data: bytes) -> bytes:
    """Give a seek-table-less Wwise Vorbis file one; Rocksmith cannot rewind without it.

    wwise-wem reproduces a Wwise build that wrote no seek table. The table sits
    at the head of the data chunk: (frames, bytes) u16 pairs, each the distance
    from the previous seek point. Layout follows pas2k/wav2wem's wem.go, which
    was matched against real Wwise output.
    ponytail: assumes the two-mode setup (1 mode bit: short/long block) every
    stock Vorbis encoder writes; the frame-count check below rejects anything else.
    """
    chunks, pos = [], 12
    while pos + 8 <= len(data):
        size = struct.unpack_from("<I", data, pos + 4)[0]
        chunks.append((data[pos:pos + 4], bytearray(data[pos + 8:pos + 8 + size])))
        pos += 8 + size + (size & 1)
    fmt = next(body for tag, body in chunks if tag == b"fmt ")
    payload = next(body for tag, body in chunks if tag == b"data")
    if len(fmt) != 0x42 or struct.unpack_from("<I", fmt, 0x28)[0] != 0:
        raise RuntimeError("Unexpected WEM layout; cannot add a seek table")
    total_frames, = struct.unpack_from("<I", fmt, 0x18)
    extra, = struct.unpack_from("<H", fmt, 0x32)
    blocks = (1 << fmt[0x40], 1 << fmt[0x41])

    table = bytearray()
    frames = last_frames = last_offset = 0
    previous = None
    offset = 2 + struct.unpack_from("<H", payload, 0)[0]  # skip the setup packet
    while offset + 2 <= len(payload):
        size, = struct.unpack_from("<H", payload, offset)
        block = blocks[payload[offset + 2] & 1] if size else blocks[0]
        if previous is not None:
            frames += (previous + block) // 4
        previous = block
        if frames - last_frames >= _SEEK_INTERVAL:
            table += struct.pack("<HH", frames - last_frames, offset - last_offset)
            last_frames, last_offset = frames, offset
        offset += 2 + size
    if offset != len(payload) or frames - extra != total_frames:
        raise RuntimeError("WEM packets do not add up to the declared length; no seek table added")

    struct.pack_into("<I", fmt, 0x28, len(table))
    struct.pack_into("<I", fmt, 0x2C, struct.unpack_from("<I", fmt, 0x2C)[0] + len(table))
    payload[:0] = table
    body = b"WAVE" + b"".join(
        tag + struct.pack("<I", len(chunk)) + chunk + b"\0" * (len(chunk) & 1) for tag, chunk in chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def convert_to_wem_linux(wav_path: Path) -> bytes:
    """Encode via wwise-wem, which only takes 16-bit stereo at 48 kHz, so FFmpeg normalises first."""
    wwise_wem = _wwise_wem()
    with tempfile.TemporaryDirectory(prefix="rs-wem-") as tmp:
        source = Path(tmp) / "audio.wav"
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(wav_path),
             "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(source)],
            capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed (exit {proc.returncode}): "
                               f"{proc.stderr or 'no output'}")
        return add_seek_table(bytes(wwise_wem.encode(str(source)).data))


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

    Linux uses wwise-wem. Windows needs an installed WwiseConsole;
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
            capture_output=True, text=True, timeout=600, creationflags=_NO_WINDOW)
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
                       capture_output=True, text=True, timeout=600, creationflags=_NO_WINDOW)

        cmd = [
            console, "generate-soundbank", str(project),
            "--platform", "Windows", "--language", "English(US)",
            "--no-decode", "--quiet",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, creationflags=_NO_WINDOW)
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
