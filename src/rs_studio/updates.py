"""Update check and start for installations made by RS Studio Setup.

The launcher passes the installation folder (RS_STUDIO_INSTALL_ROOT) and its
own command (RS_STUDIO_LAUNCHER). The check reuses the setup's verifier
(bootstrap/installer.py, shipped in the app package) on the signed manifest of
the latest release. Source runs can point RS_STUDIO_UPDATE_CONFIG at a test
release's bootstrap-release.json to try the UI.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import threading
from pathlib import Path

from . import __version__
from .paths import resource_root


def _installer():
    path = resource_root() / "bootstrap" / "installer.py"
    spec = importlib.util.spec_from_file_location("rs_studio_bootstrap_installer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _config() -> dict | None:
    path = os.environ.get("RS_STUDIO_UPDATE_CONFIG")
    if not path and os.environ.get("RS_STUDIO_INSTALL_ROOT"):
        path = str(Path(os.environ["RS_STUDIO_INSTALL_ROOT"]) / "bootstrap-release.json")
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")) if path else None
    except (OSError, ValueError):
        return None


def _newer(candidate: str, current: str) -> bool:
    try:
        from packaging.version import Version
        return Version(candidate) > Version(current)
    except Exception:  # unparsable version strings: any different release counts
        return candidate != current


def _launcher() -> list[str] | None:
    try:
        command = json.loads(os.environ.get("RS_STUDIO_LAUNCHER", ""))
        return command if isinstance(command, list) and command else None
    except ValueError:
        return None


def check() -> dict:
    """{supported, current, latest, available, notes, can_install}; raises on network/signature errors."""
    config = _config()
    if config is None:
        return {"supported": False, "current": __version__}
    allow_local = os.environ.get("RS_STUDIO_ALLOW_LOCAL") == "1"
    payload = _installer().fetch_manifest(config, allow_local=allow_local)["payload"]
    return {"supported": True, "current": __version__, "latest": payload["version"],
            "available": _newer(payload["version"], __version__), "notes": payload.get("notes", ""),
            "can_install": _launcher() is not None}


def start_install() -> None:
    """Hand over to the launcher, which waits for this process to exit, updates and reopens RS Studio."""
    command = _launcher()
    if command is None:
        raise RuntimeError("This copy of RS Studio was not started by its launcher.")
    flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0
    subprocess.Popen([*command, "--update", "--wait-pid", str(os.getpid())], creationflags=flags, close_fds=True)
    # Let the HTTP response reach the page before the whole app (window included) exits.
    threading.Timer(1.0, os._exit, args=(0,)).start()
