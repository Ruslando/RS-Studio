"""Stable resource and data locations for source, portable and bootstrap installs."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def resource_root() -> Path:
    external = os.environ.get("RS_STUDIO_APP_ROOT")
    if external:
        return Path(external).resolve()
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))


def data_root() -> Path:
    external = os.environ.get("RS_STUDIO_DATA_ROOT")
    if external:
        return Path(external).resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]
