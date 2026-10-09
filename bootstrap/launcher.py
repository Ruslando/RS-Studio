"""Setup window and launcher. Never imports the application or its ML stack.

The same program is the downloaded "RS Studio Setup.exe" and, copied into the
installation, "RS Studio.exe". Installations are portable: one folder holds
everything, deleting it removes RS Studio. Started from an installation it
opens the app (or offers repair); started elsewhere it installs.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from installer import (LAUNCHER_VERSION, Cancelled, cuda_check, fetch_manifest, install as install_release,
                       installed_release, installed_runtime, is_installation, launch)

NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def install_target(folder: Path) -> Path:
    """Usual installer behaviour for a chosen folder: an installation or an empty
    folder is used as is; any other folder gets an "RS Studio" subfolder."""
    if is_installation(folder) or not folder.exists() or not any(folder.iterdir()):
        return folder
    return folder / "RS Studio"


def installed_launcher(root: Path, relaunch: list[str]) -> list[str]:
    """Command that opens this installation. A frozen setup copies itself into it
    as "RS Studio.exe", so the downloaded setup can be deleted; a source run relaunches itself."""
    if not getattr(sys, "frozen", False):
        return [str(Path(sys.executable).with_name("pythonw.exe")), str(Path(__file__).resolve()), *relaunch,
                "--install-root", str(root), "--launch"]
    target = root / "RS Studio.exe"
    if Path(sys.executable).resolve() != target.resolve():
        shutil.copy2(sys.executable, target)
    return [str(target)]


def create_shortcut(folder: str, command: list[str], icon: Path) -> None:
    """Write "RS Studio.lnk" into a known folder ("Desktop"/"Programs") or a plain directory."""
    script = ("$folder = if ($env:RS_FOLDER -in 'Desktop','Programs') { [Environment]::GetFolderPath($env:RS_FOLDER) } else { $env:RS_FOLDER }; "
              "New-Item -ItemType Directory -Force $folder | Out-Null; "
              "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $folder 'RS Studio.lnk')); "
              "$s.TargetPath = $env:RS_TARGET; $s.Arguments = $env:RS_ARGUMENTS; $s.WorkingDirectory = $env:RS_WORKDIR; "
              "$s.IconLocation = $env:RS_ICON; $s.Description = 'RS Studio'; $s.Save()")
    env = {**os.environ, "RS_FOLDER": folder, "RS_TARGET": command[0], "RS_ARGUMENTS": subprocess.list2cmdline(command[1:]),
           "RS_WORKDIR": str(Path(command[0]).parent), "RS_ICON": str(icon)}
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], env=env, check=True,
                   capture_output=True, creationflags=NO_WINDOW)


class InstallerWindow:
    """Only a few small methods are exposed through pywebview's JS bridge."""
    def __init__(self, config: dict, destination: Path, *, fixed: bool = False, allow_local: bool = False,
                 relaunch: list[str] = ()):
        self._config = config
        self._destination = destination
        self._fixed = fixed  # started from an installation: open it, or repair it
        self._allow_local = allow_local
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._busy = False
        self._closing = False
        self._closed = False
        self._envelope = None
        self._runtime = "core"
        self._installed = None
        self._relaunch = list(relaunch)
        self._active = None
        self._window = None
        self._state = {"state": "checking", "message": "Checking your installation…", "done": 0, "total": 0}

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def browse(self) -> None:
        """Standard folder dialog; the chosen folder is inspected like the default one."""
        if self._fixed or self._busy or self._closed or not self._window:
            return
        import webview
        start = self._destination if self._destination.exists() else self._destination.parent
        try:
            chosen = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=str(start))
        except Exception:
            return  # window closed while the dialog was open
        if chosen and not self._closed:
            self.choose(Path(chosen[0] if isinstance(chosen, (list, tuple)) else chosen))

    def choose(self, folder: Path) -> None:
        with self._lock:
            if self._busy:
                return
            self._destination = install_target(folder.resolve())
        self._inspect()

    def install(self, cuda: bool = False) -> None:
        self._start(cuda, repair=False)

    def repair(self, cuda: bool = False) -> None:
        self._start(cuda, repair=True)

    def open(self) -> None:
        if self._installed and not self._busy:
            # Not on the JS bridge call: it must return before the window goes away.
            threading.Thread(target=self._open_app, args=(self._installed,), daemon=True).start()

    def _start(self, cuda: bool, repair: bool) -> None:
        if not self._envelope:  # e.g. Retry after the release could not be reached
            threading.Thread(target=self._inspect, daemon=True).start()
            return
        with self._lock:
            if self._busy or self._closing:
                return
            self._busy = True
            self._runtime = "cuda" if cuda and "cuda" in self._envelope["payload"]["runtimes"] else "core"
        self._cancel.clear()
        threading.Thread(target=self._perform, args=(repair,), daemon=True).start()

    def finish(self, start_menu: bool = True, desktop: bool = True, open_app: bool = True) -> None:
        with self._lock:
            if self._state["state"] != "done":
                return
            self._state = {"state": "finishing", "message": "Finishing setup…", "done": 0, "total": 0}
        threading.Thread(target=self._finish, args=(start_menu, desktop, open_app), daemon=True).start()

    def _finish(self, start_menu: bool, desktop: bool, open_app: bool):
        try:
            command = installed_launcher(self._destination, self._relaunch)
            if os.name == "nt":
                icon = Path(command[0]) if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1] / "assets/icon.ico"
                for chosen, folder in ((start_menu, "Programs"), (desktop, "Desktop")):
                    if chosen:
                        create_shortcut(folder, command, icon)
            if open_app:
                launch(self._destination, self._active)
            self._destroy()
        except Exception as exc:
            self._set("done", "RS Studio is installed, but finishing failed: " + (str(exc) or type(exc).__name__),
                      shortcuts=os.name == "nt", folder=str(self._destination))

    def quit(self) -> None:
        self._closing = True
        self._cancel.set()
        with self._lock:
            busy = self._busy
            self._state = {"state": "stopping", "message": "Stopping setup…", "done": 0, "total": 0}
        if not busy:
            # The JS bridge call must return before the window goes away.
            threading.Timer(0.1, self._destroy).start()

    def _destroy(self):
        # Only once, and never after the window thread has ended: pywebview's
        # .NET bridge crashes the process when a closed window is called.
        with self._lock:
            if self._closed:
                return
            self._closed = True
        if self._window:
            try:
                self._window.destroy()
            except Exception:
                pass

    def _on_closing(self):
        # Let the window close itself unless an installation must stop first.
        if self._closed or not self._busy:
            self._closing = self._closed = True
            self._cancel.set()
            return True
        self.quit()
        return False

    def _set(self, state: str, message: str, **details):
        with self._lock:
            self._state = {"state": state, "message": message, "done": 0, "total": 0, **details}

    def _open_app(self, payload):
        if self._closing:
            return
        self._set("launching", "Opening RS Studio…")
        launch(self._destination, payload)
        self._destroy()

    def _inspect(self):
        """Look at the destination: installed, interrupted, foreign files or empty."""
        try:
            root = self._destination
            self._set("checking", "Checking " + str(root) + "…")
            self._installed = installed_release(root, self._config, allow_local=self._allow_local)
            if self._installed and self._fixed:
                self._open_app(self._installed)
                return
            kind = "installed" if self._installed else "continue" if is_installation(root) else "install"
            if kind == "install" and root.exists() and any(root.iterdir()):
                kind = "occupied"  # never mix RS Studio into a folder with other files
            if self._envelope is None:
                try:
                    self._envelope = fetch_manifest(self._config, allow_local=self._allow_local)
                except Exception:
                    if not self._installed:
                        raise  # nothing to open offline
            details = {"kind": kind, "folder": str(root), "fixed": self._fixed}
            if self._installed:
                details.update(installed_version=self._installed["version"], installed_runtime=self._installed["runtime"])
            else:
                details["installed_runtime"] = installed_runtime(root)
            if self._envelope:
                payload = self._envelope["payload"]
                runtimes = payload["runtimes"]
                def sizes(runtime):
                    return {"download_bytes": runtimes[runtime]["download_bytes"] + payload["app"]["bytes"] + payload["ffmpeg"]["bytes"]}
                cuda = runtimes.get("cuda")
                details.update(version=payload["version"], core=sizes("core"),
                               cuda=dict(sizes("cuda"), **cuda_check(cuda)) if cuda else None)
            self._set("ready", "", **details)
        except Exception as exc:
            self._set("error", str(exc) or type(exc).__name__, folder=str(self._destination))

    def _perform(self, repair: bool = False):
        try:
            if self._envelope is None:
                self._inspect()
                return
            def progress(stage, done, total, **detail):
                speed = detail.get("speed") or 0
                self._set("installing", stage, done=done, total=total, file=detail.get("file", ""), speed=speed,
                          eta=(total - done) / speed if speed and total else None)
            self._active = install_release(self._destination, self._envelope, self._config, self._cancel, progress,
                                           runtime=self._runtime, repair=repair, allow_local=self._allow_local)
            self._installed = self._active
            self._set("done", "RS Studio is repaired." if repair else "RS Studio is installed.",
                      shortcuts=os.name == "nt", folder=str(self._destination))
        except Cancelled as exc:
            self._set("error", str(exc), folder=str(self._destination))
        except Exception as exc:
            self._set("error", str(exc) or type(exc).__name__, folder=str(self._destination))
        finally:
            with self._lock:
                self._busy = False
            if self._closing and not self._closed:
                self._destroy()

    def _first_check(self):
        threading.Thread(target=self._inspect, daemon=True).start()

    def _run(self):
        import webview
        html = (Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "installer.html").read_text(encoding="utf-8")
        # The app's UI font, inlined: the page is loaded from a string and may not fetch anything.
        fonts = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1])) / "web/fonts"
        faces = []
        for family, weight, name in (("Atkinson Hyperlegible Next", "400 700", "atkinson-hyperlegible-next-400-700-latin.woff2"),
                                     ("IBM Plex Mono", "400", "ibm-plex-mono-400-latin.woff2")):
            if (fonts / name).is_file():
                data = base64.b64encode((fonts / name).read_bytes()).decode("ascii")
                faces.append(f"@font-face {{ font-family: '{family}'; font-weight: {weight}; src: url(data:font/woff2;base64,{data}) format('woff2'); }}")
        html = html.replace("/*fonts*/", "\n".join(faces), 1)
        self._window = webview.create_window("RS Studio — Setup", html=html, js_api=self,
                                             width=620, height=640, min_size=(540, 560),
                                             background_color="#171f2b", text_select=False)
        self._window.events.closing += self._on_closing
        assets = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1])) / "assets"
        # Outside the installation folder, so nothing is left behind elsewhere.
        profile = Path(tempfile.gettempdir()) / "rs-studio-setup-webview"
        profile.mkdir(parents=True, exist_ok=True)
        webview.start(self._first_check, icon=str(assets / "icon.ico"),
                      private_mode=False, storage_path=str(profile))


def main() -> None:
    sink = open(os.devnull, "w", encoding="utf-8", errors="replace")
    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink
    frozen = getattr(sys, "frozen", False)
    parser = argparse.ArgumentParser(description="RS Studio setup and launcher")
    if not frozen:  # development only: local test releases and test folders
        parser.add_argument("--install-root", type=Path, help="Suggested installation folder")
        parser.add_argument("--launch", action="store_true", help="Act as the installed RS Studio.exe of --install-root")
        parser.add_argument("--config", type=Path)
        parser.add_argument("--allow-local", action="store_true")
    args = parser.parse_args()
    relaunch = []
    try:
        here = Path(sys.executable).resolve().parent
        if not frozen:
            root, fixed = (args.install_root or Path.cwd() / "RS Studio").resolve(), args.launch
            relaunch = (["--config", str(args.config.resolve())] if args.config else []) + (["--allow-local"] if args.allow_local else [])
        elif is_installation(here):
            root, fixed = here, True  # this is the installed "RS Studio.exe"
        else:
            root, fixed = install_target(here / "RS Studio"), False
        config_path = getattr(args, "config", None) or Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "bootstrap-release.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        if config["launcher_version"] != LAUNCHER_VERSION or not isinstance(config["public_key"], dict):
            raise ValueError("Invalid launcher configuration")
        InstallerWindow(config, root, fixed=fixed, allow_local=getattr(args, "allow_local", False), relaunch=relaunch)._run()
    except Exception as exc:
        if os.name == "nt":
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, f"RS Studio setup could not start.\n{exc}", "RS Studio — Setup", 0x10)
        else:
            raise


if __name__ == "__main__":
    main()
