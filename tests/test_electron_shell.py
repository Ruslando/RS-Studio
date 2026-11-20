"""The Electron window (launcher/) around the real app.

Each test starts launcher/'s Electron on a throwaway data folder, drives the page
over the Chrome DevTools protocol and reads or acts on Electron's main process
through its Node inspector (main_eval). Needs `npm install` in launcher/ and the
Electron binary (node launcher/node_modules/electron/install.js); skipped otherwise.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "launcher"
ELECTRON_DIST = LAUNCHER / "node_modules/electron/dist"
ELECTRON = ELECTRON_DIST / ("electron.exe" if os.name == "nt" else "electron")


def _free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _until(check, timeout=20, message="timed out"):
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(message)
        time.sleep(0.2)


def _closed(url):
    try:
        urllib.request.urlopen(url, timeout=1).close()
        return False
    except OSError:
        return True


def _isolated_env(data):
    config = data / "config"
    (config / "rs-studio").mkdir(parents=True)
    (config / "rs-studio" / "setup-complete").write_text("1\n")
    # Set when the tests run from inside another Electron app (an editor): it would
    # start electron.exe as plain Node.
    env = {key: value for key, value in os.environ.items() if key != "ELECTRON_RUN_AS_NODE"}
    return {**env, "RS_STUDIO_DATA_ROOT": str(data), "RS_STUDIO_PYTHON": sys.executable,
            "APPDATA": str(config), "XDG_CONFIG_HOME": str(config)}


class ServeForShellTests(unittest.TestCase):
    def test_server_reports_its_port_and_quits_when_the_shell_goes(self):
        data = Path(tempfile.mkdtemp(prefix="rs-serve-"))
        self.addCleanup(shutil.rmtree, data, ignore_errors=True)
        server = subprocess.Popen([sys.executable, str(ROOT / "standalone.py"), "--serve"], cwd=ROOT,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env=_isolated_env(data))
        self.addCleanup(server.stdout.close)
        self.addCleanup(lambda: server.poll() is None and server.kill())
        for line in server.stdout:
            if line.startswith(b"RS_STUDIO_READY "):
                url = f"http://127.0.0.1:{int(line.split()[1])}/"
                break
        with urllib.request.urlopen(url, timeout=30) as page:
            self.assertEqual(page.status, 200)
        server.stdin.close()   # what the shell's pipe does when it quits or crashes
        self.assertEqual(server.wait(15), 0)
        self.assertTrue(_closed(url))


@unittest.skipUnless(ELECTRON.is_file(), "Electron is not installed in launcher/")
class ElectronShellTests(unittest.TestCase):
    def setUp(self):
        from playwright.sync_api import sync_playwright

        self.data = Path(tempfile.mkdtemp(prefix="rs-electron-"))
        self.addCleanup(shutil.rmtree, self.data, ignore_errors=True)
        self.env = _isolated_env(self.data)
        self.inspect, cdp = _free_port(), _free_port()
        self.electron = subprocess.Popen([str(ELECTRON), f"--inspect={self.inspect}",
                                          f"--remote-debugging-port={cdp}", str(LAUNCHER)], env=self.env)
        self.addCleanup(self._stop_electron)
        playwright = sync_playwright().start()
        self.addCleanup(playwright.stop)

        def attach():
            try:
                return playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp}")
            except Exception:
                return None
        self.browser = _until(attach, 60, "Electron's window did not open")

        # The window opens on a loading page and moves to the app once the server is up.
        # Waited for through Playwright: its sync API only takes in events during its own calls.
        self.page = _until(lambda: self.browser.contexts and self.browser.contexts[0].pages, 30)[0]
        self.page.wait_for_url("http://127.0.0.1:*/", timeout=120000)
        self.page.set_default_timeout(15000)
        self.page.wait_for_selector("#welcomeOpen")

    def _stop_electron(self):
        if self.electron.poll() is None:
            self.electron.kill()
            self.electron.wait(15)

    def main_eval(self, expression):
        """Evaluate in Electron's main process; `electron` is its module."""
        from websockets.sync.client import connect

        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.inspect}/json/list", timeout=5))
        source = f"(async () => {{ const electron = process.mainModule.require('electron'); return ({expression}); }})()"
        with connect(targets[0]["webSocketDebuggerUrl"], max_size=None) as ws:
            ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                "params": {"expression": source, "awaitPromise": True, "returnByValue": True}}))
            while True:
                message = json.loads(ws.recv(timeout=15))
                if message.get("id") == 1:
                    result = message["result"]
                    if "exceptionDetails" in result:
                        raise AssertionError(result["exceptionDetails"])
                    return result["result"].get("value")

    def windows(self):
        return self.main_eval("electron.BrowserWindow.getAllWindows().length")

    def test_a_second_start_brings_the_running_window_forward(self):
        second = subprocess.run([str(ELECTRON), str(LAUNCHER)], env=self.env, timeout=30)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(self.windows(), 1)
        self.assertIsNone(self.electron.poll(), "the first window keeps running")

    def test_interface_scale_zooms_the_window_and_ctrl_wheel_does_not(self):
        zoom = "electron.BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()"
        self.page.evaluate("""() => { const input = document.getElementById('uiScale');
            input.value = '1.5'; input.dispatchEvent(new Event('change')); }""")
        _until(lambda: self.main_eval(zoom) == 1.5, 10, "the scale setting did not zoom the window")
        self.page.keyboard.down("Control")
        self.page.mouse.move(400, 400)
        self.page.mouse.wheel(0, -500)
        self.page.keyboard.up("Control")
        self.page.wait_for_timeout(300)
        self.assertEqual(self.main_eval(zoom), 1.5)

    def test_links_open_in_the_browser_and_the_window_stays_on_the_app(self):
        self.main_eval("""(() => { globalThis.opened = [];
            electron.shell.openExternal = async (url) => { globalThis.opened.push(url); }; })()""")
        url = self.page.url
        self.page.evaluate("""() => { const a = Object.assign(document.createElement('a'),
            { href: 'https://www.audiokinetic.com/download/', target: '_blank', rel: 'noopener' });
            document.body.append(a); a.click(); a.remove(); }""")
        _until(lambda: self.main_eval("globalThis.opened.length") == 1, 10, "the link did not reach the browser")
        self.assertEqual(self.main_eval("globalThis.opened"), ["https://www.audiokinetic.com/download/"])
        self.assertEqual(self.windows(), 1)
        # What a file dropped outside a drop zone does: navigate the window to it.
        self.page.evaluate("() => { location.href = 'file:///C:/somewhere/song.chart'; }")
        self.page.wait_for_timeout(500)
        self.assertEqual(self.page.url, url)

    def test_closing_asks_about_unsaved_work_then_quits_with_the_server(self):
        page = self.page
        bundle = self.data / "reference-showcase.chart"
        with zipfile.ZipFile(bundle, "w") as archive:
            archive.write(ROOT / "examples/reference-showcase/project.json", "project.json")
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeOpen")
        chooser.value.set_files(bundle)
        page.wait_for_selector("#lanes .lane-row")
        page.evaluate("""async () => { const {S} = await import('/store.js');
            S.state.editLanes[0].notes.pop(); (await import('/save-state.js')).refreshSaveState(); }""")
        close = "electron.BrowserWindow.getAllWindows()[0].close()"

        self.main_eval(close)
        page.wait_for_selector("#actionConfirmTitle:has-text('Save changes')")
        page.click("#actionConfirmCancel")
        page.wait_for_timeout(500)
        self.assertEqual(self.windows(), 1, "Cancel keeps the window open")

        server = page.url
        self.main_eval(close)
        page.click("#actionConfirmDiscard")
        self.assertEqual(self.electron.wait(20), 0)
        _until(lambda: _closed(server), 20, "the server outlived the window")

    def test_the_server_stops_when_electron_is_killed(self):
        server = self.page.url
        self.electron.kill()   # a crash: no quit event, only the closed stdin pipe
        self.electron.wait(15)
        _until(lambda: _closed(server), 20, "the server outlived a crashed window")


if __name__ == "__main__":
    unittest.main()
