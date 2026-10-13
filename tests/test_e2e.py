"""End-to-end: a real browser clicks through the running app.

The server runs as its own process on a throwaway data folder, so nothing here
touches the real project library. The browser is the installed Microsoft Edge,
the engine the desktop window (WebView2) uses. Every test also fails on any
JavaScript error, failed script load or server error it caused, whatever it was
checking: a button whose handler throws is a failure even if nothing asserts on it.
"""
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

import guitarpro as gp
from playwright.sync_api import expect, sync_playwright

from rs_studio import tutorial
from rs_studio.rocksmith.psarc import read_psarc
from rs_studio.tab import build_gp5

expect.set_options(timeout=15000)
FRETS = [0, 3, 5, 7, 5, 3, 0, 3]                        # on the A string, an eighth each


def _gp5_song() -> bytes:
    notes = [{"start": i * 0.5, "end": i * 0.5 + 0.4, "pitch": 45 + fret, "string": 5, "fret": fret}
             for i, fret in enumerate(FRETS)]
    track = {"name": "Guitar", "tuning": [64, 59, 55, 50, 45, 40], "capo": 0, "notes": notes}
    grid = {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4}
    return build_gp5({"name": "E2E Song", "grid": grid, "resolution": 4, "tracks": [track]})[0]


class EndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = Path(tempfile.mkdtemp(prefix="rs-e2e-"))
        cls.addClassCleanup(shutil.rmtree, cls.data, ignore_errors=True)
        (cls.data / "song.gp5").write_bytes(_gp5_song())
        # A bass line whose notes are known: one a beat, the same phrase four times.
        cls.audio = tutorial.write_audio(cls.data / "audio")["bass"]
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        cls.url = f"http://127.0.0.1:{port}/"
        cls.log = open(cls.data / "server.log", "w", encoding="utf-8")
        cls.addClassCleanup(cls.log.close)
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "rs_studio", "serve", "--port", str(port)],
            env={**os.environ, "RS_STUDIO_DATA_ROOT": str(cls.data)}, stdout=cls.log, stderr=subprocess.STDOUT)
        cls.addClassCleanup(cls.server.wait, 10)
        cls.addClassCleanup(cls.server.terminate)
        deadline = time.monotonic() + 120
        while True:
            try:
                urllib.request.urlopen(cls.url, timeout=1).close()
                break
            except OSError:
                if cls.server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("The server did not start:\n" + (cls.data / "server.log").read_text(encoding="utf-8"))
                time.sleep(0.2)
        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(channel="msedge")

    def setUp(self):
        # A new context per test: nothing in localStorage carries over.
        context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        self.page = context.new_page()
        self.page.set_default_timeout(15000)
        self.faults = []
        self.page.on("pageerror", lambda error: self.faults.append(f"script error: {error}"))
        self.page.on("console", lambda message: message.type == "error"
                     and not message.location["url"].endswith("/favicon.ico")
                     and self.faults.append(f"console: {message.text}"))
        self.page.on("response", lambda response: response.status >= 500
                     and self.faults.append(f"HTTP {response.status} {response.url}"))
        self.page.goto(self.url)
        # Registered last, so it runs first: before the page is closed.
        self.addCleanup(lambda: self.assertEqual(self.faults, [], "the app reported errors during this test"))

    def open_guitar_pro_project(self):
        page = self.page
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeGp")
        chooser.value.set_files(self.data / "song.gp5")
        expect(page.locator("#gpImportTracks")).to_contain_text("8 notes")
        page.click("#gpImportConfirm")
        # A score-only project opens on its tablature.
        expect(page.locator("#tabRender svg").first).to_be_visible()
        page.click("#tabViewClose")
        expect(page.locator("#lanes")).to_contain_text("8 notes")

    def new_audio_project(self):
        page = self.page
        page.click("#welcomeNew")
        page.fill("#npSongTitle", "E2E Audio")
        page.fill("#npArtist", "E2E Artist")
        page.set_input_files("#file", self.audio)
        expect(page.locator("#go")).to_be_disabled()     # not while the song is still uploading
        page.click("#go", timeout=60000)
        expect(page.locator("#appshell")).to_be_visible()
        expect(page.locator("#lanes")).to_contain_text("0 notes")

    def file_menu(self, item):
        self.page.click("#fileMenuBtn")
        self.page.click(item)

    def download(self, item, timeout=30000):
        with self.page.expect_download(timeout=timeout) as download:
            self.file_menu(item)
        return Path(download.value.path())

    def home(self):
        self.page.click("#homeBtn")
        expect(self.page.locator("#welcomeNew")).to_be_visible()

    def test_app_loads(self):
        expect(self.page.locator("#welcomeNew")).to_be_visible()
        expect(self.page.locator("#welcomeVersion")).to_contain_text("v")
        self.page.click("#welcomeSettingsBtn")
        expect(self.page.locator("#settingsModalBackdrop")).to_be_visible()

    def test_rocksmith_export_window_opens_with_the_project_in_it(self):
        page = self.page
        self.open_guitar_pro_project()
        self.file_menu("#menuExportRocksmith")
        expect(page.locator("#rocksmithExportModal")).to_be_visible()
        expect(page.locator("#rsTitle")).to_have_value("E2E Song")
        row = page.locator(".rs-arr-row")
        expect(row).to_have_count(1)
        expect(row.locator(".rs-arr-on")).to_be_checked()
        expect(row.locator(".count")).to_have_text("8 notes")
        expect(row.locator(".rs-arr-kind")).to_have_value("lead")
        # Bass needs four strings: the tuning list follows the arrangement type.
        row.locator(".rs-arr-kind").select_option("bass")
        self.assertEqual(row.locator(".rs-arr-tuning").input_value().count(","), 3)
        page.click("#rsExportCancel")
        expect(page.locator("#rocksmithExportModal")).to_be_hidden()

    def test_guitar_pro_file_comes_back_out_as_it_went_in(self):
        self.open_guitar_pro_project()
        song = gp.parse(io.BytesIO(self.download("#menuExportTab").read_bytes()))
        played = [(note.string, note.value) for measure in song.tracks[0].measures
                  for voice in measure.voices for beat in voice.beats for note in beat.notes]
        self.assertEqual(played, [(5, fret) for fret in FRETS])

    def test_song_becomes_a_rocksmith_package(self):
        """The whole way: audio in, notes detected, Guitar Pro and Rocksmith files out."""
        page = self.page
        self.new_audio_project()
        page.click("#stage", button="right", position={"x": 300, "y": 80})
        page.get_by_text("Detect notes…").click()
        page.select_option("#detectModel", "torchcrepe")
        page.click("#detectBtn")
        page.get_by_role("button", name="Use 1/32 grid").click(timeout=180000)
        expected = tutorial.PHRASE * tutorial.REPEATS
        expect(page.locator("#lanes")).to_contain_text(f"{len(expected)} notes")

        track = gp.parse(io.BytesIO(self.download("#menuExportTab").read_bytes())).tracks[0]
        pitches = [track.strings[note.string - 1].value + note.value for measure in track.measures
                   for voice in measure.voices for beat in voice.beats for note in beat.notes
                   if note.type == gp.NoteType.normal]           # a tie continues the note before it
        self.assertEqual(pitches, expected, "the detected notes are the ones in the audio")

        with urllib.request.urlopen(self.url + "api/rocksmith/audio-converter") as response:
            if not json.load(response)["found"]:
                self.skipTest("no audio converter (Wwise) on this machine: the Rocksmith package was not built")
        self.file_menu("#menuExportRocksmith")
        expect(page.locator(".rs-arr-row .count")).to_have_text(f"{len(expected)} notes")
        with page.expect_download(timeout=300000) as download:
            page.click("#rsExportGo")
        self.assertEqual(download.value.suggested_filename, "E2E-Artist_E2E-Audio_v1_p.psarc")
        files = read_psarc(Path(download.value.path()).read_bytes())
        kinds = sorted({name.rsplit(".", 1)[-1] for name in files})
        self.assertEqual(kinds, ["appid", "bnk", "dds", "flat", "hsan", "json", "nt", "sng", "version", "wem", "xblock", "xml"])
        self.assertTrue(all(files.values()), "no empty file in the package")
        manifest = json.loads(next(blob for name, blob in files.items() if name.endswith(".json")))
        song = next(iter(manifest["Entries"].values()))["Attributes"]
        self.assertEqual((song["SongName"], song["ArtistName"], song["ArrangementName"]), ("E2E Audio", "E2E Artist", "Lead"))
        self.assertEqual(song["NotesHard"], len(expected))
        expect(page.locator("#rocksmithExportModal")).to_be_hidden()

    def test_stem_is_separated_from_the_song(self):
        page = self.page
        with urllib.request.urlopen(self.url + "api/models") as response:
            if not any(model["id"] == "demucs" and model["state"] == "ready" for model in json.load(response)):
                self.skipTest("the Demucs model is not downloaded on this machine: no separation was run")
        self.new_audio_project()
        page.click("#stemTabs .layer-add")
        page.locator("select:has(option[value=bass]):visible").select_option("bass")
        page.locator(".sc-go:visible").click()
        rows = page.locator("#stemTabs .stem-row")
        expect(rows).to_have_count(2)
        expect(page.locator("#stemTabs .stem-pending")).to_have_count(0, timeout=300000)
        # The new stem is the one on screen, and the song is still there beside it.
        expect(rows.nth(1)).to_contain_text("Bass")
        expect(rows.nth(1)).to_have_class(re.compile(r"\bviewing\b"))
        expect(rows.nth(0)).to_contain_text("Full song")

    def test_edits_undo_and_survive_saving(self):
        page = self.page
        notes = lambda count: expect(page.locator("#lanes")).to_contain_text(re.compile(rf"\b{count} notes?\b"))
        self.new_audio_project()
        page.dblclick("#stage", position={"x": 300, "y": 300})
        notes(1)
        page.dblclick("#stage", position={"x": 500, "y": 400})
        notes(2)
        page.keyboard.press("Control+z")
        notes(1)
        page.keyboard.press("Control+Shift+z")
        notes(2)
        # Shift-drag a box around both notes, then delete what it caught.
        box = page.locator("#stage").bounding_box()
        page.keyboard.down("Shift")
        page.mouse.move(box["x"] + 200, box["y"] + 200)
        page.mouse.down()
        page.mouse.move(box["x"] + 700, box["y"] + 500, steps=8)
        page.mouse.up()
        page.keyboard.up("Shift")
        page.keyboard.press("Delete")
        notes(0)
        page.keyboard.press("Control+z")
        notes(2)
        page.keyboard.press("Control+s")
        self.home()
        page.get_by_role("button", name="Open E2E Audio").first.click()
        expect(page.locator("#appshell")).to_be_visible()
        notes(2)

    def test_layer_settings_reach_the_layer_row_and_the_export_window(self):
        page = self.page
        self.open_guitar_pro_project()
        page.hover("#lanes .lane-row")                 # the edit button shows on hover
        page.click("#lanes .lane-row .edit-btn")
        page.select_option("#layerCapo", "2")
        page.select_option("#layerArrangement", "rhythm")
        page.click("#layerSave")
        expect(page.locator("#layerSettingsBackdrop")).to_be_hidden()
        expect(page.locator("#lanes")).to_contain_text("Rhythm")
        expect(page.locator("#lanes")).to_contain_text("Capo 2")
        self.file_menu("#menuExportRocksmith")
        row = page.locator(".rs-arr-row")
        expect(row.locator(".rs-arr-kind")).to_have_value("rhythm")
        expect(row.locator(".rs-arr-capo")).to_have_value("2")
        page.click("#rsExportCancel")

        # A second layer takes the next free arrangement, and cannot take the first one's.
        page.click("#addLane")
        expect(page.locator("#layerArrangement")).to_have_value("lead")
        expect(page.locator("#layerArrangement option[value=rhythm]")).to_have_js_property("disabled", True)
        expect(page.locator("#layerArrangement option[value=bass]")).to_have_js_property("disabled", True)   # not on a guitar neck
        expect(page.locator("#layerArrangement option[value=auto]")).to_have_count(0)
        page.select_option("#layerInstr", "bass")
        expect(page.locator("#layerArrangement")).to_have_value("bass")
        page.click("#layerSave")
        rows = page.locator("#lanes .lane-row")
        expect(rows).to_have_count(2)
        expect(rows.nth(0)).to_contain_text("Rhythm")
        expect(rows.nth(1)).to_contain_text("Bass")

    def test_project_is_renamed_then_deleted_from_the_library(self):
        page = self.page
        self.open_guitar_pro_project()
        self.file_menu("#menuProjectSettings")
        page.fill("#projTitle", "Gone Soon")
        page.fill("#projArtist", "Nobody")
        page.click("#settingsApply")
        expect(page.locator("#projTabName")).to_contain_text("Gone Soon")
        page.keyboard.press("Control+s")
        self.home()
        card = page.get_by_role("button", name=re.compile("Open .*Gone Soon"))
        expect(card).to_have_count(1)
        page.get_by_role("button", name=re.compile("Delete .*Gone Soon")).click()
        page.click("#actionConfirmAccept")
        expect(card).to_have_count(0)
        page.reload()
        expect(page.locator("#welcomeNew")).to_be_visible()
        expect(card).to_have_count(0)

    def test_chart_file_reopens_as_the_same_project(self):
        page = self.page
        self.open_guitar_pro_project()
        chart = self.data / "exported.chart"
        chart.write_bytes(self.download("#saveAs").read_bytes())
        self.home()
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeOpen")
        chooser.value.set_files(chart)
        expect(page.locator("#appshell")).to_be_visible()
        expect(page.locator("#lanes")).to_contain_text("8 notes")

    def test_modern_guitar_pro_export_can_be_opened_again(self):
        page = self.page
        self.open_guitar_pro_project()
        modern = self.data / "exported.gp"
        modern.write_bytes(self.download("#menuExportModernGp").read_bytes())
        self.home()
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeGp")
        chooser.value.set_files(modern)
        expect(page.locator("#gpImportTracks")).to_contain_text("8 notes")

    def test_walkthrough_runs_from_first_card_to_last(self):
        page = self.page
        page.click("#welcomeTour")
        card = page.locator(".tour-card")
        expect(card).to_be_visible()
        head = card.locator(".tour-head")
        seen = []
        while not card.locator(".tour-home").is_visible():
            self.assertLess(len(seen), 400, "the walkthrough does not end")
            seen.append(head.inner_text())
            card.locator(".tour-next").click()          # "Next", or "Skip" on a card that waits for a task
            expect(head).not_to_have_text(seen[-1])
        self.assertGreater(len(seen), 20, seen)

if __name__ == "__main__":
    unittest.main()
