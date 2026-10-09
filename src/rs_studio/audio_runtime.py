"""Locate staged or bundled FFmpeg without importing the audio/ML stack."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Closing a handle unregisters its DLL directory on Windows.
_DLL_DIRECTORIES: dict[Path, object] = {}


def prepare_ffmpeg() -> Path | None:
    """Expose local FFmpeg executables and shared libraries; never download them."""
    if os.environ.get("RS_STUDIO_FFMPEG"):  # set by the bootstrap installer
        candidates = [Path(os.environ["RS_STUDIO_FFMPEG"])]
    elif getattr(sys, "frozen", False):
        candidates = [
            Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "ffmpeg",
            Path(sys.executable).resolve().parent / "ffmpeg",
        ]
    else:
        candidates = [Path(__file__).resolve().parents[2] / "vendor" / "ffmpeg"]
    executable = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    for candidate in candidates:
        if not (candidate / executable).is_file():
            continue
        directory = candidate.resolve()
        path = os.environ.get("PATH", "")
        entries = path.split(os.pathsep)
        entries = [entry for entry in entries if os.path.normcase(entry) != os.path.normcase(str(directory))]
        os.environ["PATH"] = os.pathsep.join([str(directory), *entries])
        if hasattr(os, "add_dll_directory") and directory not in _DLL_DIRECTORIES:
            _DLL_DIRECTORIES[directory] = os.add_dll_directory(str(directory))
        return directory
    return None
