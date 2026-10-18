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
from .paths import data_root, resource_root


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


def channel_state() -> dict:
    config = _config()
    if config is None:
        try:
            channel = json.loads((data_root() / "update-channel.json").read_text(encoding="utf-8"))["channel"]
        except (OSError, ValueError, KeyError):
            channel = "stable"
    else:
        channel = config.get("channel", "stable")
    return {"channel": channel if channel in ("stable", "preview") else "stable",
            "can_change_channel": config is None or config.get("launcher_version", 0) >= 4}


def set_channel(channel: str) -> dict:
    if channel not in ("stable", "preview"):
        raise ValueError("Choose stable or preview.")
    if not channel_state()["can_change_channel"]:
        raise RuntimeError("Run the new RS Studio Setup once to enable update channels.")
    config = _config()
    if config is None:
        path, value = data_root() / "update-channel.json", {"channel": channel}
    else:
        path = Path(os.environ.get("RS_STUDIO_UPDATE_CONFIG") or
                    str(Path(os.environ["RS_STUDIO_INSTALL_ROOT"]) / "bootstrap-release.json"))
        value = {**config, "channel": channel}
    _installer().atomic_json(path, value)
    return channel_state()


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


RELEASES = "https://api.github.com/repos/Ruslando/RS-Studio/releases/latest"


def _latest_release() -> dict:
    """The newest published release, for copies that run from source and update themselves."""
    import urllib.request
    if channel_state()["channel"] == "preview":
        release = _installer().preview_release()
        if release:
            return {"latest": str(release["tag_name"]).removeprefix("v"), "notes": str(release.get("body") or "")[:20000]}
    request = urllib.request.Request(RELEASES, headers={"User-Agent": "RS-Studio", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        release = json.loads(response.read(1024 * 1024))
    return {"latest": str(release["tag_name"]).removeprefix("v"), "notes": str(release.get("body") or "")[:20000]}


def check() -> dict:
    """{supported, current, latest, available, notes, can_install}; raises on network/signature errors.

    supported is whether this copy can install the update itself. A copy that
    runs from source cannot, but is still told that a newer release exists.
    """
    config = _config()
    if config is None:
        release = _latest_release()
        return {"supported": False, "current": __version__, "can_install": False, **channel_state(), **release,
                "available": _newer(release["latest"], __version__)}
    allow_local = os.environ.get("RS_STUDIO_ALLOW_LOCAL") == "1"
    payload = _installer().fetch_manifest(config, allow_local=allow_local)["payload"]
    # Opting back into regular releases can deliberately return from a preview to an older release.
    returning = False
    if channel_state()["channel"] == "stable":
        try:
            installed = json.loads((Path(os.environ["RS_STUDIO_INSTALL_ROOT"]) / "current.json").read_text(encoding="utf-8"))
            returning = installed["payload"].get("channel") == "preview" and payload["version"] != __version__
        except (OSError, ValueError, KeyError):
            pass
    return {"supported": True, "current": __version__, "latest": payload["version"], **channel_state(),
            "available": returning or _newer(payload["version"], __version__), "notes": payload.get("notes", ""),
            "can_install": _launcher() is not None}


def runtime() -> dict:
    """What Settings > Acceleration shows: the installed PyTorch build and whether CUDA can be added.

    {supported, runtime, cuda: {useful, reason, extra_bytes} | None, can_install}
    """
    root = os.environ.get("RS_STUDIO_INSTALL_ROOT")
    try:
        envelope = json.loads((Path(root) / "current.json").read_text(encoding="utf-8")) if root else None
        runtimes = envelope["payload"]["runtimes"] if envelope else None
    except (OSError, ValueError, KeyError, TypeError):
        runtimes = None
    if not runtimes:
        return {"supported": False}
    cuda = runtimes.get("cuda")
    # --runtime exists from launcher 3 on; an older "RS Studio.exe" would exit on the unknown argument.
    can_install = _launcher() is not None and (_config() or {}).get("launcher_version", 0) >= 3
    return {"supported": True, "runtime": envelope.get("runtime", "core"), "can_install": can_install,
            "cuda": {**_installer().cuda_check(cuda),
                     "extra_bytes": max(0, cuda["download_bytes"] - runtimes["core"]["download_bytes"])} if cuda else None}


def start_install() -> None:
    """Hand over to the launcher, which waits for this process to exit, updates and reopens RS Studio."""
    _hand_over("--update")


def start_runtime(name: str) -> None:
    """Hand over to the launcher to add a runtime (CUDA) to this installation and reopen RS Studio."""
    _hand_over("--runtime", name)


def _hand_over(*arguments: str) -> None:
    command = _launcher()
    if command is None:
        raise RuntimeError("This copy of RS Studio was not started by its launcher.")
    flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0
    subprocess.Popen([*command, *arguments, "--wait-pid", str(os.getpid())], creationflags=flags, close_fds=True)
    # Let the HTTP response reach the page before the whole app (window included) exits.
    threading.Timer(1.0, os._exit, args=(0,)).start()
