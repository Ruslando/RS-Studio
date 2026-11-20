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


def main_eval(inspect_port, expression):
    """Evaluate in Electron's main process, through its Node inspector; `electron` is its module."""
    from websockets.sync.client import connect

    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{inspect_port}/json/list", timeout=5))
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


def start_electron(env, playwright, output=None):
    """Electron on launcher/, attached; returns (process, inspector port, browser, app page).

    `output`, a file, takes Electron's and the server's console output.
    """
    inspect, cdp = _free_port(), _free_port()
    electron = subprocess.Popen([str(ELECTRON), f"--inspect={inspect}", f"--remote-debugging-port={cdp}", str(LAUNCHER)],
                                env=env, stdout=output, stderr=output and subprocess.STDOUT)

    def attach():
        try:
            return playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp}")
        except Exception:
            return None
    try:
        browser = _until(attach, 60, "Electron's window did not open")
        # The window opens on a loading page and moves to the app once the server is up.
        # Waited for through Playwright: its sync API only takes in events during its own calls.
        page = _until(lambda: browser.contexts and browser.contexts[0].pages, 30)[0]
        page.wait_for_url("http://127.0.0.1:*/", timeout=120000)
    except BaseException:
        electron.kill()
        raise
    return electron, inspect, browser, page


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
        shell = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(lambda: shell.poll() is None and shell.kill())
        server = subprocess.Popen([sys.executable, str(ROOT / "standalone.py"), "--serve"], cwd=ROOT,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  env={**_isolated_env(data), "RS_STUDIO_SHELL_PID": str(shell.pid)})
        self.addCleanup(server.stdout.close)
        self.addCleanup(lambda: server.poll() is None and server.kill())
        for line in server.stdout:
            if line.startswith(b"RS_STUDIO_READY "):
                url = f"http://127.0.0.1:{int(line.split()[1])}/"
                break
        with urllib.request.urlopen(url, timeout=30) as page:
            self.assertEqual(page.status, 200)
        shell.kill()   # the shell is gone, however it went
        self.assertEqual(server.wait(15), 0)
        self.assertTrue(_closed(url))


@unittest.skipUnless(ELECTRON.is_file(), "Electron is not installed in launcher/")
class ElectronShellTests(unittest.TestCase):
    def setUp(self):
        from playwright.sync_api import sync_playwright

        self.data = Path(tempfile.mkdtemp(prefix="rs-electron-"))
        self.addCleanup(shutil.rmtree, self.data, ignore_errors=True)
        self.env = _isolated_env(self.data)
        playwright = sync_playwright().start()
        self.addCleanup(playwright.stop)
        self.electron, self.inspect, self.browser, self.page = start_electron(self.env, playwright)
        self.addCleanup(self._stop_electron)
        self.page.set_default_timeout(15000)
        self.page.wait_for_selector("#welcomeOpen")

    def _stop_electron(self):
        if self.electron.poll() is None:
            self.electron.kill()
            self.electron.wait(15)

    def main_eval(self, expression):
        return main_eval(self.inspect, expression)

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

    def test_a_new_project_takes_its_song(self):
        """Uploading runs FFmpeg and an audio worker: they hung while the server held a stdin pipe."""
        from rs_studio import tutorial

        page = self.page
        audio = tutorial.write_audio(self.data / "audio")["bass"]
        page.click("#welcomeNew")
        with page.expect_file_chooser() as chooser:
            page.click("#npDrop")
        chooser.value.set_files(audio)
        page.wait_for_selector("#npSongTitle", state="visible", timeout=60000)

    def test_downloads_go_where_the_save_dialog_says(self):
        target = self.data / "exports" / "song_p.psarc"
        target.parent.mkdir()
        # Playwright takes over downloads when it attaches; give them back to the window.
        self.browser.new_browser_cdp_session().send("Browser.setDownloadBehavior", {"behavior": "default"})
        self.main_eval(f"""(() => {{ globalThis.asked = [];
            electron.dialog.showSaveDialogSync = (window, options) => {{ asked.push(options.defaultPath); return {json.dumps(str(target))}; }};
        }})()""")
        save = """async () => { const { downloadProjectBlob } = await import('/notify.js');
            downloadProjectBlob(new Blob(['psarc bytes']), 'song_p.psarc'); }"""
        self.page.evaluate(save)
        _until(lambda: target.is_file() and target.read_bytes() == b"psarc bytes", 10, "the download was not saved")
        self.assertEqual(Path(self.main_eval("globalThis.asked")[0]).name, "song_p.psarc")
        target.unlink()
        self.page.evaluate(save)   # the next one starts in the folder the last one went to
        _until(lambda: len(self.main_eval("globalThis.asked")) == 2, 10)
        self.assertEqual(Path(self.main_eval("globalThis.asked")[1]), target)

    def stub_save_dialog(self, answer):
        """The destination question answers `answer` (a path, or None for cancel) and notes when it was asked."""
        self.main_eval(f"""(() => {{ globalThis.asked = [];
            electron.dialog.showSaveDialogSync = () => {{ asked.push(Date.now()); return {json.dumps(answer)}; }}; }})()""")

    def open_guitar_pro_project(self):
        from tests.test_e2e import _gp5_song

        song = self.data / "song.gp5"
        song.write_bytes(_gp5_song())
        with self.page.expect_file_chooser() as chooser:
            self.page.click("#welcomeGp")
        chooser.value.set_files(song)
        self.page.click("#gpImportConfirm")
        self.page.wait_for_selector("#lanes:has-text('8 notes')")

    def test_save_file_writes_only_to_a_destination_the_shell_chose(self):
        target = self.data / "out" / "a_p.psarc"
        target.parent.mkdir()
        self.stub_save_dialog(str(target))
        result = self.page.evaluate("""async () => { const api = window.pywebview.api;
            const chosen = await api.choose_save('a_p.psarc');
            await api.save_file(chosen.id, new Uint8Array([1, 2, 3]).buffer);
            let refused = false;
            try { await api.save_file('not-an-id', new Uint8Array([9]).buffer); } catch { refused = true; }
            return { name: chosen.name, refused }; }""")
        self.assertEqual(result, {"name": "a_p.psarc", "refused": True})
        self.assertEqual(target.read_bytes(), bytes([1, 2, 3]))
        self.assertEqual([file.name for file in target.parent.iterdir()], ["a_p.psarc"], "nothing else was written")

    def test_an_export_asks_where_to_save_before_it_builds_anything(self):
        target = self.data / "out" / "song.gp5"
        target.parent.mkdir()
        self.stub_save_dialog(str(target))
        self.open_guitar_pro_project()
        built = []
        self.page.on("request", lambda request: "/api/tab" in request.url and built.append(time.time() * 1000))
        self.page.click("#fileMenuBtn")
        self.page.click("#menuExportTab")
        self.page.wait_for_selector(".toast:has-text('Exported song.gp5')")
        asked = self.main_eval("globalThis.asked")
        self.assertEqual((len(asked), len(built)), (1, 1))
        self.assertLessEqual(asked[0], built[0], "the question comes before the build")
        self.assertIn(b"FICHIER GUITAR PRO", target.read_bytes()[:30], "the file is where the question said")

    def test_a_rocksmith_export_with_a_mac_package_is_one_zip_after_one_question(self):
        from rs_studio import tutorial
        from rs_studio.rocksmith.psarc import read_psarc

        with urllib.request.urlopen(self.page.url + "api/rocksmith/audio-converter") as response:
            if not json.load(response)["found"]:
                self.skipTest("no audio converter (Wwise) on this machine: the Rocksmith package was not built")
        out = self.data / "dlc"
        out.mkdir()
        self.main_eval(f"""(() => {{ const path = process.mainModule.require('node:path'); globalThis.asked = [];
            electron.dialog.showSaveDialogSync = (_window, options) => {{ asked.push(options.defaultPath);
                return path.join({json.dumps(str(out))}, path.basename(options.defaultPath)); }}; }})()""")
        page = self.page
        page.set_default_timeout(60000)
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeNew")
            page.click("#npDrop")
        chooser.value.set_files(tutorial.write_audio(self.data / "audio")["bass"])
        page.wait_for_selector("#npSongTitle", state="visible")
        page.fill("#npSongTitle", "Mac Song")
        page.fill("#npArtist", "Mac Artist")
        page.click("#go")
        page.wait_for_selector("#appshell", state="visible")
        page.wait_for_selector(".project-loading-backdrop", state="detached")
        page.click("#stage", button="right", position={"x": 300, "y": 80})
        page.get_by_text("Detect notes…").click()
        page.select_option("#detectModel", "torchcrepe")
        page.click("#detectBtn")
        notes = len(tutorial.PHRASE * tutorial.REPEATS)
        page.wait_for_selector(f"#lanes:has-text('{notes} notes')", timeout=180000)
        page.click("#fileMenuBtn")
        page.click("#menuExportRocksmith")
        page.check("#rsPsarcOnly")
        page.check("#rsMac")
        page.click("#rsExportGo")
        page.wait_for_selector(".toast:has-text('Exported')", timeout=300000)
        self.assertEqual([Path(name).name for name in self.main_eval("globalThis.asked")], ["Mac-Artist_Mac-Song_v1.zip"],
                         "one question, for a zip named as the server names it")
        self.assertEqual([file.name for file in out.iterdir()], ["Mac-Artist_Mac-Song_v1.zip"])
        with zipfile.ZipFile(out / "Mac-Artist_Mac-Song_v1.zip") as archive:
            self.assertEqual(sorted(archive.namelist()), ["Mac-Artist_Mac-Song_v1_m.psarc", "Mac-Artist_Mac-Song_v1_p.psarc"],
                             "the two packages and nothing else: only the packages was asked for")
            for name in archive.namelist():
                self.assertTrue(read_psarc(archive.read(name)), name)

    def test_cancelling_the_question_builds_and_writes_nothing(self):
        self.stub_save_dialog(None)
        self.open_guitar_pro_project()
        built = []
        self.page.on("request", lambda request: "/api/tab" in request.url and built.append(request.url))
        self.page.click("#fileMenuBtn")
        self.page.click("#menuExportTab")
        _until(lambda: self.main_eval("globalThis.asked.length") == 1, 10, "the question was not asked")
        self.page.wait_for_timeout(1500)
        self.assertEqual(built, [])
        self.assertEqual([file.name for file in self.data.glob("**/*.gp5") if file.name != "song.gp5"], [],
                         "nothing was written (song.gp5 is the one that was imported)")

    def test_an_error_notification_copies_its_text_to_the_clipboard(self):
        self.main_eval("electron.clipboard.writeText('before')")
        self.page.evaluate("""async () => (await import('/notify.js')).toast('Export failed: Wwise exited', 8000, 'error')""")
        self.page.click(".toast-copy")
        self.page.wait_for_selector(".toast-copy:has-text('Copied')")
        self.assertEqual(self.main_eval("electron.clipboard.readText()"), "Export failed: Wwise exited")

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
        self.electron.kill()   # a crash: no quit event, only the process gone
        self.electron.wait(15)
        _until(lambda: _closed(server), 20, "the server outlived a crashed window")


if __name__ == "__main__":
    unittest.main()
