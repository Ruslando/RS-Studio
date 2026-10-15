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
        # The startup update check asks GitHub, which rate-limits anonymous callers; answer it here.
        self.page.route("**/api/update", lambda route: route.fulfill(json={
            "supported": False, "current": "0", "latest": "0", "available": False, "notes": "", "can_install": False}))
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

    def test_guitar_pro_import_in_another_tempo_gets_its_own_timing(self):
        page = self.page
        state = lambda expr: page.evaluate(f"async () => {{ const {{ S }} = await import('./store.js'); return {expr}; }}")
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
        expect(page.locator("#lanes")).to_contain_text("Own tempo")
        self.loaded()
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
        expect(page.locator("#lanes")).to_contain_text("Own tempo")
        self.loaded()
        # Following the song again is a Layer settings switch, and one undo step.
        guitar = page.locator("#lanes .lane-row").filter(has_not_text="Layer 1").first
        guitar.click()
        guitar.hover()
        guitar.locator(".edit-btn").click()
        page.uncheck("#layerOwnTiming")
        page.click("#layerSave")
        expect(page.locator("#lanes")).not_to_contain_text("Own tempo")
        self.assertAlmostEqual(float(page.input_value("#offset")), song_offset, places=3)
        page.keyboard.press("Control+z")
        expect(page.locator("#lanes")).to_contain_text("Own tempo")
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
