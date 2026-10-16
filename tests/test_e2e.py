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
import zipfile
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
        # The startup update check asks GitHub, which rate-limits anonymous callers; answer it here.
        self.page.route("**/api/update", lambda route: route.fulfill(json={
            "supported": False, "current": "0", "latest": "0", "available": False, "notes": "", "can_install": False}))
        self.page.goto(self.url)
        # Registered last, so it runs first: before the page is closed.
        self.addCleanup(lambda: self.assertEqual(self.faults, [], "the app reported errors during this test"))

    def open_reference_project(self):
        page = self.page
        bundle = self.data / "reference-showcase.chart"
        with zipfile.ZipFile(bundle, "w") as archive:
            archive.write(Path(__file__).resolve().parents[1] / "examples/reference-showcase/project.json", "project.json")
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeOpen")
        chooser.value.set_files(bundle)
        expect(page.locator("#lanes .lane-row")).to_be_visible()
        self.reference_job = page.evaluate("async () => (await import('/store.js')).S.state.job")

    def test_artifact_example_and_reference_navigation(self):
        self.open_reference_project()
        page = self.page
        # Reopen through the ordinary library, as with every user project.
        page.click("#homeBtn")
        page.locator(f'#recentList [data-job="{self.reference_job}"] .ri-open').click()
        expect(page.locator("#artifactsPanel")).to_be_visible()
        expect(page.locator("#artifactList .artifact-row")).to_have_count(2)
        expect(page.locator("#artifactList .artifact-jump")).to_have_count(2)
        expect(page.locator(".artifact-preview-canvas")).to_have_count(2)
        page.locator('.artifact-row[data-reference="1"] .artifact-instance-next').click()
        motion = page.evaluate("""async () => {
            document.querySelector('#artifactList .artifact-jump').click();
            const { viewportMoving } = await import('/viewport-motion.js');
            return viewportMoving();
        }""")
        self.assertTrue(motion)
        page.wait_for_function("async () => !(await import('/viewport-motion.js')).viewportMoving()")
        state = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            return { time: S.scoreTime, selected: S.selection.size,
                scroll: document.querySelector('#scroll').scrollLeft, job: S.state.job };
        }""")
        self.assertEqual(state["time"], 16)
        self.assertEqual(state["selected"], 6)
        self.assertGreater(state["scroll"], 0)
        stored = page.request.get(f"{self.url}api/projects/{state['job']}").json()
        self.assertEqual(len(stored["editLanes"][0]["refBoxes"]["1"]["anchors"]), 2)
        page.emulate_media(reduced_motion="reduce")
        panel = page.locator("#artifactsPanel")
        original_width = panel.bounding_box()["width"]
        grip = page.locator("#artifactsResize").bounding_box()
        x, y = grip["x"] + grip["width"] / 2, grip["y"] + grip["height"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x - 80, y, steps=8)
        page.mouse.up()
        width = panel.bounding_box()["width"]
        self.assertAlmostEqual(width, original_width + 80, delta=2)
        page.click("#artifactsChevron")
        expect(panel).to_have_attribute("data-collapsed", "")
        expect(page.locator("#artifactsToggle")).to_have_attribute("aria-expanded", "false")
        self.assertTrue(page.locator("#artifactsContent").evaluate("el => el.inert"))
        page.mouse.move(700, 40)
        self.assertAlmostEqual(panel.bounding_box()["width"], 28, delta=1)
        panel.hover()
        self.assertAlmostEqual(panel.bounding_box()["width"], 40, delta=1)
        page.click("#artifactsToggle")
        expect(panel).not_to_have_attribute("data-collapsed", "")
        self.assertAlmostEqual(panel.bounding_box()["width"], width, delta=1)
        # Drag across the fold threshold, then pull back out from the narrow strip.
        grip = page.locator("#artifactsResize").bounding_box()
        x = grip["x"] + grip["width"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + width - 100, y, steps=8)
        page.mouse.up()
        expect(panel).to_have_attribute("data-collapsed", "")
        page.mouse.move(700, 40)
        page.reload()
        page.locator(f'#recentList [data-job="{self.reference_job}"] .ri-open').click()
        expect(panel).to_have_attribute("data-collapsed", "")
        page.locator("#artifactsResize").dblclick()
        expect(panel).not_to_have_attribute("data-collapsed", "")
        self.assertAlmostEqual(panel.bounding_box()["width"], width, delta=1)
        page.locator("#artifactsResize").dblclick()
        expect(panel).to_have_attribute("data-collapsed", "")
        page.mouse.move(700, 40)
        grip = page.locator("#artifactsResize").bounding_box()
        x = grip["x"] + grip["width"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x - 280, y, steps=8)
        page.mouse.up()
        expect(panel).not_to_have_attribute("data-collapsed", "")
        self.assertGreater(panel.bounding_box()["width"], 280)
        # The retained strip can be opened directly, and the edge works by keyboard.
        page.locator("#artifactsChevron").focus()
        page.keyboard.press("Enter")
        expect(panel).to_have_attribute("data-collapsed", "")
        panel.click()
        expect(panel).not_to_have_attribute("data-collapsed", "")
        # The jump reveals a hidden lane too; deletion/undo must refresh the index.
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            S.state.editLanes[0].visible = false;
        }""")
        page.locator("#artifactList .artifact-jump").first.click()
        self.assertTrue(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].visible"))
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { detachRefGroup } = await import('/references.js');
            detachRefGroup(S.state.editLanes[0], 1);
        }""")
        expect(page.locator("#artifactList .artifact-row")).to_have_count(1)
        expect(page.locator("#artifactEmpty")).to_be_hidden()
        page.keyboard.press("Control+z")
        expect(page.locator("#artifactList .artifact-row")).to_have_count(2)
        expect(page.locator("#artifactList .artifact-jump")).to_have_count(2)

    def test_reference_windows_and_instance_navigation(self):
        self.open_reference_project()
        page = self.page
        expect(page.locator('#artifactList .artifact-row')).to_have_count(2)
        expect(page.locator('#artifactCount')).to_have_text('2')
        expect(page.locator('.artifact-preview-canvas')).to_have_count(2)
        first = page.locator('.artifact-row[data-reference="1"]')
        second = page.locator('.artifact-row[data-reference="2"]')
        expect(first.locator('.artifact-instance-previous')).to_be_disabled()
        first.locator('.artifact-instance-next').click()
        expect(first.locator('.artifact-preview')).to_have_attribute('data-instance', '2')
        expect(first.locator('.artifact-instance-next')).to_be_disabled()
        expect(first.locator('.artifact-preview-canvas')).to_have_attribute('aria-label', 'Reference #1, instance 2 in Guitar motif, 6 notes')
        expect(second.locator('.artifact-instance-next')).to_be_hidden()
        first.locator('.artifact-preview').hover()
        expect(first.locator('.artifact-preview')).to_have_attribute('data-playing', '')
        second.locator('.artifact-preview').hover()
        expect(first.locator('.artifact-preview')).not_to_have_attribute('data-playing', '')
        expect(second.locator('.artifact-preview')).to_have_attribute('data-playing', '')
        first.locator('.artifact-instance-previous').click()
        expect(first.locator('.artifact-preview')).to_have_attribute('data-instance', '1')
        expect(second.locator('.artifact-preview')).not_to_have_attribute('data-playing', '')
        page.mouse.move(700, 40)
        first.locator('.artifact-reference-toggle').click()
        expect(first.locator('.artifact-preview')).to_be_hidden()
        expect(second.locator('.artifact-preview')).to_be_visible()
        page.locator('#artifactReferencesToggle').click()
        expect(page.locator('#artifactReferencesBody')).to_be_hidden()
        page.locator('#artifactReferencesToggle').focus()
        page.keyboard.press('Enter')
        expect(page.locator('#artifactReferencesBody')).to_be_visible()
        expect(first.locator('.artifact-preview')).to_be_hidden()
        first.locator('.artifact-reference-toggle').click()
        expect(first.locator('.artifact-preview')).to_be_visible()
        # Both the miniature and Move to now target the first instance again.
        first.locator('.artifact-jump').click()
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.scoreTime"), 2)

    def test_reference_hover_menu_and_live_updates(self):
        self.open_reference_project()
        page = self.page
        first = page.locator('.artifact-row[data-reference="1"]')
        preview = first.locator('.artifact-preview')
        expect(page.locator('.artifact-preview-play')).to_have_count(0)
        page.evaluate("""() => {
            window.artifactWindow = document.querySelector('.artifact-preview');
            window.previewStarted = 0;
            window.hoverStarted = performance.now();
            new MutationObserver(() => {
                if (window.artifactWindow.hasAttribute('data-playing')) window.previewStarted = performance.now();
            }).observe(window.artifactWindow, {attributes:true, attributeFilter:['data-playing']});
        }""")
        preview.hover()
        page.wait_for_timeout(200)
        expect(preview).not_to_have_attribute('data-playing', '')
        expect(preview).to_have_attribute('data-playing', '')
        self.assertGreater(page.evaluate('window.previewStarted - window.hoverStarted'), 450)
        page.mouse.move(700, 40)
        expect(preview).not_to_have_attribute('data-playing', '')
        # The ordinary editor reference menu acts on the currently displayed instance.
        first.locator('.artifact-instance-next').click()
        preview.click(button='right')
        menu = page.locator('.ctxmenu')
        for label in ('Copy', 'Cut', 'Delete this occurrence', 'Delete entire reference', 'Detach entire reference (keep notes)'):
            expect(menu.get_by_text(label, exact=True)).to_be_visible()
        menu.get_by_text('Copy', exact=True).click()
        copied = page.evaluate("async () => (await import('/store.js')).S.clipboard.map(n => n.start)")
        self.assertEqual(len(copied), 6)
        self.assertEqual(min(copied), 16)
        preview.click(button='right')
        menu.get_by_text('Cut', exact=True).click()
        expect(first.locator('.artifact-preview-title')).to_contain_text('1 / 1')
        expect(first.locator('.artifact-instance-next')).to_be_hidden()
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.length"), 11)
        page.keyboard.press('Control+z')
        expect(first.locator('.artifact-instance-next')).to_be_visible()
        # Editor changes and mirrored notes update the same existing artifact DOM.
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { snapshotEdit, commit } = await import('/edit.js');
            const lane = S.state.editLanes[0], previous = snapshotEdit();
            lane.notes = lane.notes.filter(n => n.start !== 2);
            commit(previous);
            await new Promise(requestAnimationFrame);
        }""")
        expect(first.locator('canvas')).to_have_attribute('aria-label', 'Reference #1, instance 1 in Guitar motif, 5 notes')
        self.assertTrue(page.evaluate("window.artifactWindow === document.querySelector('.artifact-preview')"))
        page.keyboard.press('Control+z')
        expect(first.locator('canvas')).to_have_attribute('aria-label', 'Reference #1, instance 1 in Guitar motif, 6 notes')

    def test_reference_preview_is_bounded_and_does_not_seek_transport(self):
        self.open_reference_project()
        page = self.page
        # Earliest in the song, even when the box array is in a different order.
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            S.state.editLanes[0].refBoxes[1].anchors.reverse();
            (await import('/repaint.js')).draw();
        }""")
        preview = page.locator('.artifact-preview').first
        preview.hover()
        expect(preview).to_have_attribute('data-playing', '')
        expect(preview).not_to_have_attribute('data-playing', '', timeout=10000)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.scoreTime"), 0)
        expect(page.locator('.toast')).to_have_count(0)
        # Leaving before the delay prevents playback altogether.
        page.mouse.move(700, 40)
        preview.hover()
        page.mouse.move(700, 40)
        page.wait_for_timeout(600)
        expect(preview).not_to_have_attribute('data-playing', '')
        # Attach actual audio through the existing project flow and audition its crop.
        with page.expect_file_chooser() as chooser:
            self.file_menu('#attachAudio')
        chooser.value.set_files(self.audio)
        expect(page.locator('#stemTabs .stem-row')).to_have_count(1, timeout=60000)
        page.evaluate("""() => {
            window.referenceAudio = [];
            for (const type of ['playing', 'timeupdate']) document.addEventListener(type, event => {
                if (event.target.classList.contains('artifact-audio')) {
                    window.referencePlayer = event.target;
                    window.referenceAudio.push({type, time: event.target.currentTime});
                }
            }, true);
        }""")
        page.locator('.artifact-preview').first.hover()
        expect(page.locator('.artifact-audio')).to_have_count(1)
        page.wait_for_function("window.referenceAudio.some(e => e.type === 'playing')")
        expect(page.locator('.artifact-preview').first).not_to_have_attribute('data-playing', '')
        events = page.evaluate('window.referenceAudio')
        self.assertAlmostEqual(events[0]['time'], 2, delta=0.2)
        last_time = max(event['time'] for event in events)
        self.assertGreater(last_time, 4.5)
        self.assertLess(last_time, 5.3)
        self.assertTrue(page.evaluate('window.referencePlayer.paused && !window.referencePlayer.isConnected'))
        expect(page.locator('.artifact-preview').first).not_to_have_attribute('data-playing', '')
        self.assertEqual(page.locator('#audio').evaluate('el => el.currentTime'), 0)
        # Arrowing to another instance must audition that recording slice as well.
        page.locator('.artifact-row[data-reference="1"] .artifact-instance-next').click()
        page.evaluate('window.referenceAudio = []')
        page.locator('.artifact-preview').first.hover()
        page.wait_for_function("window.referenceAudio.some(e => e.type === 'playing')")
        expect(page.locator('.artifact-preview').first).not_to_have_attribute('data-playing', '')
        events = page.evaluate('window.referenceAudio')
        self.assertAlmostEqual(events[0]['time'], 16, delta=0.2)
        self.assertEqual(page.locator('#audio').evaluate('el => el.currentTime'), 0)

    def open_guitar_pro_project(self):
        page = self.page
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeGp")
        chooser.value.set_files(self.data / "song.gp5")
        expect(page.locator("#gpImportTracks")).to_contain_text("8 notes")
        page.click("#gpImportConfirm")
        expect(page.locator("#lanes")).to_contain_text("8 notes")
        self.loaded()
        expect(page.locator("#tabViewBackdrop")).to_be_hidden()   # an import stays on the editor

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
        self.loaded()

    def loaded(self):
        """The loading screen is gone. It fades out after the editor is already there,
        and until then it takes the clicks and swallows the keys meant for the editor."""
        expect(self.page.locator(".project-loading-backdrop")).to_have_count(0)

    def rail_point(self, t):
        """Viewport point on the tempo-flag rail at song time t, asked of the app at the
        moment of use: the view may still be laid out again after a project opens."""
        return self.page.evaluate("""async (t) => {
            const { xOf } = await import("./geometry.js");
            const { drawNow } = await import("./repaint.js");
            drawNow();   // the flags' hit areas are built by the paint
            const r = document.getElementById("stage").getBoundingClientRect();
            return [r.left + xOf(t) - document.getElementById("scroll").scrollLeft + 5, r.top + 10];
        }""", t)

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
        # The stepper beside a number counts it up and down by the field's own step.
        page.click("#rsVersion ~ .stepper-nudge [aria-label=Increase]")
        expect(page.locator("#rsVersion")).to_have_value("2")
        page.click(".stepper:has(#rsLeadIn) [aria-label=Decrease]")
        expect(page.locator("#rsLeadIn")).to_have_value("4.5")
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
        # A new project's grid is already 1/32, so detection asks nothing about the grid.
        expected = tutorial.PHRASE * tutorial.REPEATS
        expect(page.locator("#lanes")).to_contain_text(f"{len(expected)} notes", timeout=180000)

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
        # A new note is a quarter long, whatever the grid division.
        quarter, length = page.evaluate("""async () => {
            const { S } = await import("./store.js");
            const { gridAt } = await import("./grid.js");
            const n = S.state.editLanes.flatMap((l) => l.notes)[0];
            return [60 / gridAt(n.start).bpm, n.end - n.start];
        }""")
        self.assertAlmostEqual(length, quarter, places=6)
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

    def test_dragging_a_tempo_marker_carries_what_is_in_its_span(self):
        page = self.page
        self.new_audio_project()
        # Tempo markers at 2 s and 4 s; a section flag and a note before, inside and
        # after the first span, and a tone marker inside it.
        page.evaluate("""async () => {
            const { S } = await import("./store.js");
            const { addMarker, snap } = await import("./grid.js");
            const { drawNow } = await import("./repaint.js");   // now: the flags' hit areas are built by the paint
            addMarker(2); addMarker(4);
            S.state.sectionMarkers = [1, 3, 5].map((t) => ({ id: "s" + t, t, type: "verse", name: "" }));
            const lane = S.state.editLanes[0];
            lane.toneMarkers = [{ id: "tone1", t: 3, tone: "A" }];
            lane.notes = [1, 3, 5].map((t) => ({ start: snap(t), end: t + 0.25, pitch: 45, string: 5, fret: 0 }));
            drawNow();
        }""")
        times = lambda: page.evaluate("""async () => {
            const { S } = await import("./store.js");
            const lane = S.state.editLanes[0];
            return [S.state.sectionMarkers.map((m) => m.t), lane.notes.map((n) => n.start).sort((a, b) => a - b),
                    lane.toneMarkers[0].t];
        }""")
        def drag(t, by, then=None):
            (x, y), (x1, _) = self.rail_point(t), self.rail_point(t + by)
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x1, y, steps=6)
            if then: then()
            page.mouse.up()

        def near(got, want):
            for g, w in zip(got, want):
                self.assertAlmostEqual(g, w, delta=0.02)

        on_grid = times()[1]   # each note sits on its own span's gridline

        def moved_while_dragging():   # live, not on release
            sections, notes, tone = times()
            a, b, c = on_grid
            near(sections + notes + [tone], [1, 3.5, 5, a, b + 0.5, c, 3.5])

        drag(2, 0.5, then=moved_while_dragging)
        moved_while_dragging()
        page.keyboard.press("Control+z")
        self.assertEqual(times(), [[1, 3, 5], on_grid, 3])
        # The start flag carries only its own span (up to 2 s), not the whole song.
        drag(float(page.input_value("#offset")), 0.5)
        sections, notes, tone = times()
        a, b, c = on_grid
        near(sections + notes + [tone], [1.5, 3, 5, a + 0.5, b, c, 3])
        page.keyboard.press("Control+z")
        # Typing a marker's time is the same move as dragging its flag.
        page.mouse.click(*self.rail_point(2))
        page.fill("#markerTime", "2.5")
        page.click("#markerPopClose")
        sections, notes, tone = times()
        near(sections + notes + [tone], [1, 3.5, 5, a, b + 0.5, c, 3.5])
        page.keyboard.press("Control+z")
        self.assertEqual(times(), [[1, 3, 5], on_grid, 3])

    def test_a_note_dragged_into_another_tempo_lands_on_its_grid(self):
        page = self.page
        self.new_audio_project()
        page.evaluate("""async () => {
            const { S } = await import("./store.js");
            const { addMarker } = await import("./grid.js");
            const { drawNow } = await import("./repaint.js");   // now: the flags' hit areas are built by the paint
            addMarker(2); addMarker(4).bpm = 90;
            S.state.editLanes[0].notes = [{ start: 3, end: 3.25, pitch: 45, string: 5, fret: 0 }];
            drawNow();
        }""")
        (x, y), (x1, _) = self.rail_point(2), self.rail_point(3.3)
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x1, y, steps=6)   # the note crosses the 90 BPM flag at 4 s
        page.mouse.up()
        start, cells = page.evaluate("""async () => {
            const { S } = await import("./store.js");
            const { gridAt, segStep } = await import("./grid.js");
            const n = S.state.editLanes[0].notes[0], seg = gridAt(n.start);
            return [n.start, (n.start - seg.t) / segStep(seg)];
        }""")
        self.assertGreater(start, 4)
        self.assertAlmostEqual(cells, round(cells), places=6)

    def test_tempo_marker_position_follows_the_flag_and_scrubs(self):
        page = self.page
        self.new_audio_project()
        page.evaluate("""async () => {
            const { addMarker } = await import("./grid.js");
            const { drawNow } = await import("./repaint.js");   // now: the flags' hit areas are built by the paint
            addMarker(2); drawNow();
        }""")
        marker_t = lambda: page.evaluate("async () => (await import('./store.js')).S.state.tempoMap[0].t")
        (x, y), (x1, _) = self.rail_point(2), self.rail_point(2.5)
        page.mouse.click(x, y)                               # open its popover
        expect(page.locator("#markerPop")).to_be_visible()
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x1, y, steps=6)
        self.assertAlmostEqual(float(page.input_value("#markerTime")), marker_t(), places=3)   # live
        self.assertAlmostEqual(marker_t(), 2.5, delta=0.02)
        page.mouse.up()
        # Drag sideways on the Position field: 10 ms per pixel.
        before = marker_t()
        field = page.locator("#markerTime").bounding_box()
        fx, fy = field["x"] + field["width"] / 2, field["y"] + field["height"] / 2
        page.mouse.move(fx, fy)
        page.mouse.down()
        page.mouse.move(fx + 50, fy, steps=5)
        page.mouse.up()
        self.assertAlmostEqual(marker_t(), before + 0.5, delta=0.011)
        self.assertAlmostEqual(float(page.input_value("#markerTime")), marker_t(), places=3)
        page.click("#markerPopClose")
        page.keyboard.press("Control+z")                     # the popover session is one step
        self.assertEqual(marker_t(), 2)

    def test_layer_and_bus_volumes_are_dragged_and_muted_in_the_sidebar(self):
        page = self.page
        state = lambda expr: page.evaluate(f"async () => {{ const {{ S }} = await import('./store.js'); return {expr}; }}")
        def drag(control, dx):
            box = control.bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + dx, y, steps=5)
            page.mouse.up()
        self.new_audio_project()
        layer = page.locator("#lanes .lane-row .vol").first
        notes_bus = page.locator("#layersSection .side-header .vol")
        audio_bus = page.locator("#stemsSection .side-header .vol")
        expect(layer).to_have_text("100")
        drag(layer, -60)                                     # half a percent a pixel
        expect(layer).to_have_text("70")
        self.assertFalse(state("S.state.editLanes[0].muted"), "a drag is not a click")
        layer.click()
        self.assertTrue(state("S.state.editLanes[0].muted"))
        drag(audio_bus, -100)
        expect(audio_bus).to_have_text("50")
        notes_bus.click()
        expect(notes_bus).to_have_attribute("aria-pressed", "true")
        expect(layer).to_have_class(re.compile(r"\bdim\b"))   # silent by its bus
        # The mixer is the project's.
        page.keyboard.press("Control+s")
        expect(page.locator("#projDirtyDot")).to_be_hidden()
        self.home()
        page.get_by_role("button", name="Open E2E Audio").first.click()
        self.loaded()
        expect(layer).to_have_text("70")
        expect(layer).to_have_attribute("aria-pressed", "true")
        expect(audio_bus).to_have_text("50")
        expect(notes_bus).to_have_attribute("aria-pressed", "true")

    def test_guitar_pro_import_in_another_tempo_gets_its_own_timing(self):
        page = self.page
        state = lambda expr: page.evaluate(f"async () => {{ const {{ S }} = await import('./store.js'); return {expr}; }}")
        own = lambda: state("S.state.editLanes.filter((l) => l.timing).length")   # layers on a timing of their own
        rows = page.locator("#lanes .lane-row")
        self.new_audio_project()   # its detected grid does not start at 0, the file's does
        page.dblclick("#stage", position={"x": 300, "y": 300})
        page.evaluate("""async () => {
            const { S } = await import("./store.js");
            S.state.sectionMarkers = [{ id: "song_verse", t: 1, type: "verse", name: "" }];
        }""")
        song_offset = float(page.input_value("#offset"))
        page.click("#fileMenuBtn")
        with page.expect_file_chooser() as chooser:
            page.click("#importGp")
        chooser.value.set_files(self.data / "song.gp5")
        page.click("#gpImportConfirm")
        expect(rows).to_have_count(2)
        self.loaded()
        self.assertEqual(own(), 1)
        # The imported layer is active: its grid and sections are on screen, not the song's.
        self.assertEqual(float(page.input_value("#offset")), 0)
        self.assertNotIn("song_verse", state("S.state.sectionMarkers.map((m) => m.id)"))
        # Back on Layer 1, the song's are.
        page.locator("#lanes .lane-row", has_text="Layer 1").click()
        self.assertAlmostEqual(float(page.input_value("#offset")), song_offset, places=3)
        self.assertIn("song_verse", state("S.state.sectionMarkers.map((m) => m.id)"))
        # It survives saving and reopening.
        page.keyboard.press("Control+s")
        expect(page.locator("#projDirtyDot")).to_be_hidden()   # the save has landed
        self.home()
        page.get_by_role("button", name="Open E2E Audio").first.click()
        expect(rows).to_have_count(2)
        self.loaded()
        self.assertEqual(own(), 1)
        # Following the song again is a Layer settings switch, and one undo step.
        guitar = page.locator("#lanes .lane-row").filter(has_not_text="Layer 1").first
        guitar.click()
        guitar.hover()
        guitar.locator(".edit-btn").click()
        page.uncheck("#layerOwnTiming")
        page.click("#layerSave")
        expect(page.locator("#layerSettingsBackdrop")).to_be_hidden()
        self.assertEqual(own(), 0)
        self.assertAlmostEqual(float(page.input_value("#offset")), song_offset, places=3)
        page.keyboard.press("Control+z")
        self.assertEqual(own(), 1)
        self.assertEqual(float(page.input_value("#offset")), 0)

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

    def test_tunings_are_their_strings_and_outlive_the_window(self):
        page = self.page
        self.open_guitar_pro_project()
        # The file's E A D G B E is E Standard, not a nameless tuning.
        expect(page.locator("#lanes .lane-row").first).to_contain_text("E Standard")
        page.click("#settingsMenuBtn")
        page.click("[data-settings-pane=tunings]")
        page.click("#tuningNewBtn")                       # E Standard's strings: not yet a tuning of its own
        expect(page.locator("#tuningEditor .status-line")).to_contain_text("Standard")
        page.click("#tuningEditor .tuning-whole-btn >> nth=0")   # down a semitone: still D# Standard's
        page.click("#tuningEditor .tuning-whole-btn >> nth=0")   # D Standard's
        page.click("#tuningEditor .tuning-whole-btn >> nth=0")   # C#
        page.click("#tuningEditor .tuning-whole-btn >> nth=0")   # C
        page.click("#tuningEditor .tuning-whole-btn >> nth=0")   # B Standard: no built-in has it
        expect(page.locator("#tuningEditor .status-line")).to_have_count(0)
        page.fill("#tuningEditor .tuning-name", "My tuning")
        expect(page.locator("#tuningEditor").get_by_role("button", name="Duplicate")).to_have_count(0)
        # A built-in's strings, unchanged, are that built-in: Save is refused.
        page.locator(".tuning-item", has_text="Drop D").first.click()
        expect(page.locator("#tuningEditor").get_by_role("button", name="Save")).to_be_disabled()
        page.click("#settingsApply")
        expect(page.locator("#settingsModalBackdrop")).to_be_hidden()
        # A new window keeps it: it is the server's, not the window's.
        page.reload()
        page.click("#welcomeSettingsBtn")
        page.click("[data-settings-pane=tunings]")
        expect(page.locator(".tuning-item", has_text="My tuning")).to_have_count(1)

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
        # The demo song starts on its real grid, at detection's 1/32.
        expect(page.locator("#bpm")).to_have_value("120")
        expect(page.locator("#offset")).to_have_value("0.35")
        expect(page.locator("#subdiv")).to_have_value("8")
        seen = []
        while not card.locator(".tour-home").is_visible():
            self.assertLess(len(seen), 400, "the walkthrough does not end")
            seen.append(head.inner_text())
            card.locator(".tour-next").click()          # "Next", or "Skip" on a card that waits for a task
            expect(head).not_to_have_text(seen[-1])
        self.assertGreater(len(seen), 20, seen)
        self.assertIn("Introduction", seen[0])
        self.assertNotIn("Introduction", seen[1])   # the chapter is just the welcome card
        self.assertIn("Overview", seen[1])

if __name__ == "__main__":
    unittest.main()
