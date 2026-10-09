"""Standalone desktop launcher.

Entry point for the packaged (PyInstaller) build, where there's no Python
interpreter to run ``serve`` from the CLI. Starts the local server in this
process and opens the UI in a native window once it's reachable, falling back
to the default browser when no native webview backend is available.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .audio_runtime import prepare_ffmpeg
from .paths import resource_root


def _prep_runtime() -> None:
    # A windowed build has no console, so sys.stdout/stderr are None — give them
    # a sink so logging / tqdm inside the ML libs don't crash writing to None.
    sink = open(os.devnull, "w", encoding="utf-8", errors="replace")
    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink
    prepare_ffmpeg()


def _free_port(preferred: int = 8000) -> int:
    """Return `preferred` if free, otherwise an OS-assigned open port."""
    for candidate in (preferred, 0):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", candidate))
            return s.getsockname()[1]
        except OSError:
            continue
        finally:
            s.close()
    return preferred


def _wait_until_ready(host: str, port: int) -> None:
    for _ in range(200):  # poll up to ~50s while the heavy ML imports warm up
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.25)


class _Shell:
    """Closing the window, with the unsaved-work question asked by the page.

    A close is handed back to the page (which puts up the app's own Save / Don't
    save / Cancel dialog) and cancelled here; the page answers by calling ``quit``.
    Everything but ``quit`` is named private, and has to be: pywebview publishes
    every *public* member of a js_api object to JS, walking into the objects too —
    handed the native WebView2 control it logs a screenful of COM errors.
    """

    def __init__(self) -> None:
        self._window = None
        self._quitting = False

    def _on_closing(self) -> bool:
        # `destroy` below raises this same event, so the second pass has to let go
        # or the window asks the page again forever and never closes.
        if self._quitting:
            return True
        # Off the GUI thread: evaluate_js needs the loop this handler is blocking
        # in order to run the script it waits on.
        threading.Thread(target=self._ask_page, daemon=True).start()
        return False

    def _ask_page(self) -> None:
        if not self._window.evaluate_js(_ASK_PAGE):
            self.quit()

    def quit(self) -> None:
        self._quitting = True
        self._window.destroy()


# Hand the close back to the page and report whether it took it. Only a page that
# can't answer — never loaded, cached from an older build, threw on the way in —
# returns false, and then the window closes as it always did rather than trapping
# the user in an app that won't quit.
_ASK_PAGE = """(function () {
  try { return !!window.cwQuitRequested && (window.cwQuitRequested(), true); }
  catch (e) { return false; }
})()"""


def _app_icon() -> Path:
    return resource_root() / "assets" / "icon.ico"


def _open_window(url: str) -> bool:
    """Show the UI in a native window. False if no webview backend is usable.

    Windows resolves to WebView2 (bundled with the OS). Linux needs the system
    WebKitGTK bindings (python3-gi + gir1.2-webkit2-*), which cannot be bundled
    — without them we fall back to the browser rather than failing to start.
    """
    try:
        import webview
    except ImportError:
        return False
    try:
        # pywebview cancels downloads by default; exports (.psarc, project
        # archives) are page downloads and would silently go nowhere.
        webview.settings["ALLOW_DOWNLOADS"] = True
        shell = _Shell()
        window = webview.create_window("RS Studio", url,
                                       width=1500, height=950, min_size=(1000, 640),
                                       js_api=shell)
        shell._window = window
        window.events.closing += shell._on_closing
        webview.start(icon=str(_app_icon()))   # blocks until the window closes
    except Exception as exc:  # noqa: BLE001 - any backend problem means "use the browser"
        print(f"[desktop] no native webview backend ({exc}); opening a browser instead")
        return False
    return True


def launch() -> None:
    _prep_runtime()
    host, port = "127.0.0.1", _free_port()
    url = f"http://{host}:{port}/"
    print(f"RS Studio — {url}")

    from rs_studio import server
    # The webview owns the main thread (its GUI loop requires it), so the server
    # runs behind it as a daemon: closing the window ends the process outright.
    thread = threading.Thread(target=server.serve, kwargs={"host": host, "port": port},
                              daemon=True)
    thread.start()
    _wait_until_ready(host, port)

    if _open_window(url):
        return            # window closed — quit, taking the server with us
    # No webview backend: hand the UI to the browser and keep serving until
    # the process is interrupted, since nothing else is holding it open now.
    webbrowser.open(url)
    thread.join()


if __name__ == "__main__":
    launch()
