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
from rs_studio.rocksmith import builder as rocksmith_builder
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
        # Existing interaction tests use a fixed rig to exercise EQ, pedal banks
        # and keyboard editing. The JSON workflow test below uses the real folder.
        if self._testMethodName.startswith("test_sound_") and not self._testMethodName.startswith("test_sound_json_"):
            source = (Path(__file__).resolve().parents[1] / "web/sound-catalog.js").read_text("utf-8")
            bases = json.loads(source.split("export const SOUND_BASES = ", 1)[1].strip().removesuffix(";"))
            self.page.route("**/api/sound-presets", lambda route: route.fulfill(json={
                "folder": "Fixture presets", "errors": [],
                "presets": [{"id": key, "tone": tone} for key, tone in bases.items()]}))
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

    def pick_sound_gear(self, key):
        if not self.page.locator("#soundGearDialog").is_visible():
            self.page.locator('#soundChain [aria-pressed="true"]').click()
        self.page.locator("#soundGearSelect").select_option(key)
        self.page.click("#soundGearApply" if self.page.locator("#soundGearApply").is_visible() else "#soundGearClose")

    def pick_sound_mic(self, mic, position):
        self.page.get_by_role("radiogroup", name="Cabinet microphone").get_by_role("radio", name=mic, exact=True).check()
        self.page.get_by_role("radiogroup", name="Microphone position").get_by_role("radio", name=position, exact=True).check()

    def pick_sound_switch(self, group, option):
        self.page.get_by_role("radiogroup", name=group, exact=True).get_by_role("radio", name=option, exact=True).check()

    def add_sound_effect(self, bank):
        self.page.get_by_role("button", name=f"Add {bank} effects", exact=True).click()
        self.page.click("#soundGearApply")

    def apply_settings_and_close(self):
        self.page.click("#settingsApply")
        expect(self.page.locator("#settingsModalBackdrop")).to_be_visible()
        expect(self.page.locator("#settingsApply")).to_be_hidden()
        self.page.click("#settingsModalClose")

    def test_model_download_refreshes_pickers_and_displays_supported_modes(self):
        page = self.page
        ready = False

        def separators(route):
            route.fulfill(json=[
                {"id": "demucs", "label": "Demucs", "available": True,
                 "stems": [{"id": "bass", "label": "Bass"}]},
                {"id": "roformer", "label": "BS-RoFormer", "available": ready,
                 "reason": "" if ready else "Not downloaded",
                 "stems": [{"id": "bass", "label": "Bass"}]},
            ])

        page.route("**/api/separators", separators)
        page.route("**/api/version", lambda route: route.fulfill(json={
            "version": "0.5.0rc1", "variant": "CUDA", "cuda_available": False}))
        page.route("**/api/setup", lambda route: route.fulfill(json={"complete": True}))
        page.reload()
        expect(page.locator("#welcomeVersion")).to_have_text("v0.5.0rc1 · CUDA version")
        expect(page.locator("#welcomeVersion")).to_have_attribute("title", re.compile("no CUDA device"))
        self.new_audio_project()
        page.click("#stemTabs .layer-add")
        option = page.locator('.stem-add-menu option[value="roformer"]')
        expect(option).to_be_disabled()
        expect(option).to_have_text("BS-RoFormer — Not downloaded")
        page.keyboard.press("Escape")

        # Completion while the picker is closed must work even if Settings has
        # stopped polling. No page reload or app restart is involved.
        ready = True
        page.click("#stemTabs .layer-add")
        expect(option).to_be_enabled()
        page.locator('.stem-add-menu select[aria-label="Separation model"]').select_option("roformer")
        page.keyboard.press("Escape")
        ready = False
        page.click("#stemTabs .layer-add")
        expect(option).to_be_disabled()
        page.keyboard.press("Escape")

        # Inventory rendering also publishes changes to existing picker data.
        await_render = """async () => {
            const root = document.createElement('div');
            root.innerHTML = '<div class="model-status"></div><div class="model-list-separation"></div><div class="model-list-detection"></div>';
            document.body.append(root);
            root.id = 'modelTest';
            await (await import('/models.js')).renderModels(root);
        }"""
        page.route("**/api/models", lambda route: route.fulfill(json=[{
            "id": "roformer", "label": "BS-RoFormer", "kind": "Stem separation",
            "state": "ready", "modes": ["cpu", "cuda"], "size": 100,
            "downloadable": True, "files": ["model.ckpt"]}]))
        ready = True
        page.evaluate(await_render)
        expect(page.locator("#modelTest .model-mode")).to_have_text(["CPU", "CUDA"])
        page.wait_for_function("async () => (await import('/separators.js')).separators.find(model => model.id === 'roformer')?.available")
        page.evaluate("document.getElementById('modelTest').remove()")

    def test_update_dialog_checks_both_channels_and_survives_reload(self):
        page = self.page
        page.request.post(self.url + 'api/update/channel', data={'channel': 'stable'})
        self.addCleanup(lambda: page.request.post(self.url + 'api/update/channel', data={'channel': 'stable'}))
        installs = []
        page.route('**/api/update/install', lambda route: (installs.append(True), route.fulfill(json={'ok': True})))

        def update_feed(route):
            state = json.loads((self.data / 'update-channel.json').read_text())
            preview = state['channel'] == 'preview'
            route.fulfill(json={'supported': True, 'current': '0.3.0-alpha',
                'latest': '0.5.0-rc.1' if preview else '0.3.0-alpha', 'available': preview,
                'notes': 'Preview release notes', 'can_install': True})
        page.route('**/api/update', update_feed)
        page.reload()
        page.click('#welcomeUpdateBtn')
        expect(page.locator('#actionConfirmModal')).to_be_visible()
        expect(page.locator('#actionConfirmMsg')).to_have_text('You are up to date.')
        expect(page.locator('#updateDialogChannel')).to_have_value('stable')
        expect(page.locator('#updateDialogChannel option[value="stable"]')).to_have_text('Stable')
        expect(page.locator('#updateDialogChannel')).to_be_enabled()
        shots = Path(__file__).resolve().parents[1] / 'design-shots'
        shots.mkdir(exist_ok=True)
        page.locator('#actionConfirmModal').screenshot(path=str(shots / 'updates-current.png'))
        page.select_option('#updateDialogChannel', 'preview')
        expect(page.locator('#actionConfirmTitle')).to_have_text('RS Studio 0.5.0-rc.1')
        expect(page.locator('#actionConfirmMsg')).to_have_text('Preview release notes')
        expect(page.locator('#actionConfirmAccept')).to_have_text('Update now')
        page.locator('#actionConfirmModal').screenshot(path=str(shots / 'updates-available.png'))
        self.assertEqual(page.locator('#updateDialogChannel').count(), 1)
        self.assertEqual(page.request.get(self.url + 'api/update/channel').json()['channel'], 'preview')
        self.assertEqual(installs, [], 'Choosing a channel must not install an update')
        page.keyboard.press('Escape')
        expect(page.locator('#updateDialogChannel')).to_have_count(0)
        page.reload()
        page.click('#welcomeSettingsBtn')
        for pane in ['appearance', 'trace', 'tunings', 'sounds', 'keys', 'models']:
            page.click(f'[data-settings-pane="{pane}"]')
            self.assertEqual(page.locator('#settingsModal .pane-intro p').count(), 0)
        expect(page.locator('#settingsApply')).to_be_hidden()
        expect(page.locator('[data-settings-pane=acceleration], [data-settings-pane=updates], #spAcceleration, #spUpdates')).to_have_count(0)
        page.click('#settingsModalClose')
        page.click('#welcomeUpdateBtn')
        expect(page.locator('#updateDialogChannel')).to_have_value('preview')
        expect(page.locator('#actionConfirmAccept')).to_have_text('Update now')
        page.select_option('#updateDialogChannel', 'stable')
        expect(page.locator('#actionConfirmMsg')).to_have_text('You are up to date.')
        expect(page.locator('#actionConfirmAccept')).to_have_text('Close')
        page.click('#actionConfirmAccept')
        expect(page.locator('#actionConfirmModal')).to_be_hidden()
        expect(page.locator('#settingsModal')).to_be_hidden()
        self.assertEqual(installs, [])

    def test_update_dialog_installs_only_after_confirmation(self):
        page = self.page
        installs = []
        page.route('**/api/update', lambda route: route.fulfill(json={
            'supported': True, 'current': '0.3.0-alpha', 'latest': '0.5.0-rc.1',
            'available': True, 'notes': 'Release notes', 'can_install': True}))
        def install(route):
            installs.append(route.request.method)
            route.fulfill(json={'ok': True})
        page.route('**/api/update/install', install)
        page.click('#welcomeUpdateBtn')
        expect(page.locator('#actionConfirmAccept')).to_have_text('Update now')
        self.assertEqual(installs, [])
        page.click('#actionConfirmCancel')
        self.assertEqual(installs, [])
        page.click('#welcomeUpdateBtn')
        expect(page.locator('#actionConfirmAccept')).to_have_text('Update now')
        with page.expect_request('**/api/update/install'):
            page.click('#actionConfirmAccept')
        self.assertEqual(installs, ['POST'])

    def test_update_dialog_disables_unsupported_channel_changes_and_cleans_up(self):
        page = self.page
        page.route('**/api/update/channel', lambda route: route.fulfill(json={
            'channel': 'stable', 'can_change_channel': False}))
        page.click('#welcomeUpdateBtn')
        expect(page.locator('#actionConfirmMsg')).to_have_text('You are up to date.')
        expect(page.locator('#updateDialogChannel')).to_be_disabled()
        expect(page.locator('#updateDialogChannel')).to_have_attribute('title', re.compile('Setup'))
        page.keyboard.press('Escape')

    def test_update_dialog_shows_manual_update_for_source_copies(self):
        page = self.page
        page.route('**/api/update', lambda route: route.fulfill(json={
            'supported': False, 'current': '0.3.0-alpha', 'latest': '0.5.0-rc.1',
            'available': True, 'notes': 'Release notes', 'can_install': False}))
        page.click('#welcomeUpdateBtn')
        expect(page.locator('#actionConfirmMsg')).to_contain_text('git pull')
        expect(page.locator('#actionConfirmAccept')).to_have_text('Close')
        expect(page.locator('#updateDialogChannel')).to_be_enabled()
        page.click('#actionConfirmAccept')
        expect(page.locator('#actionConfirmModal')).to_be_hidden()
        page.evaluate("() => { import('/dialog.js').then(m => m.confirmChoice({title:'Other action', message:'Confirm action', confirmLabel:'Proceed'})); }")
        expect(page.locator('#actionConfirmTitle')).to_have_text('Other action')
        expect(page.locator('#actionConfirmMsg')).to_have_text('Confirm action')
        expect(page.locator('#updateDialogChannel')).to_have_count(0)
        expect(page.locator('#actionConfirmAccept')).to_have_text('Proceed')
        expect(page.locator('#actionConfirmAccept')).to_be_enabled()
        page.keyboard.press('Escape')

    def test_appearance_previews_keep_their_theme_when_app_theme_changes(self):
        page = self.page
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane="appearance"]')
        previews = page.locator('.theme-preview-surface')
        expect(previews).to_have_count(2)
        colors = {}
        for theme in ['dark', 'light']:
            page.locator(f'#spAppearance .preview-choice:has(input[value="{theme}"]) .theme-preview-surface').click()
            expect(page.locator(f'input[name="theme"][value="{theme}"]')).to_be_checked()
            current = previews.evaluate_all('els => els.map(el => ({background: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color, action: getComputedStyle(el.querySelector(".welcome-start")).backgroundColor}))')
            self.assertNotEqual(current[0]['background'], current[1]['background'])
            self.assertNotEqual(current[0]['text'], current[1]['text'])
            self.assertNotEqual(current[0]['action'], current[1]['action'])
            colors[theme] = current
            self.assertEqual(page.locator('#spAppearance select').count(), 0)
            for preview in [previews.nth(0), previews.nth(1)]:
                self.assertEqual(preview.locator('[id]').count(), 0)
                expect(preview.locator('.theme-preview-content')).to_have_attribute('inert', '')
                self.assertEqual(preview.locator('.welcome-opt').all_text_contents(), page.locator('#welcome .welcome-opt').all_text_contents())
                self.assertEqual(preview.locator('.wo-icon svg').count(), page.locator('#welcome .wo-icon svg').count())
            shots = Path(__file__).resolve().parents[1] / 'design-shots'
            shots.mkdir(exist_ok=True)
            page.locator('#settingsModal').screenshot(path=str(shots / f'appearance-{theme}.png'))
        self.assertEqual(colors['dark'], colors['light'])
        page.click('#settingsApply')
        page.click('#settingsModalClose')
        page.reload()
        page.click('#welcomeSettingsBtn')
        expect(page.locator('input[name="theme"][value="light"]')).to_be_checked()
        page.locator('input[name="theme"][value="light"]').focus()
        page.keyboard.press('ArrowLeft')
        expect(page.locator('input[name="theme"][value="dark"]')).to_be_checked()
        page.keyboard.press('Escape')
        page.click('#welcomeSettingsBtn')
        expect(page.locator('input[name="theme"][value="light"]')).to_be_checked()

    def test_playback_started_inside_a_note_is_audible_and_resumes_after_seek(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S,setSelection} = await import('/store.js');
            const {warmSynths,seekPlayback} = await import('/playback.js');
            const lane = S.state.editLanes[0];
            lane.refBoxes = {}; lane.muted = false; lane.volume = 1;
            lane.notes = [{id:'sustain_c',start:.5,end:6,pitch:60},
                {id:'sustain_e',start:.5,end:6,pitch:64}];
            S.voicingRevision++; S.detectRegion = null; setSelection(new Set());
            warmSynths(); await Tone.loaded();
            const synth = lane._synth, attack = synth.triggerAttack;
            window.__midNoteAttacks = [];
            synth.triggerAttack = function(...args) {
                window.__midNoteAttacks.push(args[0]); return attack.apply(this,args);
            };
            window.__midNoteAnalyser = new Tone.Analyser('waveform',512).toDestination();
            synth.connect(window.__midNoteAnalyser);
            seekPlayback(2); document.activeElement.blur();
        }""")
        page.locator('#play').click()
        page.wait_for_function("""() => window.__midNoteAttacks.length >= 2 &&
            window.__midNoteAnalyser.getValue().some(value => Math.abs(value) > .0001)""", timeout=3000)
        self.assertEqual(page.evaluate('window.__midNoteAttacks'), ['C4','E4'])
        page.wait_for_timeout(150)
        self.assertEqual(page.evaluate('window.__midNoteAttacks.length'), 2, 'held notes are not reattacked by each tick')
        page.evaluate("async () => (await import('/playback.js')).seekPlayback(3)")
        page.wait_for_function('window.__midNoteAttacks.length >= 4')
        self.assertEqual(page.evaluate('window.__midNoteAttacks.slice(-2)'), ['C4','E4'])
        page.locator('#play').click()
        before_resume = page.evaluate('window.__midNoteAttacks.length')
        page.locator('#play').click()
        page.wait_for_function('before => window.__midNoteAttacks.length >= before+2', arg=before_resume)
        self.assertEqual(page.evaluate('window.__midNoteAttacks.slice(-2)'), ['C4','E4'])
        page.locator('#play').click()

    def test_rocksmith_issues_follow_the_chart_while_it_is_edited(self):
        page = self.page
        note = lambda i, start, fret, **fx: {"id": f"n{i}", "start": start, "end": start + 1, "pitch": 55 + fret,
                                             "pos": {"string": 3, "fret": fret, "scope": "local"}, **fx}
        lane = {"id": "edit", "name": "Lead", "kind": "edit", "color": "#6ee7b7", "visible": True, "active": True,
                "instrument": "electric", "tablatureEnabled": True, "tuning": "guitar6", "capo": 0,
                "rocksmithArrangement": "lead",
                "notes": [note(1, 2.0, 12, harmonic="natural", bend="full"), note(2, 4.0, 5)]}
        project = {"name": "Rocksmith check", "duration": 12.0, "scoreDuration": 12.0, "editLanes": [lane],
                   "grid": {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4, "subdiv": 2, "tempoMap": []},
                   "sectionMarkers": [], "stems": [], "metadata": {"title": "Check", "artist": "E2E"}}
        bundle = self.data / "rocksmith-check.chart"
        with zipfile.ZipFile(bundle, "w") as archive:
            archive.writestr("project.json", json.dumps(project))
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeOpen")
        chooser.value.set_files(bundle)
        # The export's own checker reports the harmonic bend once edits settle.
        row = page.locator("#rocksmithIssues .artifact-issue-row", has_text="Natural harmonic with bend")
        expect(row).to_be_visible()
        self.assertIn("I35", row.get_attribute("title"))
        row.click()
        time_at = lambda: page.evaluate("async () => (await import('/playback.js')).playbackTime()")
        self.assertAlmostEqual(time_at(), 2.0, places=2)
        # Delete that note: the issue goes, and an empty list hides its section.
        page.mouse.move(700, 200)
        page.keyboard.press("ArrowRight")
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("Delete")
        expect(page.locator("#rocksmithIssues .artifact-issue-row")).to_have_count(0)
        expect(page.locator("#artifactRocksmithBody")).to_be_hidden()

    def test_arrow_navigation_steps_back_from_the_focused_chord(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S,setSelection} = await import('/store.js');
            const lane = S.state.editLanes[0];
            lane.refBoxes = {}; lane.notes = [
                {id:'nav0',start:1,end:1.4,pitch:40},
                {id:'nav1',start:2,end:2.4,pitch:45},
                {id:'nav1b',start:2.005,end:2.4,pitch:49},
                {id:'nav2',start:3,end:3.4,pitch:52}];
            (await import('/playback.js')).seekPlayback(1);
            setSelection(new Set([lane.notes[0]]));
            (await import('/repaint.js')).drawNow();
            document.activeElement.blur();
        }""")
        page.mouse.move(700, 200)
        time_at = lambda: page.evaluate("async () => (await import('/playback.js')).playbackTime()")
        page.keyboard.press('ArrowRight')
        self.assertAlmostEqual(time_at(), 2)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.selection.size"), 2)
        # Model the coarse time reported after a real media seek.
        page.evaluate("async () => { (await import('/store.js')).S.scoreTime = 2.005; }")
        page.keyboard.press('ArrowLeft')
        self.assertAlmostEqual(time_at(), 1)
        for key, expected in [('ArrowRight',2),('ArrowRight',3),('ArrowLeft',2),('ArrowLeft',1),('ArrowLeft',1)]:
            page.keyboard.press(key)
            self.assertAlmostEqual(time_at(), expected)

    def test_plain_drag_pans_and_ctrl_drag_draws_without_changing_clicks(self):
        self.open_reference_project()
        page = self.page
        start = page.evaluate("""async () => {
            const {S,setSelection} = await import('/store.js');
            const {zoomBothTo} = await import('/geometry.js');
            const {traceSnapInput} = await import('/dom.js');
            const lane = S.state.editLanes[0];
            lane.refBoxes = {}; lane.notes = [{id:'keep',start:.5,end:1,pitch:60}];
            lane.toneMarkers = []; lane.phraseBoundaries = []; lane.handHolds = [];
            S.state.sectionMarkers = []; S.state.tempoMap = []; S.detectRegion = null;
            const image = document.createElement('canvas'); image.width = 500; image.height = 73;
            const ctx = image.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0,0,500,73);
            S.spectImg = image; (await import('/tracing.js')).prepareSpectSample();
            traceSnapInput.checked = false;
            const stage = document.querySelector('#stage'), scroll = document.querySelector('#scroll');
            const rect = stage.getBoundingClientRect();
            zoomBothTo(3, rect.left + rect.width/2, rect.top + rect.height/2);
            (await import('/playback.js')).seekPlayback(1.25);
            setSelection(new Set(lane.notes)); S.undoStack = []; S.redoStack = [];
            scroll.scrollLeft = 300; scroll.scrollTop = 200;
            (await import('/repaint.js')).drawNow();
            const r = stage.getBoundingClientRect();
            return [r.left + r.width*.65, r.top + r.height*.65];
        }""")
        state = lambda: page.evaluate("""async () => {
            const {S} = await import('/store.js'); const scroll = document.querySelector('#scroll');
            return {left:scroll.scrollLeft,top:scroll.scrollTop,notes:S.state.editLanes[0].notes,
                selection:[...S.selection].map(n=>n.id),undo:S.undoStack.length,
                time:(await import('/playback.js')).playbackTime()};
        }""")
        before = state()
        page.mouse.move(*start); page.mouse.down()
        page.mouse.move(start[0]-100, start[1]-80, steps=10)
        expect(page.locator('#stage')).to_have_css('cursor', 'grabbing')
        page.wait_for_timeout(120)  # Release after stopping, so this is a pan rather than a flick.
        page.mouse.up()
        after = state()
        self.assertAlmostEqual(after['left']-before['left'], 100)
        self.assertAlmostEqual(after['top']-before['top'], 80)
        for key in ['notes','selection','undo','time']:
            self.assertEqual(after[key], before[key], key)
        expected_time = page.evaluate("""async ([x,y]) => {
            const rect = document.querySelector('#stage').getBoundingClientRect();
            return (await import('/geometry.js')).timeAt(x-rect.left+document.querySelector('#scroll').scrollLeft);
        }""", start)
        page.mouse.click(*start)
        self.assertAlmostEqual(state()['time'], expected_time,
                               delta=1/page.evaluate("async () => (await import('/store.js')).S.pxPerSec"))
        self.assertEqual(state()['selection'], [])
        self.assertEqual(state()['notes'], before['notes'])
        # With Ctrl held, the same empty-space drag draws rather than pans.
        before_draw = state()
        page.keyboard.down('Control')
        page.mouse.move(*start); page.mouse.down()
        page.mouse.move(start[0]+120, start[1], steps=12)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.drag.mode"), 'trace')
        page.mouse.up(); page.keyboard.up('Control')
        drawn = state()
        self.assertGreater(len(drawn['notes']), len(before['notes']))
        self.assertEqual(drawn['left'], before_draw['left'])
        self.assertEqual(drawn['top'], before_draw['top'])
        self.assertEqual(drawn['undo'], 1)
        page.keyboard.press('Control+z')
        self.assertEqual(state()['notes'], before['notes'])
        page.mouse.dblclick(*start)
        self.assertEqual(len(state()['notes']), len(before['notes']) + 1, 'plain double-click still inserts a note')
        page.keyboard.press('Control+z')
        self.assertEqual(state()['notes'], before['notes'])

    def test_panning_coasts_after_a_flick_and_new_input_stops_it(self):
        self.open_reference_project()
        page = self.page
        start = page.evaluate("""async () => {
            const {S,setSelection} = await import('/store.js');
            const lane = S.state.editLanes[0]; lane.notes = []; lane.refBoxes = {};
            lane.handHolds = []; lane.phraseBoundaries = []; lane.toneMarkers = [];
            S.detectRegion = null;
            const stage = document.querySelector('#stage'), scroll = document.querySelector('#scroll');
            const rect = stage.getBoundingClientRect();
            (await import('/geometry.js')).zoomBothTo(3,rect.left+rect.width/2,rect.top+rect.height/2);
            (await import('/playback.js')).seekPlayback(1.25);
            setSelection(new Set()); S.undoStack = []; S.redoStack = [];
            scroll.scrollLeft = 500; scroll.scrollTop = 300;
            (await import('/repaint.js')).drawNow();
            const r = stage.getBoundingClientRect();
            return [r.left+r.width*.65,r.top+r.height*.65];
        }""")
        position = lambda: page.locator('#scroll').evaluate('el => [el.scrollLeft,el.scrollTop]')
        page.mouse.move(*start); page.mouse.down()
        page.mouse.move(start[0]-120,start[1]-60,steps=8); page.mouse.up()
        released = position()
        page.wait_for_function('left => document.querySelector("#scroll").scrollLeft > left+5', arg=released[0])
        self.assertGreater(position()[1], released[1])
        page.wait_for_function("async () => !(await import('/viewport-motion.js')).viewportMoving()")
        self.assertEqual(page.evaluate("async () => (await import('/playback.js')).playbackTime()"), 1.25)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.undoStack.length"), 0)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.length"), 0)
        # A second flick is interrupted immediately by a new keyboard gesture.
        page.mouse.move(*start); page.mouse.down()
        page.mouse.move(start[0]-100,start[1],steps=6); page.mouse.up()
        page.keyboard.down('Control')
        stopped = position()
        page.wait_for_timeout(80)
        self.assertEqual(position(), stopped)
        self.assertFalse(page.evaluate("async () => (await import('/viewport-motion.js')).viewportMoving()"))
        page.keyboard.up('Control')

    def test_drawing_quick_settings_sync_preview_and_remappable_shortcuts(self):
        self.open_reference_project()
        page = self.page
        page.evaluate('document.activeElement.blur()')
        expect(page.locator('#drawingSettingsStatus')).to_have_text('Snap · 18%')
        page.keyboard.press('t')
        expect(page.locator('#traceSnap')).not_to_be_checked()
        expect(page.locator('#traceSnapM')).not_to_be_checked()
        expect(page.locator('#drawingSettingsStatus')).to_have_text('Free draw')
        page.keyboard.press('h')
        expect(page.locator('#drawingQuickPanel')).to_be_visible()
        expect(page.locator('#quickTraceSnap')).to_be_focused()
        expect(page.locator('#quickTraceThreshold')).to_be_disabled()
        expect(page.locator('#quickTraceRange')).to_be_disabled()
        page.keyboard.press('Space')
        expect(page.locator('#traceSnap')).to_be_checked()
        self.assertFalse(page.evaluate("async () => (await import('/playback.js')).transportPlaying()"))
        page.keyboard.press('h')
        expect(page.locator('#drawingQuickPanel')).to_be_hidden()
        page.keyboard.press('h')
        expect(page.locator('#quickTraceThreshold')).to_be_focused()
        self.assertTrue(page.evaluate("async () => (await import('/store.js')).S.heatPreview"))
        page.keyboard.press('ArrowRight')
        expect(page.locator('#traceThreshold')).to_have_value('19')
        expect(page.locator('#traceThresholdM')).to_have_value('19')
        expect(page.locator('#quickTraceThresholdValue')).to_have_text('19%')
        expect(page.locator('#drawingSettingsStatus')).to_have_text('Snap · 19%')
        page.locator('#quickTraceRange').select_option('3')
        expect(page.locator('#traceRange')).to_have_value('3')
        expect(page.locator('#traceRangeM')).to_have_value('3')
        self.assertEqual(page.evaluate("JSON.parse(localStorage.getItem('cw.settings')).traceRange"), '3')
        page.wait_for_timeout(1500)
        self.assertTrue(page.evaluate("async () => (await import('/store.js')).S.heatPreview"), 'preview stays visible while the popover is open')
        page.screenshot(path=str(Path('.runs/drawing-quick-settings.png')), full_page=True)
        page.set_viewport_size({'width':900,'height':700})
        page.wait_for_timeout(100)
        rect = page.locator('#drawingQuickPanel').bounding_box()
        self.assertGreaterEqual(rect['x'], 0)
        self.assertLessEqual(rect['x']+rect['width'], 900)
        self.assertLessEqual(rect['y']+rect['height'], 700)
        page.set_viewport_size({'width':1440,'height':900})
        page.keyboard.press('Escape')
        expect(page.locator('#drawingQuickPanel')).to_be_hidden()
        self.assertFalse(page.evaluate("async () => (await import('/store.js')).S.heatPreview"))

        # The existing modal remains staged and synchronizes back when cancelled.
        page.locator('#settingsMenuBtn').click()
        page.locator('[data-settings-pane="trace"]').click()
        page.locator('#traceSnapM').uncheck()
        expect(page.locator('#quickTraceSnap')).not_to_be_checked()
        page.keyboard.press('Escape')
        expect(page.locator('#quickTraceSnap')).to_be_checked()
        page.locator('#settingsMenuBtn').click()
        page.locator('[data-settings-pane="keys"]').click()
        for action, key in [('drawingSnap','g'),('drawingSettings','j')]:
            page.locator(f'[data-command="{action}"] .keymap-key').click()
            page.keyboard.press(key)
        page.locator('#settingsApply').click()
        page.keyboard.press('Escape')
        expect(page.locator('#drawingSettings')).to_have_attribute('title', re.compile(r'\(J\)$'))
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('h')
        expect(page.locator('#drawingQuickPanel')).to_be_hidden()
        page.keyboard.press('j')
        expect(page.locator('#quickTraceThreshold')).to_be_focused()
        expect(page.locator('#quickTraceSnapKey')).to_have_text('G')
        page.keyboard.press('g')
        expect(page.locator('#traceSnap')).not_to_be_checked()
        expect(page.locator('#quickTraceSnap')).to_be_focused()
        page.keyboard.press('Escape')
        page.reload()
        self.open_reference_project()
        expect(page.locator('#drawingSettingsStatus')).to_have_text('Free draw')
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('j')
        expect(page.locator('#drawingQuickPanel')).to_be_visible()
        expect(page.locator('#quickTraceSnapKey')).to_have_text('G')
        expect(page.locator('#quickTraceRange')).to_have_value('3')
        expect(page.locator('#quickTraceThreshold')).to_have_value('19')

    def test_drawing_search_range_five_is_removed_and_migrated(self):
        page = self.page
        page.add_init_script("localStorage.setItem('cw.settings', JSON.stringify({traceRange:'5'}))")
        page.reload()
        for control in ['traceRange','traceRangeM','quickTraceRange']:
            expect(page.locator(f'#{control}')).to_have_value('3')
            self.assertEqual(page.locator(f'#{control} option').evaluate_all('options => options.map(o=>o.value)'), ['1','2','3'])
        self.assertEqual(page.evaluate("JSON.parse(localStorage.getItem('cw.settings')).traceRange"), '3')

    def test_keyboard_zoom_panels_and_marker_navigation(self):
        self.open_reference_project()
        page = self.page
        page.mouse.move(700, 200)
        page.evaluate("document.activeElement.blur()")
        next_note = page.evaluate("""async () => {
            const {S} = await import('/store.js');
            return Math.min(...S.state.editLanes[0].notes.filter(n => n.start > .001).map(n => n.start));
        }""")
        page.keyboard.press('ArrowRight')
        self.assertAlmostEqual(page.evaluate("async () => (await import('/playback.js')).playbackTime()"), next_note)
        zoom = lambda: page.evaluate("async () => (await import('/store.js')).S.zoomX")
        initial_zoom = zoom()
        page.keyboard.press('+')
        self.assertGreater(zoom(), initial_zoom)
        page.keyboard.press('-')
        self.assertAlmostEqual(zoom(), initial_zoom)
        self.assertFalse(page.evaluate("""() => {
            const event = new KeyboardEvent('keydown', {key:'+', ctrlKey:true, bubbles:true, cancelable:true});
            document.body.dispatchEvent(event); return event.defaultPrevented;
        }"""), 'Ctrl+plus is left to browser zoom')
        self.assertAlmostEqual(zoom(), initial_zoom)
        for key, selector in [('b', '#appshell'), ('r', '#artifactsPanel')]:
            collapsed = lambda: page.locator(selector).evaluate("el => el.id === 'appshell' ? el.classList.contains('side-collapsed') : el.hasAttribute('data-collapsed')")
            before = collapsed()
            page.keyboard.press(key)
            self.assertNotEqual(collapsed(), before)
            page.keyboard.press(key)
            self.assertEqual(collapsed(), before)

        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const lane = S.state.editLanes[0];
            S.state.tempoMap = [{t:12, bpm:120, tsNum:3, tsDen:4, subdiv:2}];
            S.state.sectionMarkers = [{id:'nav_section', t:4, text:'Verse', sectionType:'verse'}];
            lane.phraseBoundaries = [{id:'nav_phrase', t:6}];
            lane.handHolds = [{t:8, fret:3}];
            lane.toneMarkers = [{id:'nav_start', t:0, tone:'missing'}, {id:'nav_tone', t:12, tone:'missing'}];
            const other = {...lane, id:'nav_other', active:false, notes:[], refBoxes:{}, handHolds:[],
                phraseBoundaries:[{id:'other_phrase',t:10}], toneMarkers:[]};
            other.timing = (await import('/timing.js')).addTiming({
                grid:{bpm:120,offset:0,tsNum:4,tsDen:4,subdiv:2},
                tempoMap:[{t:16,bpm:100,tsNum:4,tsDen:4,subdiv:2}], sectionMarkers:[],scoreBars:[]});
            S.state.editLanes.push(other);
            const {rebuildLanes,renderLanes} = await import('/lanes.js');
            rebuildLanes(); renderLanes();
            (await import('/playback.js')).seekPlayback(0);
            (await import('/repaint.js')).drawNow();
        }""")
        time_at = lambda: page.evaluate("async () => (await import('/playback.js')).playbackTime()")
        expect(page.locator('#previousMarker')).to_be_disabled()
        # The overview's local arrows must let Ctrl+arrows reach marker navigation.
        page.locator('#overviewRuler').focus()
        page.keyboard.press('Control+ArrowRight')
        self.assertAlmostEqual(time_at(), 4)
        page.locator('#nextMarker').click()
        self.assertAlmostEqual(time_at(), 6)
        # Ctrl+arrows also work while the pointer is over the fretboard.
        if page.locator('#fretboardToggle').get_attribute('aria-expanded') != 'true':
            page.locator('#fretboardToggle').click()
        page.locator('#fretboard').hover()
        page.keyboard.press('Control+ArrowRight')
        self.assertAlmostEqual(time_at(), 8)
        page.keyboard.press('Control+ArrowRight')
        self.assertAlmostEqual(time_at(), 12, msg='skip inactive-layer markers and duplicate timestamps')
        expect(page.locator('#nextMarker')).to_be_disabled()
        page.keyboard.press('Control+ArrowLeft')
        self.assertAlmostEqual(time_at(), 8)
        page.locator('#previousMarker').click()
        self.assertAlmostEqual(time_at(), 6)
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            (await import('/lanes.js')).activateLane(S.state.editLanes.at(-1));
        }""")
        page.keyboard.press('Control+ArrowRight')
        self.assertAlmostEqual(time_at(), 10, msg='navigation follows the newly active layer')
        page.keyboard.press('Control+ArrowRight')
        self.assertAlmostEqual(time_at(), 16, msg='use the active layer timing rather than song markers')
        page.mouse.move(700, 200)
        page.locator('#settingsMenuBtn').click()
        page.locator('[data-settings-pane="keys"]').click()
        page.screenshot(path=str(Path('.runs/keyboard-shortcuts.png')), full_page=True)

    def test_keyboard_unassigned_actions_bind_clear_cancel_and_apply(self):
        self.open_reference_project()
        page = self.page
        page.locator('#settingsMenuBtn').click()
        page.locator('[data-settings-pane="keys"]').click()
        row = page.locator('[data-command="metronome"]')
        expect(row.locator('.keymap-key')).to_have_text('Unassigned')
        row.locator('.keymap-key').click()
        page.keyboard.press('ArrowRight')
        expect(page.locator('#keymapNote')).to_contain_text('already used')
        expect(row.locator('.keymap-key')).to_have_text('Unassigned')
        row.locator('.keymap-key').click()
        page.keyboard.press('q')
        expect(row.locator('.keymap-key')).to_have_text('Q')
        page.keyboard.press('Escape')  # Cancel restores the original unbound state.
        self.assertIsNone(page.evaluate("async () => (await import('/keymap.js')).keyOf('metronome')"))
        page.locator('#settingsMenuBtn').click()
        page.locator('[data-settings-pane="keys"]').click()
        row.locator('.keymap-key').click()
        page.keyboard.press('q')
        page.locator('#settingsApply').click()
        page.keyboard.press('Escape')
        page.evaluate('document.activeElement.blur()')
        before = page.locator('#metro').is_checked()
        page.keyboard.press('q')
        self.assertNotEqual(page.locator('#metro').is_checked(), before)
        # A newly bindable note technique uses the normal undoable edit path.
        page.evaluate("""async () => {
            const {S,setSelection} = await import('/store.js');
            const note = S.state.editLanes[0].notes[0];
            setSelection(new Set([note]));
            (await import('/keymap.js')).setKey('palmMute', 'U');
        }""")
        palm_muted = lambda: page.evaluate("async () => !!(await import('/store.js')).S.state.editLanes[0].notes[0].fx?.palmMute")
        original = palm_muted()
        page.keyboard.press('u')
        self.assertNotEqual(palm_muted(), original)
        page.keyboard.press('Control+z')
        self.assertEqual(palm_muted(), original)
        page.locator('#settingsMenuBtn').click()
        page.locator('[data-settings-pane="keys"]').click()
        row.get_by_role('button', name='Unbind Metronome', exact=True).click()
        expect(row.locator('.keymap-key')).to_have_text('Unassigned')
        zoom_row = page.locator('[data-command="zoomIn"]')
        zoom_row.get_by_role('button', name='Unbind Zoom in', exact=True).click()
        expect(page.locator('#zoomIn')).to_have_attribute('title', 'Zoom in')
        page.keyboard.press('Escape')
        expect(page.locator('#zoomIn')).to_have_attribute('title', 'Zoom in (+)')
        self.assertEqual(page.evaluate("async () => (await import('/keymap.js')).keyOf('metronome')"), 'Q')
        # Input and modal keystrokes do not activate project commands.
        page.evaluate("async () => (await import('/keymap.js')).setKey('layerSettings', 'W')")
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('w')
        field = page.locator('#layerName')
        field.fill('')
        field.press_sequentially('B+R-')
        expect(field).to_have_value('B+R-')
        page.keyboard.press('Escape')

    def test_settings_contextual_apply_and_footer_actions(self):
        page = self.page
        reads = []
        page.on("request", lambda request: reads.append(request.url) if request.url.endswith('/api/sound-presets') else None)
        page.click("#welcomeSettingsBtn")
        expect(page.locator("#settingsApply")).to_be_hidden()
        expect(page.locator("#settingsCancel")).to_have_count(0)
        self.assertEqual(reads, [])
        page.locator('input[name="theme"][value="light"]').check()
        expect(page.locator("#settingsApply")).to_be_visible()
        expect(page.locator("#settingsApply")).to_have_text("Apply")
        page.locator('input[name="theme"][value="dark"]').check()
        expect(page.locator("#settingsApply")).to_be_hidden()
        page.click('[data-settings-pane="trace"]')
        page.uncheck("#fretboardAnimations")
        expect(page.locator("#settingsApply")).to_be_visible()
        page.check("#fretboardAnimations")
        expect(page.locator("#settingsApply")).to_be_hidden()
        page.click('[data-settings-pane="keys"]')
        page.locator('.keymap-key').first.click()
        page.keyboard.press('Control+Alt+y')
        expect(page.locator("#settingsApply")).to_be_visible()
        page.click('#keymapReset')
        expect(page.locator("#settingsApply")).to_be_hidden()
        page.click('[data-settings-pane="sounds"]')
        expect(page.locator('[data-settings-pane="sounds"]')).to_have_text('Tone presets')
        expect(page.locator('#soundName')).to_have_value('Guitar Clean')
        expect(page.locator('#settingsApply')).to_be_hidden()
        expect(page.locator('#spSounds #soundImport')).to_have_text('Import preset')
        expect(page.locator('#spSounds #soundExport')).to_have_text('Export preset')
        self.assertEqual(len(reads), 1)
        page.fill('#soundName', 'A pending preset')
        expect(page.locator('#settingsApply')).to_be_visible()
        page.click('[data-settings-pane="models"]')
        expect(page.locator('#settingsApply')).to_be_hidden()
        expect(page.locator('#soundFileActions')).to_be_hidden()
        page.click('[data-settings-pane="sounds"]')
        expect(page.locator('#settingsApply')).to_be_visible()
        self.assertEqual(len(reads), 1, 'Switching panes keeps the active draft without rescanning')
        page.click('#soundDelete'); page.click('#actionConfirmCancel')
        expect(page.locator('#settingsApply')).to_be_visible()
        page.click('#soundDelete'); page.click('#actionConfirmAccept')
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.click('#settingsModalClose')
        page.click('#welcomeSettingsBtn'); page.click('[data-settings-pane="sounds"]')
        expect(page.locator('#soundName')).to_have_value('Guitar Clean')
        self.assertEqual(len(reads), 2)
        page.fill('#soundName', 'First save'); page.click('#settingsApply')
        expect(page.locator('#settingsModalBackdrop')).to_be_visible()
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.fill('#soundName', 'Saved preset')
        page.get_by_role('spinbutton', name='Amp Gain value', exact=True).fill('40')
        page.click('#settingsApply')
        saved = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()[0].tone")
        self.assertEqual(saved['GearList']['Amp']['KnobValues']['Amp_TW40_Gain'], 40)
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.fill('#soundName', 'Discard this'); page.click('#settingsModalClose')
        page.click('#welcomeSettingsBtn'); page.click('[data-settings-pane="sounds"]')
        expect(page.locator('#soundName')).to_have_value('Saved preset')
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.fill('#soundName', 'Changed')
        expect(page.locator('#settingsApply')).to_be_visible()
        page.fill('#soundName', 'Saved preset')
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.click('#settingsModalClose')
        self.open_reference_project()
        page.locator('#lanes .lane-row').first.hover()
        page.locator('#lanes .lane-row .edit-btn').first.click()
        expect(page.locator('#layerSave')).to_be_hidden()
        name = page.locator('#layerName').input_value()
        page.fill('#layerName', 'Changed layer')
        expect(page.locator('#layerSave')).to_be_visible()
        expect(page.locator('#layerSave')).to_have_text('Apply')
        page.fill('#layerName', name)
        expect(page.locator('#layerSave')).to_be_hidden()
        page.click('#settingsClose')

    def test_settings_apply_keeps_window_and_rebases_visited_panes(self):
        page = self.page
        page.click('#welcomeSettingsBtn')
        page.locator('input[name="theme"][value="light"]').check()
        page.click('[data-settings-pane="trace"]')
        page.uncheck('#fretboardAnimations')
        page.click('#settingsApply')
        expect(page.locator('#settingsModalBackdrop')).to_be_visible()
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.check('#fretboardAnimations')
        page.click('[data-settings-pane="appearance"]')
        page.locator('input[name="theme"][value="dark"]').check()
        page.click('#settingsModalClose')
        page.click('#welcomeSettingsBtn')
        expect(page.locator('input[name="theme"][value="light"]')).to_be_checked()
        page.click('[data-settings-pane="trace"]')
        expect(page.locator('#fretboardAnimations')).not_to_be_checked()
        page.click('#settingsModalClose')
        self.open_reference_project()
        page.locator('#lanes .lane-row').first.hover()
        page.locator('#lanes .lane-row .edit-btn').first.click()
        page.fill('#layerName', 'Applied layer')
        page.click('#layerSave')
        expect(page.locator('#layerSettingsBackdrop')).to_be_visible()
        expect(page.locator('#layerSave')).to_be_hidden()
        page.fill('#layerName', 'Discard layer')
        page.click('#settingsClose')
        expect(page.locator('#lanes')).to_contain_text('Applied layer')
        page.route('**/apply-stem.wav', lambda route: route.fulfill(path=str(self.audio), content_type='audio/wav'))
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            S.state.stems.push({id:'apply-stem', name:'Test audio', volume:1, audioUrl:'/apply-stem.wav'});
            const {openStemSettings} = await import('/stem-settings.js');
            openStemSettings(S.state.stems[0], true);
        }""")
        page.locator('#stemVolume').fill('60')
        page.click('#stemSave')
        expect(page.locator('#stemSettingsBackdrop')).to_be_visible()
        expect(page.locator('#stemSave')).to_be_hidden()
        page.locator('#stemVolume').fill('30')
        page.click('#stemSettingsClose')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.stems[0].volume"), .6)

    def test_sound_json_import_export_and_folder_reload(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_have_value("Guitar Clean")
        expect(page.locator("#soundPreset option")).to_have_count(6)
        expect(page.locator("#soundPresetFolder")).to_have_count(0)
        page.set_viewport_size({"width":720,"height":800})
        self.assertTrue(page.locator("#spSounds").evaluate("""pane => {
            const bounds = pane.getBoundingClientRect();
            return [...pane.querySelectorAll('.sound-form button, .sound-form input:not([type=range]), .sound-form select')]
                .filter(el => el.getClientRects().length)
                .every(el => { const r=el.getBoundingClientRect(); return r.left>=bounds.left && r.right<=bounds.right; });
        }"""), "Preset actions and exact values must fit in a narrow window")
        page.set_viewport_size({"width":1440,"height":900})
        with page.expect_download() as download:
            page.click("#soundExport")
        exported = json.loads(Path(download.value.path()).read_text("utf-8"))
        self.assertEqual(exported["Name"], "Guitar Clean")
        self.assertEqual(exported["GearList"]["Amp"]["Key"], "Amp_TW40")
        exported["Name"] = "Imported JSON"
        exported["GearList"]["Amp"]["KnobValues"]["Amp_TW40_Gain"] = 40
        upload = {"name": "custom.json", "mimeType": "application/json", "buffer": json.dumps(exported).encode()}
        page.locator("#soundImportFiles").set_input_files(upload)
        expect(page.locator("#soundName")).to_have_value("Imported JSON")
        expect(page.locator("#soundDraftStatus")).to_have_text("Unsaved changes")
        page.locator("#soundImportFiles").set_input_files(upload)
        expect(page.locator("#soundFileStatus")).to_contain_text("duplicate preset skipped")
        expect(page.locator("#soundPreset option")).to_have_count(7)
        page.click("#settingsModalClose")
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundPreset option")).to_have_count(6)
        page.locator("#soundImportFiles").set_input_files(upload)
        expect(page.locator("#soundName")).to_have_value("Imported JSON")
        self.apply_settings_and_close()
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_have_value("Imported JSON")
        expect(page.locator("#soundExportLibrary")).to_have_count(0)
        expect(page.locator("#soundReloadFolder")).to_have_count(0)
        expect(page.locator("#settingsApply")).to_be_hidden()
        folder = self.data / "presets" / "sounds"
        extra, invalid = folder / "z-external.json", folder / "invalid.json"
        try:
            exported["Name"] = "From folder"
            extra.write_text(json.dumps(exported), encoding="utf-8")
            invalid.write_text("{}", encoding="utf-8")
            page.click("#settingsModalClose")
            page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
            expect(page.locator("#soundPreset option")).to_have_count(8)
            expect(page.locator("#soundFileStatus")).to_contain_text("invalid.json")
            expect(page.locator("#soundName")).to_have_value("Imported JSON")
            page.select_option("#soundPreset", "file:z-external.json")
            expect(page.locator("#soundName")).to_have_value("From folder")
            extra.unlink(); invalid.unlink()
            page.click("#settingsModalClose")
            page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
            expect(page.locator("#soundName")).to_have_value("Imported JSON")
            page.locator("#soundImportFiles").set_input_files({"name":"bad.json", "mimeType":"application/json", "buffer":b"{}"})
            expect(page.locator("#soundFileStatus")).to_contain_text("invalid values")
            page.locator("#soundImportFiles").set_input_files({"name":"tone.psarc", "mimeType":"application/octet-stream", "buffer":b"PSAR"})
            expect(page.locator("#soundFileStatus")).to_contain_text("Only JSON")
            expect(page.locator("#soundPreset option")).to_have_count(7)
        finally:
            extra.unlink(missing_ok=True); invalid.unlink(missing_ok=True)
        page.click("#settingsModalClose")
        self.open_reference_project()
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const lane = S.state.editLanes[0];
            (await import('/tone-markers.js')).openToneMarkerPop(600,200,lane.toneMarkers[0],lane);
        }""")
        page.select_option("#toneMarkerPreset", label="Bass Overdrive")
        marker = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers[0]")
        self.assertTrue(marker["tone"].startswith("sound_file_"))
        self.assertNotIn("toneData", marker)

    def test_sound_designer_drag_cards_remove_and_slider_scale(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.locator("#soundPreset").select_option("lead")
        # Amp parameters are dials over the native range, labelled with their default.
        slider = page.locator('input[aria-label="Amp Loudness 1"]')
        scale = slider.locator("..")
        expect(scale.locator(".parameter-default")).to_have_text("88")
        self.assertEqual(float(slider.get_attribute("min")), 1)
        self.assertEqual(float(slider.get_attribute("max")), 100)
        value = page.get_by_role("spinbutton", name="Amp Loudness 1 value", exact=True)
        value.fill("46.5")
        scale.get_by_role("button").click()
        expect(value).to_have_value("88")
        # Dragging the dial upwards raises the value; double-click restores the default.
        face = scale.locator(".sound-dial-face")
        face.scroll_into_view_if_needed()
        box = face.bounding_box()
        page.mouse.move(box["x"] + 32, box["y"] + 32); page.mouse.down()
        page.mouse.move(box["x"] + 32, box["y"] + 32 - 16, steps=4); page.mouse.up()
        self.assertGreater(float(value.input_value()), 88)
        face.dblclick()
        expect(value).to_have_value("88")
        # At its default the volume thumb sits exactly over the highlighted default mark.
        slider = page.locator('input[aria-label="Tone volume"]')
        offset = slider.evaluate("""input => {
            const box = input.getBoundingClientRect(), mark = input.parentElement.querySelector('.is-default').getBoundingClientRect();
            const thumb = parseFloat(getComputedStyle(input).getPropertyValue('--w-slider-thumb'));
            return box.left + thumb / 2 + (box.width - thumb) * (input.value - input.min) / (input.max - input.min) - (mark.left + mark.width / 2);
        }""")
        self.assertLess(abs(offset), 0.6)
        # Selecting a card shows its controls; one more click opens its picker.
        page.locator('#soundChain [data-slot="Cabinet"]').click()
        page.locator('#soundChain [data-slot="Cabinet"]').click()
        expect(page.locator("#soundGearDialogTitle")).to_have_text("Replace cabinet")
        page.click("#soundGearClose")
        # Descriptions are tags; any one of them can be removed.
        page.click("#soundAddDescription")
        page.get_by_role("button", name="Remove tone description 1", exact=True).click()
        expect(page.locator("#soundDescriptors .sound-tag")).to_have_count(1)
        expect(page.get_by_role("button", name="Remove tone description 1", exact=True)).to_be_disabled()
        before = page.evaluate("""async () => (await import('/sound-presets-core.js')).SOUND_BASES.lead.GearList""")
        rack1 = page.locator('.sound-chain-card:has([data-slot="Rack1"])')
        rack2 = page.locator('.sound-chain-card:has([data-slot="Rack2"])')
        rack2.drag_to(rack1, target_position={"x": 3, "y": 35})
        expect(page.locator('#soundChain [data-slot="Rack1"]')).to_contain_text("Chamber")
        # A pedal can move to the other bank, keeping all its original values.
        page.locator('.sound-chain-card:has([data-slot="PrePedal1"])').drag_to(
            page.locator('[data-bank="PostPedal"] > .section-head'))
        expect(page.locator('#soundChain [data-slot="PostPedal2"]')).to_contain_text("Germanium")
        # Invalid rack -> pedal moves leave the chain unchanged. (The loop bank stays
        # in view beside the rack; the pre bank would need the chain to scroll mid-drag.)
        page.locator('.sound-chain-card:has([data-slot="Rack1"])').drag_to(
            page.locator('[data-bank="PostPedal"] > .section-head'))
        expect(page.locator('#soundChain [data-slot="PostPedal2"]')).to_contain_text("Germanium")
        expect(page.locator('#soundChain [data-slot="Rack1"]')).to_contain_text("Chamber")
        page.locator('#soundChain [data-slot="Rack2"]').click()
        shots = Path(__file__).resolve().parents[1] / "design-shots"
        shots.mkdir(exist_ok=True)
        for theme in ("dark", "light"):
            page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
            page.screenshot(path=str(shots / f"sound-designer-controls-{theme}.png"), animations="disabled")
        page.get_by_role("button", name="Remove Mod Delay from chain", exact=True).click()
        expect(page.locator('#soundChain [data-slot="PostPedal2"]')).to_have_count(0)
        self.apply_settings_and_close()
        saved = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()[0].tone")
        self.assertEqual(saved["GearList"]["PostPedal1"], before["PrePedal1"])
        self.assertEqual(saved["GearList"]["Rack1"], before["Rack2"])
        self.assertEqual(saved["GearList"]["Rack2"], before["Rack1"])

    def test_sound_designer_device_shaped_controls(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.locator("#soundPreset").select_option("lead")
        # A control offers a way back to the preset's value only once it differs.
        revert = page.get_by_role("button", name="Amp Treble back to preset value", exact=True)
        treble = page.get_by_role("spinbutton", name="Amp Treble value", exact=True)
        original = treble.input_value()
        expect(revert).to_be_hidden()
        treble.fill("12")
        expect(revert).to_be_visible()
        revert.click()
        expect(treble).to_have_value(original)
        expect(revert).to_be_hidden()
        # Clicking the selected card again opens the picker.
        page.locator('#soundChain [aria-pressed="true"]').click()
        expect(page.locator("#soundGearDialogTitle")).to_have_text("Replace amplifier")
        page.click("#soundGearClose")
        # A parametric EQ is a curve: dragging a band point writes its gain and frequency.
        page.locator('#soundChain [data-slot="Rack1"]').click()
        expect(page.locator("#soundDevices")).to_have_attribute("data-layout", "parametric")
        gain = page.get_by_role("spinbutton", name="Rack1 High-Mid value", exact=True)
        freq = page.get_by_role("spinbutton", name="Rack1 High-Mid Freq. value", exact=True)
        before_gain, before_freq = float(gain.input_value()), float(freq.input_value())
        page.locator(".eq-node").nth(2).scroll_into_view_if_needed()
        node = page.locator(".eq-node").nth(2).bounding_box()
        page.mouse.move(node["x"] + node["width"] / 2, node["y"] + node["height"] / 2); page.mouse.down()
        page.mouse.move(node["x"] - 40, node["y"] + 40, steps=4); page.mouse.up()
        self.assertLess(float(gain.input_value()), before_gain)
        self.assertLess(float(freq.input_value()), before_freq)
        expect(page.get_by_role("radiogroup", name="Rack1 High-Mid \"Q\"", exact=True)).to_be_visible()
        # Fixed-band graphic EQs get one fader per band.
        self.pick_sound_gear("Rack_StudioChamber")
        page.locator('#soundChain [data-slot="PrePedal1"]').click()
        self.pick_sound_gear("Pedal_EQ8")
        expect(page.locator("#soundDevices")).to_have_attribute("data-layout", "graphic")
        expect(page.locator(".sound-fader")).to_have_count(8)
        page.get_by_role("slider", name="PrePedal1 50HZ", exact=True).press("ArrowUp")
        expect(page.get_by_role("spinbutton", name="PrePedal1 50HZ value", exact=True)).to_have_value("5")

    def test_sound_designer_large_device_view_preserves_edits_and_focus(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.locator("#soundPreset").select_option("lead")
        page.locator('#soundChain [data-slot="Rack1"]').click()
        # The band grid hugs its controls, rather than adding hundreds of empty pixels.
        self.assertLess(page.locator(".sound-eq-bands").evaluate("el => el.getBoundingClientRect().height"), 180)
        expect(page.locator("#soundExpandDevice")).to_be_visible()
        expect(page.locator("#soundSectionDevice .sound-section-device-name")).to_have_count(0)
        page.click("#soundExpandDevice")
        expect(page.locator("#soundDeviceDialog")).to_be_visible()
        expect(page.locator("#soundDeviceDialogClose")).to_be_focused()
        self.assertTrue(page.locator("#soundDeviceDialog").evaluate("""dialog => {
            const box = dialog.getBoundingClientRect();
            const inner = document.querySelector('#settingsModal .settings-layout > .dialog-body').getBoundingClientRect();
            return Math.abs(box.width-inner.width)<2 && Math.abs(box.height-inner.height)<2
                && Math.abs(box.left-inner.left)<2 && Math.abs(box.top-inner.top)<2;
        }"""))
        expect(page.locator("#soundDeviceDialog .sound-workbench")).to_have_count(1)
        gain = page.get_by_role("spinbutton", name="Rack1 High-Mid value", exact=True)
        curve = page.locator(".eq-curve")
        original_curve = curve.get_attribute("d")
        gain.fill("3.5")
        page.wait_for_function("""() => {
            const box = document.querySelector('#soundDeviceDialog').getBoundingClientRect();
            const inner = document.querySelector('#settingsModal .settings-layout > .dialog-body').getBoundingClientRect();
            return Math.abs(box.height-inner.height)<2;
        }""")
        self.assertNotEqual(curve.get_attribute("d"), original_curve)
        page.get_by_role("button", name="Rack1 High-Mid back to preset value", exact=True).click()
        expect(curve).to_have_attribute("d", original_curve)
        gain.fill("3.5")
        page.keyboard.press("Escape")
        expect(page.locator("#soundDeviceDialog")).not_to_be_visible()
        expect(page.locator("#spSounds")).to_be_visible()
        expect(page.locator("#soundWorkbenchHome .sound-workbench")).to_have_count(1)
        expect(page.locator("#soundExpandDevice")).to_be_focused()
        expect(gain).to_have_value("3.5")
        page.click("#soundExpandDevice"); page.click("#soundDeviceDialogClose")
        expect(gain).to_have_value("3.5")
        self.apply_settings_and_close()
        saved = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()[0].tone")
        self.assertEqual(saved["GearList"]["Rack1"]["KnobValues"]["Rack_StudioEQ_HiMid"], 3.5)
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        # With other sections collapsed the amp fits, so no expansion is needed.
        page.click('[aria-controls="soundSectionPreset"]'); page.click('[aria-controls="soundSectionChain"]')
        expect(page.locator("#soundExpandDevice")).to_be_hidden()

    def test_sound_designer_picker_cancel_and_controls_space(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundGearDialog")).not_to_be_visible()
        # Collapsing preset and chain leaves room for every amp control without
        # scrolling, and the layout is remembered when Settings reopens.
        page.click('[aria-controls="soundSectionPreset"]'); page.click('[aria-controls="soundSectionChain"]')
        page.click("#settingsModalClose"); page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator('[aria-controls="soundSectionChain"]')).to_have_attribute("aria-expanded", "false")
        expect(page.locator("#soundPresetSummary")).to_have_text("Clean")
        page.wait_for_function("() => !document.getAnimations().length")
        self.assertTrue(page.locator(".sound-workbench").evaluate("el => el.scrollHeight <= el.clientHeight + 1"))
        page.click('[aria-controls="soundSectionPreset"]'); page.click('[aria-controls="soundSectionChain"]')
        before = page.locator("#soundChain").inner_text()
        page.get_by_role("button", name="Add pre effects", exact=True).click()
        page.locator("#soundGearSelect").select_option("Pedal_MultiPitch")
        shots = Path(__file__).resolve().parents[1] / "design-shots"
        shots.mkdir(exist_ok=True)
        page.screenshot(path=str(shots / "sound-designer-device-picker.png"))
        page.click("#soundGearClose")
        self.assertEqual(page.locator("#soundChain").inner_text(), before)
        expect(page.locator("#soundDraftStatus")).to_have_text("")
        page.locator('#soundChain [aria-pressed="true"]').click()
        page.fill("#soundGearSearch", "JCM800")
        page.keyboard.press("Escape")
        expect(page.locator("#soundGearDialog")).not_to_be_visible()
        expect(page.locator("#spSounds")).to_be_visible()
        expect(page.locator("#soundDraftStatus")).to_have_text("")
        # Applying the already-selected cabinet must retain its microphone.
        page.locator('#soundChain [data-slot="Cabinet"]').click()
        self.pick_sound_mic("Ribbon", "Edge")
        page.locator('#soundChain [aria-pressed="true"]').click()
        expect(page.locator('#soundGearApply')).to_be_hidden()
        page.click("#soundGearClose")
        expect(page.get_by_role("radio", name="Edge", exact=True)).to_be_checked()
        # A newly added effect uses the chosen device, with no intermediate default.
        page.get_by_role("button", name="Add pre effects", exact=True).click()
        page.locator("#soundGearSelect").select_option("Pedal_MultiPitch")
        page.click("#soundGearApply")
        expect(page.locator('#soundChain [aria-pressed="true"]')).to_contain_text("MultiPitch")
        self.apply_settings_and_close()
        saved = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()[0].tone")
        self.assertEqual(saved["GearList"]["PrePedal1"]["Key"], "Pedal_MultiPitch")

    def test_sound_designer_visual_chain_and_new_preset_workflow(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#settingsApply")).to_have_text("Apply")
        expect(page.get_by_role("button", name="Listen", exact=True)).to_have_count(0)
        expect(page.locator("#soundDraftStatus")).to_have_text("")
        page.click("#soundNew")
        expect(page.locator("#soundName")).to_have_value("Untitled preset")
        expect(page.locator("#soundName")).to_be_focused()
        expect(page.locator("#soundDraftStatus")).to_have_text("Unsaved changes")
        expect(page.locator("#soundChain [data-slot]")).to_have_count(2)
        first = page.locator("#soundPreset").input_value()
        page.fill("#soundName", "New visual rig")
        self.add_sound_effect("pre")
        expect(page.locator('#soundChain [data-slot="PrePedal1"]')).to_have_attribute("aria-pressed", "true")
        expect(page.locator('#soundChain [aria-pressed="true"]')).to_contain_text("Germanium Drive")
        page.keyboard.press("Alt+ArrowRight")
        expect(page.locator('#soundChain [data-slot="PostPedal1"]')).to_have_attribute("aria-pressed", "true")
        page.click("#soundDuplicate")
        expect(page.locator("#soundName")).to_have_value("New visual rig copy")
        self.assertNotEqual(page.locator("#soundPreset").input_value(), first)
        self.apply_settings_and_close()
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundDraftStatus")).to_have_text("")
        page.click("#soundNew")
        page.click("#settingsModalClose")
        saved = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()")
        self.assertEqual([entry["tone"]["Name"] for entry in saved], ["New visual rig", "New visual rig copy"])

        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.locator("#soundPreset").select_option("lead")
        shots = Path(__file__).resolve().parents[1] / "design-shots"
        shots.mkdir(exist_ok=True)
        for theme in ["dark", "light"]:
            page.evaluate("theme => { if (theme === 'light') document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; }", theme)
            for width, height in [(1440, 900), (1000, 700), (720, 800)]:
                page.set_viewport_size({"width": width, "height": height})
                # Every card must remain reachable, including in a full chain.
                for slot in ["PrePedal1", "Amp", "PostPedal1", "Cabinet", "Rack1", "Rack2"]:
                    page.locator(f'#soundChain [data-slot="{slot}"]').click()
                    expect(page.locator(f'#soundChain [data-slot="{slot}"]')).to_have_attribute("aria-pressed", "true")
                page.locator('#soundChain [data-slot="Amp"]').click()
                self.assertTrue(page.evaluate("""() => {
                    const pane = document.querySelector('#spSounds');
                    const body = pane.closest('.dialog-body');
                    return body.scrollWidth <= body.clientWidth + 1;
                }"""), "The settings body should not overflow horizontally")
                page.screenshot(path=str(shots / f"sound-designer-flow-{theme}-{width}.png"))
        page.click("#settingsModalClose")

    def test_sound_designer_device_scroll_keyboard_focus_and_cross_pane_validation(self):
        page = self.page
        page.set_viewport_size({"width": 720, "height": 800})
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        # Switching devices starts at the top of their editor, even when the
        # previous device's last control was being edited.
        expect(page.locator('#soundChain [data-slot="Amp"]')).to_have_attribute("aria-pressed", "true")
        self.assertGreater(page.evaluate("""() => {
            const editor = document.querySelector('.sound-workbench');
            editor.scrollTop = editor.scrollHeight;
            return editor.scrollTop;
        }"""), 0)
        page.locator('#soundChain [data-slot="Rack1"]').click()
        self.assertEqual(page.locator('.sound-workbench').evaluate('(el) => el.scrollTop'), 0)
        # Rebuilding the chain must not lose keyboard focus to the document.
        page.get_by_role("button", name="Add pre effects", exact=True).focus()
        page.keyboard.press("Enter")
        page.click("#soundGearApply")
        expect(page.locator('#soundChain [data-slot="PrePedal1"]')).to_be_focused()
        self.add_sound_effect("pre")
        # Effect cards move with Alt+arrows (across the amp between pedal banks)
        # and are removed with Delete, keeping focus on the moved card.
        page.keyboard.press("Alt+ArrowLeft")
        expect(page.locator('#soundChain [data-slot="PrePedal1"]')).to_be_focused()
        page.keyboard.press("Alt+ArrowRight")
        expect(page.locator('#soundChain [data-slot="PrePedal2"]')).to_be_focused()
        page.keyboard.press("Alt+ArrowRight")
        expect(page.locator('#soundChain [data-slot="PostPedal1"]')).to_be_focused()
        page.keyboard.press("Delete")
        expect(page.locator('#soundChain [data-slot="Amp"]')).to_be_focused()
        # Saving another settings pane must reveal the preset blocking Save.
        page.fill("#soundName", "")
        page.click('[data-settings-pane="appearance"]')
        page.click("#settingsApply")
        expect(page.locator("#spSounds")).to_be_visible()
        expect(page.locator("#soundName")).to_be_focused()
        expect(page.locator("#soundValidation")).to_contain_text("preset name")
        page.fill("#soundName", "Repaired preset")
        self.apply_settings_and_close()
        expect(page.locator("#settingsModalBackdrop")).to_be_hidden()
        # Validation of a knob on a non-active device must reveal and focus it.
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        value = page.get_by_role("spinbutton", name="Amp Loudness 1 value", exact=True)
        value.fill("101")
        page.locator('#soundChain [data-slot="Cabinet"]').click()
        page.click('[data-settings-pane="appearance"]'); page.click("#settingsApply")
        expect(page.locator("#spSounds")).to_be_visible()
        expect(value).to_be_focused()
        expect(value).to_have_value("101")
        value.fill("42")
        self.apply_settings_and_close()
        expect(page.locator("#settingsModalBackdrop")).to_be_hidden()

    def test_sound_designer_empty_volume_repair_and_duplicate(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.fill("#soundVolumeNumber", "")
        key = page.locator("#soundPreset").input_value()
        expect(page.locator("#soundValidation")).to_contain_text("Volume")
        page.locator("#soundPreset").select_option("bass")
        page.locator("#soundPreset").select_option(key)
        expect(page.locator("#soundVolumeNumber")).to_have_value("")
        page.click("#settingsApply")
        expect(page.locator("#settingsModalBackdrop")).to_be_visible()
        expect(page.locator("#soundVolumeNumber")).to_have_value("")
        page.locator("#soundVolume").fill("5")
        expect(page.locator("#soundVolumeNumber")).to_have_attribute("aria-invalid", "false")
        expect(page.locator("#soundValidation")).to_be_hidden()
        page.locator("#soundVolumeNumber").fill("5.125")
        expect(page.locator("#soundVolumeNumber")).to_have_attribute("aria-invalid", "false")
        page.click("#soundDuplicate")
        self.apply_settings_and_close()
        saved = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()")
        self.assertEqual(len(saved), 2)
        self.assertTrue(all(float(entry["tone"]["Volume"]) == -5.125 for entry in saved))

    def test_sound_designer_preserves_unavailable_data_and_detects_conflicts(self):
        page = self.page
        page.evaluate("""async () => {
            const {SOUND_BASES, cloneSound, SOUND_LIBRARY_KEY} = await import('/sound-presets-core.js');
            localStorage.setItem(SOUND_LIBRARY_KEY, JSON.stringify([
                {id:'sound_seed', tone:{...cloneSound(SOUND_BASES.clean), Name:'Original'}},
                {id:'sound_future', tone:{Name:'Unsupported future gear', GearList:{}}}
            ]));
        }""")
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundLibraryWarning")).to_be_visible()
        page.fill("#soundName", "Renamed")
        self.apply_settings_and_close()
        saved = page.evaluate("JSON.parse(localStorage.getItem('cw.soundPresets.v1'))")
        self.assertEqual(saved[0]["tone"]["Name"], "Renamed")
        self.assertEqual(saved[1], {"id": "sound_future", "tone": {"Name": "Unsupported future gear", "GearList": {}}})
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.fill("#soundName", "Conflicting draft")
        page.evaluate("""() => {
            const list=JSON.parse(localStorage.getItem('cw.soundPresets.v1'));
            list[0].tone.Name='Saved elsewhere'; localStorage.setItem('cw.soundPresets.v1',JSON.stringify(list));
        }""")
        page.click("#settingsApply")
        expect(page.locator("#settingsModalBackdrop")).to_be_visible()
        expect(page.locator("#soundName")).to_have_value("Conflicting draft")
        self.assertEqual(page.evaluate("JSON.parse(localStorage.getItem('cw.soundPresets.v1'))[0].tone.Name"), "Saved elsewhere")
        page.click("#settingsModalClose")
        page.evaluate("localStorage.setItem('cw.soundPresets.v1','broken JSON')")
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.fill("#soundName", "New draft")
        page.click("#settingsApply")
        expect(page.locator("#settingsModalBackdrop")).to_be_visible()
        self.assertEqual(page.evaluate("localStorage.getItem('cw.soundPresets.v1')"), "broken JSON")

    def test_sound_project_references_follow_library_edits_and_warn_after_delete(self):
        page = self.page
        page.click('#welcomeSettingsBtn'); page.click('[data-settings-pane=sounds]')
        page.fill('#soundName', 'First version')
        key = page.locator('#soundPreset').input_value()
        self.apply_settings_and_close()
        self.open_reference_project()
        def open_marker():
            page.evaluate("""async () => {
                const {S} = await import('/store.js'); const lane=S.state.editLanes[0];
                (await import('/tone-markers.js')).openToneMarkerPop(600,200,lane.toneMarkers[0],lane);
            }""")
        open_marker(); page.select_option('#toneMarkerPreset', key)
        page.click('#toneMarkerPopClose')
        page.click('#settingsMenuBtn'); page.click('[data-settings-pane=sounds]')
        page.fill('#soundName', 'Latest version')
        self.apply_settings_and_close()
        open_marker()
        expect(page.locator(f'#toneMarkerPreset option[value="{key}"]')).to_have_text('Latest version')
        marker = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers[0]")
        self.assertNotIn('toneData', marker)
        self.assertTrue(all('project copy' not in text for text in page.locator('#toneMarkerPreset option').all_text_contents()))
        page.click('#toneMarkerPopClose')
        page.click('#settingsMenuBtn'); page.click('[data-settings-pane=sounds]')
        page.click('#soundDelete'); page.click('#actionConfirmAccept'); self.apply_settings_and_close()
        open_marker()
        expect(page.locator(f'#toneMarkerPreset option[value="{key}"]')).to_contain_text('Missing preset')
        expect(page.locator(f'#toneMarkerPreset option[value="{key}"]')).to_have_attribute('disabled', '')

    def test_sound_designer_starting_points_are_directly_editable(self):
        page = self.page
        def slot(key):
            page.locator(f'#soundChain [data-slot="{key}"]').click()
        def named(text):
            page.fill("#soundName", "")
            page.locator("#soundName").press_sequentially(text)
            expect(page.locator("#soundName")).to_be_focused()
            expect(page.locator("#soundName")).to_have_value(text)
        def slider():
            control = page.get_by_role("slider", name="Amp Loudness 1", exact=True)
            control.fill("42")
            control.press("ArrowRight")
            expect(control).to_have_value("43")
        def amp_number():
            page.get_by_role("spinbutton", name="Amp Loudness 1 value", exact=True).fill("46.5")
        def microphone():
            slot("Cabinet")
            self.pick_sound_mic("Ribbon", "Edge")
        def enum():
            slot("Rack1")
            self.pick_sound_switch("Rack1 Ratio", "20:1")
        def remove():
            slot("PrePedal1"); page.keyboard.press("Delete")
        def move():
            slot("Rack2"); page.keyboard.press("Alt+ArrowLeft")
        def bank():
            slot("PrePedal1"); page.keyboard.press("Alt+ArrowRight")
        cases = [
            ("name", "clean", lambda: named("My direct edit"), lambda tone: tone["Name"] == "My direct edit"),
            ("description", "clean", lambda: page.get_by_role("combobox", name="Tone description 1", exact=True).select_option(label="Distortion"), lambda tone: tone["ToneDescriptors"] == ["$[35722]DISTORTION"]),
            ("slider", "clean", slider, lambda tone: tone["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Loudness1"] == 43),
            ("number", "clean", amp_number, lambda tone: tone["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Loudness1"] == 46.5),
            ("volume", "clean", lambda: page.fill("#soundVolumeNumber", "18.5"), lambda tone: float(tone["Volume"]) == -18.5),
            ("amplifier", "clean", lambda: self.pick_sound_gear("Amp_MarshallJCM800"), lambda tone: tone["GearList"]["Amp"]["Key"] == "Amp_MarshallJCM800"),
            ("microphone", "clean", microphone, lambda tone: tone["GearList"]["Cabinet"]["Key"] == "Cab_Marshall1960TV_Ribbon_Edge"),
            ("enum", "bass", enum, lambda tone: tone["GearList"]["Rack1"]["KnobValues"]["Rack_StudioCompressor_Ratio"] == 4),
            ("remove", "lead", remove, lambda tone: "PrePedal1" not in tone["GearList"]),
            ("add", "clean", lambda: self.add_sound_effect("pre"), lambda tone: "PrePedal1" in tone["GearList"]),
            ("reorder", "lead", move, lambda tone: tone["GearList"]["Rack1"]["Key"] == "Rack_StudioChamber"),
            ("relocate", "lead", bank, lambda tone: tone["GearList"]["PostPedal1"]["Key"] == "Pedal_GermaniumDrive"),
            ("reset", "clean", lambda: page.get_by_role("button", name="Amp Loudness 1 default 88", exact=True).click(), lambda tone: tone["GearList"]["Amp"]["KnobValues"]["Amp_MarshallPlexi_Loudness1"] == 88),
            ("add description", "clean", lambda: page.click("#soundAddDescription"), lambda tone: len(tone["ToneDescriptors"]) == 2),
        ]
        for index, (name, base, action, verify) in enumerate(cases):
            with self.subTest(control=name):
                page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
                page.locator("#soundPreset").select_option(base)
                original = page.evaluate("async (base) => (await import('/sound-presets-core.js')).SOUND_BASES[base]", base)
                expect(page.locator("#soundName")).to_be_editable()
                expect(page.get_by_role("combobox", name="Tone description 1", exact=True)).to_be_enabled()
                expect(page.locator("#soundGearSelect")).to_be_enabled()
                action()
                key = page.locator("#soundPreset").input_value()
                self.assertTrue(key.startswith("sound_"), name)
                self.apply_settings_and_close()
                library = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()")
                self.assertEqual(len(library), index + 1, "one first edit creates exactly one preset")
                saved = next(entry["tone"] for entry in library if entry["id"] == key)
                self.assertTrue(verify(saved), name)
                self.assertEqual(page.evaluate("async (base) => (await import('/sound-presets-core.js')).SOUND_BASES[base]", base), original)

    def test_sound_designer_automatic_copies_are_discarded_on_cancel(self):
        page = self.page
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        page.fill("#soundName", "Discarded automatic copy")
        page.get_by_role("combobox", name="Tone description 1", exact=True).select_option(label="Crunch")
        page.click("#settingsModalClose")
        page.reload()
        page.click("#welcomeSettingsBtn"); page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_have_value("Clean")
        expect(page.get_by_role("combobox", name="Tone description 1", exact=True)).to_have_value("$[35720]CLEAN")
        self.assertEqual(page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()"), [])

    def test_sound_designer_presets_are_staged_portable_and_exportable(self):
        page = self.page
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_be_editable()
        page.click("#soundDuplicate")
        page.fill("#soundName", "Test solo")
        page.locator('input[aria-label="Amp Loudness 1"]').fill("42")
        shots = Path(__file__).resolve().parents[1] / "design-shots"
        shots.mkdir(exist_ok=True)
        page.screenshot(path=str(shots / "sound-designer-prototype.png"))
        self.apply_settings_and_close()
        page.reload()
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_have_value("Test solo")
        page.fill("#soundName", "Discard this edit")
        page.click("#settingsModalClose")
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_have_value("Test solo")
        page.click("#settingsModalClose")
        self.open_reference_project()
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const {openToneMarkerPop} = await import('/tone-markers.js');
            const lane = S.state.editLanes[0];
            openToneMarkerPop(600, 200, lane.toneMarkers[0], lane);
        }""")
        page.locator("#toneMarkerPreset").select_option(label="Test solo")
        page.click("#toneMarkerPopClose")
        snapshot = page.evaluate("""async () => {
            const {S} = await import('/store.js');
            return S.state.editLanes[0].toneMarkers[0];
        }""")
        self.assertNotIn("toneData", snapshot)
        # A portable project does not depend on this machine's preset library.
        with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/api/projects/{self.reference_job}")):
            page.keyboard.press("Control+s")
        saved = page.request.get(f"{self.url}api/projects/{self.reference_job}").json()
        self.assertNotIn("toneData", saved["editLanes"][0]["toneMarkers"][0])
        chart = self.data / "custom-sound.chart"
        chart.write_bytes(self.download("#saveAs").read_bytes())
        self.home()
        page.evaluate("localStorage.removeItem('cw.soundPresets.v1')")
        with page.expect_file_chooser() as chooser:
            page.click("#welcomeOpen")
        chooser.value.set_files(chart)
        expect(page.locator("#lanes .lane-row")).to_be_visible()
        restored = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers[0]")
        self.assertEqual(restored["toneData"]["Name"], "Test solo")
        # Backend export accepts precisely the snapshot saved by the UI.
        base, _, _ = rocksmith_builder._arrangement_tones(
            {"toneMarkers": [restored]}, False, "test", "lead", 60, [])
        self.assertEqual(base["Name"], "Test solo")

    def test_sound_designer_effect_banks_and_delete_cancel(self):
        page = self.page
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        page.locator("#soundPreset").select_option("lead")
        page.click("#soundDuplicate")
        page.fill("#soundName", "Effect test")
        expect(page.get_by_role("button", name="Add pre effects", exact=True)).to_be_disabled()
        page.locator('#soundChain [data-slot="PrePedal1"]').click()
        page.get_by_role("button", name="Remove Germanium Drive from chain", exact=True).click()
        expect(page.get_by_role("button", name="Add pre effects", exact=True)).to_be_enabled()
        self.add_sound_effect("rack")
        self.pick_sound_gear("Rack_StudioCompressor")
        self.apply_settings_and_close()
        expect(page.locator("#settingsModalBackdrop")).to_be_hidden()
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        page.click("#soundDelete")
        page.click("#actionConfirmAccept")
        expect(page.locator("#soundName")).to_be_editable()
        page.click("#settingsModalClose")
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_have_value("Effect test")
        # Switching to a bass starting point keeps the same editing workflow.
        page.locator("#soundPreset").select_option("bass")
        page.click("#settingsModalClose")

    def test_sound_designer_full_native_devices_mics_enums_and_chain(self):
        page = self.page
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        page.click("#soundDuplicate")
        page.fill("#soundName", "Native rig")
        self.assertEqual(page.locator("#soundGearSelect option").count(), 63)
        page.locator('#soundChain [aria-pressed="true"]').click()
        page.fill("#soundGearSearch", "JCM800")
        self.pick_sound_gear("Amp_MarshallJCM800")
        gain = page.get_by_role("spinbutton", name="Amp PreAmp value", exact=True)
        gain.fill("46.5")
        expect(gain).to_have_value("46.5")
        gain.fill("101")
        expect(page.locator("#soundValidation")).to_contain_text("PreAmp")
        page.click("#settingsApply")
        expect(page.locator("#settingsModalBackdrop")).to_be_visible()
        expect(page.locator("#soundValidation")).to_contain_text("PreAmp")
        page.get_by_role("spinbutton", name="Amp PreAmp value", exact=True).fill("46.5")
        expect(page.locator("#soundValidation")).to_be_hidden()
        page.locator('#soundChain [data-slot="Cabinet"]').click()
        self.assertEqual(page.locator("#soundGearSelect option").count(), 58)
        self.pick_sound_gear("Cab_Marshall1936_57_Cone")
        self.pick_sound_mic("Ribbon", "Off Axis")
        page.locator('#soundChain [data-slot="Rack1"]').click()
        self.assertEqual(page.locator("#soundGearSelect option").count(), 17)
        self.pick_sound_gear("Rack_StudioCompressor")
        self.pick_sound_switch("Rack1 Ratio", "8:1")
        self.add_sound_effect("pre")
        self.assertEqual(page.locator("#soundGearSelect option").count(), 83)
        self.pick_sound_gear("Pedal_MultiPitch")
        page.get_by_role("spinbutton", name="PrePedal1 Pitch 1 value", exact=True).fill("-7.5")
        page.locator('#soundChain [data-slot="PrePedal1"]').press("Alt+ArrowRight")
        expect(page.get_by_role("spinbutton", name="PostPedal1 Pitch 1 value", exact=True)).to_have_value("-7.5")
        self.add_sound_effect("loop")
        page.keyboard.press("Alt+ArrowLeft")
        expect(page.locator("#soundGearSelect")).to_have_value("Pedal_GermaniumDrive")
        page.locator('#soundChain [data-slot="PostPedal2"]').click()
        expect(page.get_by_role("spinbutton", name="PostPedal2 Pitch 1 value", exact=True)).to_have_value("-7.5")
        page.click("#soundAddDescription")
        page.get_by_role("combobox", name="Tone description 2", exact=True).select_option(label="High Gain")
        page.get_by_role("spinbutton", name="Tone volume value", exact=True).fill("18.5")
        self.apply_settings_and_close()
        page.reload()
        page.click("#welcomeSettingsBtn")
        page.click('[data-settings-pane="sounds"]')
        expect(page.locator("#soundName")).to_have_value("Native rig")
        saved = page.evaluate("async () => (await import('/sound-presets-core.js')).readSoundLibrary()[0].tone")
        self.assertEqual(saved["GearList"]["Cabinet"]["Key"], "Cab_Marshall1936_Ribbon_OffAxis")
        self.assertEqual(saved["GearList"]["Rack1"]["KnobValues"]["Rack_StudioCompressor_Ratio"], 3)
        self.assertEqual(saved["GearList"]["PostPedal2"]["KnobValues"]["Pedal_MultiPitch_Pitch1"], -7.5)
        self.assertEqual(saved["GearList"]["Amp"]["KnobValues"]["Amp_MarshallJCM800_Gain"], 46.5)
        self.assertEqual(float(saved["Volume"]), -18.5)
        self.assertIn("$[35755]HIGH GAIN", saved["ToneDescriptors"])
        base, _, _ = rocksmith_builder._arrangement_tones({"toneMarkers": [{"t": 0, "tone": "sound_test", "toneData": saved}]}, False, "test", "lead", 60, [])
        self.assertEqual(base["GearList"], saved["GearList"])

    def test_trace_accepts_cells_shorter_than_fifty_ms(self):
        self.open_reference_project()
        result = self.page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { bpmInput, offsetInput, tsDenInput, traceSnapInput } = await import('/dom.js');
            const { setSubdiv, gridStep } = await import('/grid.js');
            const { syncRowHeight, xOf, yOf } = await import('/geometry.js');
            const { notesFromTrace, prepareSpectSample } = await import('/tracing.js');
            bpmInput.value = '173'; offsetInput.value = '0'; tsDenInput.value = '4';
            setSubdiv(8);
            S.state.spec = { midi_low: 24, midi_high: 96 };
            syncRowHeight();
            const image = document.createElement('canvas');
            image.width = 500; image.height = 73;
            const ctx = image.getContext('2d');
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 500, 73);
            S.spectImg = image; prepareSpectSample();
            const step = gridStep(), y = yOf(60) + S.state.rowH / 2;
            const trace = (cells) => [[xOf(step * 8), y], [xOf(step * (8 + cells)), y]];
            const trials = [];
            for (const snap of [true, false]) {
                traceSnapInput.checked = snap;
                trials.push({ single: notesFromTrace(trace(1)), long: notesFromTrace(trace(8)) });
            }
            traceSnapInput.checked = false;
            const changing = notesFromTrace([
                [xOf(step * 8), y], [xOf(step * 9), y],
                [xOf(step * 9), y - S.state.rowH], [xOf(step * 10), y - S.state.rowH]
            ]);
            return { step, trials, changing };
        }""")
        self.assertLess(result['step'], 0.05)
        for trial in result['trials']:
            for key, cells in [('single', 1), ('long', 8)]:
                self.assertEqual(len(trial[key]), 1)
                note = trial[key][0]
                self.assertAlmostEqual(note['end'] - note['start'], result['step'] * cells)
        self.assertEqual([n['pitch'] for n in result['changing']], [60, 61])
        for note in result['changing']:
            self.assertAlmostEqual(note['end'] - note['start'], result['step'])

    def fretboard_hover_points(self, time=2):
        page = self.page
        page.emulate_media(reduced_motion="reduce")
        page.evaluate("""async t => {
            (await import('/store.js')).setSelection(new Set());
            (await import('/playback.js')).seekPlayback(t);
            (await import('/fretboard.js')).setFretboardVisible(true);
            await (await import('/tablature.js')).laneFingering((await import('/store.js')).S.state.editLanes[0]);
            await new Promise(requestAnimationFrame);
        }""", time)
        expect(page.locator('#fretboardBusy')).to_be_hidden()
        return page.evaluate("""async () => {
            const { drawFretboard } = await import('/fretboard.js');
            const canvas = document.querySelector('#fretboard'), ctx = canvas.getContext('2d');
            const original = ctx.fillText, labels = [];
            ctx.fillText = function(text, x, y, ...args) {
                labels.push({ text: String(text), x, y, baseline: this.textBaseline });
                return original.call(this, text, x, y, ...args);
            };
            try { drawFretboard(); } finally { ctx.fillText = original; }
            const rect = canvas.getBoundingClientRect();
            const digit = labels.find(l => /^[1-4]$/.test(l.text) && l.baseline === 'middle');
            const tuning = labels.find(l => l.text === 'E2'), high = labels.find(l => l.text === 'E4');
            const { S } = await import('/store.js');
            const { laneFingering } = await import('/tablature.js');
            const { fretboardFor, fretCentre, boardHalfWidthAt } = await import('/fretboard-core.js');
            const lane = S.state.editLanes[0], hand = await laneFingering(lane), spec = fretboardFor(lane.instrument);
            const current = hand.notes.find(n => n.start <= (S.scoreTime || 0) && n.end > (S.scoreTime || 0));
            const seat = hand.seats.get(current), scale = (tuning.y - high.y) / spec.spreadAtNut;
            const originX = tuning.x + 8 + spec.nutDepth * scale, mid = (tuning.y + high.y) / 2;
            const anchorMm = fretCentre(seat, spec);
            return { note: [rect.left + digit.x, rect.top + digit.y],
                anchor: [rect.left + originX + anchorMm * scale,
                    rect.top + mid + boardHalfWidthAt(anchorMm, spec) * scale * 0.9],
                nut: [rect.left + tuning.x + 11, rect.top + mid] };
        }""")

    def test_fretboard_single_note_alternative_navigation_and_panel_visibility(self):
        self.open_reference_project()
        page = self.page
        points = self.fretboard_hover_points()
        before = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            return { revision: S.voicingRevision, pitches: S.state.editLanes[0].notes.map(n => n.pitch),
                notes: JSON.stringify(S.state.editLanes[0].notes) };
        }""")
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-editing', '')
        for target in ('note', 'anchor', 'nut'):
            page.mouse.move(*points[target])
            expect(page.locator('#fretboardPin')).to_be_visible()
            expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        expect(page.locator('#fretboardPin')).to_be_visible()
        expect(page.locator('#fretboardAltCount')).to_have_text('2 alternatives')
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        expect(page.locator('#fretboardChoose')).to_be_hidden()
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text('1 / 2')
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '1')
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text('2 / 2')
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text('2 alternatives')
        expect(page.locator('#fretboardChoose')).to_be_hidden()
        page.locator('#fretboardAltPrev').click()
        expect(page.locator('#fretboardAltCount')).to_have_text('2 / 2')
        expect(page.locator('#fretboardChoose')).to_be_visible()
        page.keyboard.press('ArrowLeft')
        expect(page.locator('#fretboardAltCount')).to_have_text('1 / 2')
        page.keyboard.press('ArrowRight')
        expect(page.locator('#fretboardAltCount')).to_have_text('2 / 2')
        self.assertEqual(page.evaluate("async () => (await import('/playback.js')).playbackTime()"), 2)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.voicingRevision"), before['revision'])
        page.locator('#fretboardChoose').click()
        self.assertGreater(page.evaluate("async () => (await import('/store.js')).S.voicingRevision"), before['revision'])
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.map(n => n.pitch)"), before['pitches'])
        page.keyboard.press('Control+z')
        self.assertEqual(page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)"), before['notes'])
        page.evaluate('document.activeElement.blur()')
        page.mouse.move(30, 30)
        expect(page.locator('#fretboardPin')).to_be_visible()
        page.locator('#fretboardChevron').click()
        expect(page.locator('#fretboardPin')).to_be_hidden()
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-collapsed', '')
        page.mouse.move(*points['nut'])
        expect(page.locator('#fretboardPin')).to_be_hidden()
        page.locator('#fretboardChevron').click()
        expect(page.locator('#fretboardPin')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('#fretboardPin')).to_be_visible()
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-editing', '')

    def test_fretboard_capo_control_and_undo(self):
        self.open_reference_project()
        page = self.page
        self.fretboard_hover_points()
        pitches = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.map(n => n.pitch)")
        expect(page.locator('#fretboardCapo')).to_be_visible()
        expect(page.locator('#fretboardCapo')).to_be_enabled()
        page.locator('#fretboardCapo').fill('2')
        page.locator('#fretboardCapo').press('Enter')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].capo"), 2)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.map(n => n.pitch)"), pitches)
        page.keyboard.press('Control+z')
        expect(page.locator('#fretboardCapo')).to_have_value('0')
        page.locator('#lanes .lock-btn').click()
        expect(page.locator('#fretboardCapo')).to_be_disabled()
        page.locator('#lanes .lock-btn').click()
        expect(page.locator('#fretboardCapo')).to_be_enabled()

    def test_marker_flags_snap_to_note_subdivisions(self):
        self.open_reference_project()
        page = self.page
        result = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { snap, addMarker } = await import('/grid.js');
            const { railMenuItems } = await import('/marker-rails.js');
            const { closeSectionMarkerPop } = await import('/section-markers.js');
            const time = 3.31, expected = snap(time);
            railMenuItems(time,400,200).find(item => item.label === 'Add section marker').fn();
            closeSectionMarkerPop();
            const section = S.state.sectionMarkers.find(marker => Math.abs(marker.t-expected)<1e-5);
            const phrase = (await import('/phrase-markers.js')).snapPhraseTime(time);
            const tempo = addMarker(time);
            return {expected,section:section?.t,phrase,tempo:tempo.t};
        }""")
        self.assertEqual(result['section'], result['expected'])
        self.assertEqual(result['phrase'], result['expected'])
        self.assertEqual(result['tempo'], result['expected'])

    def test_marker_flag_hover_uses_grab_cursor(self):
        self.open_reference_project()
        page = self.page
        points = page.evaluate("""async () => {
            const { addMarker } = await import('/grid.js');
            const { railMenuItems, railBand } = await import('/marker-rails.js');
            addMarker(3);
            for (const [label, module, close] of [
                ['Add section marker','section-markers','closeSectionMarkerPop'],
                ['Add phrase boundary','phrase-markers','closePhraseMarkerPop'],
                ['Add tone switch','tone-markers','closeToneMarkerPop']]) {
                railMenuItems(3,400,200).find(item => item.label === label).fn();
                (await import('/'+module+'.js'))[close]();
            }
            (await import('/repaint.js')).drawNow();
            const { xOf } = await import('/geometry.js');
            const rect = document.querySelector('#stage').getBoundingClientRect();
            const scroll = document.querySelector('#scroll');
            return [10,...['section','phrase','tone'].map(id => railBand(id).y+10)]
                .map(y => [rect.left+xOf(3)-scroll.scrollLeft+8,rect.top+y]);
        }""")
        for point in points:
            page.mouse.move(*point)
            expect(page.locator('#stage')).to_have_css('cursor','grab')

    def test_detect_adds_only_new_attacks(self):
        self.open_reference_project()
        page = self.page
        page.route('**/api/detect', lambda route: route.fulfill(json={
            'notes':[{'start':2,'end':2.5,'pitch':60}, {'start':3,'end':3.5,'pitch':64},
                     {'start':3,'end':3.5,'pitch':64}]}))
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            S.state.editLanes[0].notes = [{id:'existing',start:2,end:3,pitch:60}];
            const select = document.querySelector('#detectModel');
            select.innerHTML = '<option value="mock">Test detector</option>';
            select.dispatchEvent(new Event('change'));
            (await import('/detect.js')).openDetectPanel(400,200);
        }""")
        page.click('#detectBtn')
        page.click('#confirmAppend')
        expect(page.locator('#detectStatus')).to_contain_text('+1 note')
        notes = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes")
        self.assertEqual([(n['pitch'],n['start'],n['end']) for n in notes], [(60,2,3),(64,3,3.5)])
        page.keyboard.press('Control+z')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.length"), 1)

    def test_grid_flags_control_selection_and_resize(self):
        self.open_reference_project()
        page = self.page
        points = page.evaluate("""async () => {
            const { S, setSelection } = await import('/store.js');
            const { xOf, yOf } = await import('/geometry.js');
            const { snap } = await import('/grid.js');
            const { snapPhraseTime } = await import('/phrase-markers.js');
            const lane = S.state.editLanes[0];
            lane.notes = [{id:'left',start:2,end:3,pitch:60}, {id:'right',start:3,end:4,pitch:60}];
            lane.refBoxes = {}; S.toolMode = 'select'; setSelection(new Set());
            (await import('/repaint.js')).drawNow();
            const rect = document.querySelector('#stage').getBoundingClientRect();
            const scroll = document.querySelector('#scroll');
            const point = t => [rect.left + xOf(t) - scroll.scrollLeft,
                rect.top + yOf(60) + S.state.rowH/2 - scroll.scrollTop];
            return {left:point(2.5),right:point(3.5),
                edgePoint:point(3),target:point(3.5),snap:snap(2.31),phrase:snapPhraseTime(2.31)};
        }""")
        self.assertEqual(points['snap'], points['phrase'])
        page.keyboard.down('Control')
        page.mouse.click(*points['left'])
        page.mouse.click(*points['right'])
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.selection.size"), 2)
        page.mouse.click(*points['left'])
        self.assertEqual(page.evaluate("async () => [...(await import('/store.js')).S.selection].map(n=>n.id)"), ['right'])
        page.keyboard.up('Control')
        page.mouse.click(*points['left'])
        # Stay just inside the left note's edge rather than hitting the next attack.
        page.mouse.move(points['edgePoint'][0]-2, points['edgePoint'][1])
        page.mouse.down()
        page.mouse.move(*points['target'], steps=8)
        page.mouse.up()
        times = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.map(n=>[n.start,n.end])")
        self.assertEqual(times, [[2,3.5],[3.5,4]])
        page.keyboard.press('Control+z')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.map(n=>[n.start,n.end])"), [[2,3],[3,4]])

    def test_fretboard_toolbar_light_mode_and_responsive_layout(self):
        page = self.page
        bundle = self.data / 'toolbar-showcase.chart'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.write(Path(__file__).resolve().parents[1] / 'examples/chord-showcase/project.json', 'project.json')
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(bundle)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        self.fretboard_hover_points(80)
        page.evaluate("() => { const theme = document.querySelector('input[name=theme][value=light]'); theme.checked = true; theme.dispatchEvent(new Event('input', {bubbles: true})); }")
        expect(page.locator('#fretboardAltCount')).not_to_contain_text('Loading')
        expect(page.locator('#fretboardChoose')).to_be_hidden()
        for width, height in [(1920,1080), (1280,1024), (1024,768), (900,1100)]:
            page.set_viewport_size({'width':width, 'height':height})
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            geometry = page.evaluate("""async () => {
                const canvas = document.querySelector('#fretboard'), ctx = canvas.getContext('2d');
                const original = ctx.fillText, xs = [];
                ctx.fillText = function(text, x, y, ...args) {
                    if (this.textBaseline === 'top' && ['3','21'].includes(String(text))) xs.push(x);
                    return original.call(this, text, x, y, ...args);
                };
                try { (await import('/fretboard.js')).drawFretboard(); } finally { ctx.fillText = original; }
                const stage = canvas.getBoundingClientRect(), controls = document.querySelector('#fretboardControls').getBoundingClientRect();
                return {width:stage.width, span:Math.max(...xs)-Math.min(...xs), bottom:stage.bottom, controlsTop:controls.top,
                    capoBorder:getComputedStyle(document.querySelector('#fretboardHandField')).borderLeftWidth,
                    shapeGrouped:document.querySelector('#fretboardShape').parentElement === document.querySelector('#fretboardAlternatives').parentElement};
            }""")
            self.assertGreater(geometry['span'], geometry['width'] * .65, (width, height, geometry))
            self.assertLessEqual(geometry['bottom'], geometry['controlsTop'] + 1, geometry)
            self.assertEqual(geometry['capoBorder'], '1px')
            self.assertTrue(geometry['shapeGrouped'])
            shot = Path(__file__).resolve().parents[1] / '.runs' / f'fretboard-toolbar-{width}x{height}.png'
            shot.parent.mkdir(exist_ok=True)
            page.locator('#fretboardPanel').screenshot(path=str(shot))
        page.set_viewport_size({'width':1440, 'height':900})
        audit_script = """() => {
            const ctx = document.createElement('canvas').getContext('2d');
            const rgb = s => { ctx.clearRect(0,0,1,1); ctx.fillStyle=s; ctx.fillRect(0,0,1,1); const c=[...ctx.getImageData(0,0,1,1).data]; return [...c.slice(0,3),c[3]/255]; };
            const over = (a,b) => a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
            const lum = c => c.map(v=>{v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
            return [...document.querySelectorAll('button')].filter(el=>!el.disabled && el.getClientRects().length && getComputedStyle(el).visibility==='visible').map(el=>{
                const chain=[]; for(let p=el;p;p=p.parentElement) chain.push(rgb(getComputedStyle(p).backgroundColor));
                let bg=[255,255,255]; for(const c of chain.reverse()) bg=over(c,bg);
                const text=over(rgb(getComputedStyle(el).color),bg), a=lum(text),b=lum(bg);
                const visibleText = [...el.childNodes].some(n => n.nodeType===3 ? n.textContent.trim() : n.textContent.trim() && Number(getComputedStyle(n).opacity)>0);
                return {id:el.id||el.getAttribute('aria-label'),text:visibleText?el.textContent.trim().slice(0,40):'',ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
            }).filter(x=>x.ratio < (x.text?4.5:3));
        }"""
        # Audit the current controls in both hover and engaged states.
        page.locator('#fretboardAltNext').hover()
        self.assertEqual(page.evaluate(audit_script), [], 'Hovered light-mode buttons need readable foregrounds')
        page.locator('#fretboardShape').click()
        page.locator('#fretboardShape').hover()
        self.assertEqual(page.evaluate(audit_script), [], 'Engaged light-mode buttons need readable foregrounds')
        page.keyboard.press('Escape')
        page.mouse.move(5,5)
        self.assertEqual(page.evaluate(audit_script), [], 'Visible light-mode buttons need readable foregrounds')
        page.click('#settingsMenuBtn')
        self.assertEqual(page.evaluate(audit_script), [], 'Light-mode settings buttons need readable foregrounds')
        page.click('#settingsModalClose')

    def test_custom_shape_only_shows_draft_notes_and_supports_revisiting(self):
        page = self.page
        bundle = self.data / 'custom-shape-showcase.chart'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.write(Path(__file__).resolve().parents[1] / 'examples/chord-showcase/project.json', 'project.json')
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(bundle)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        self.fretboard_hover_points(80)
        original = page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)")
        expect(page.locator('#fretboardAltCount')).not_to_contain_text('Loading')
        page.locator('#fretboardShape').click()
        expect(page.locator('#fretboardShape')).to_have_text('Cancel')
        expect(page.locator('#fretboardApply')).to_have_text('Done')
        expect(page.locator('#fretboardApply')).to_be_disabled()
        for selector in ['#fretboardSetup','#fretboardCapoField','#fretboardHandField','#fretboardAlternatives','#fretboardInfluence']:
            expect(page.locator(selector)).to_be_hidden()

        def painted():
            return page.evaluate("""async () => {
                const canvas=document.querySelector('#fretboard'), ctx=canvas.getContext('2d');
                const original={begin:ctx.beginPath,arc:ctx.arc,stroke:ctx.stroke,text:ctx.fillText};
                const rings=[],notes=[],tuning={}; let arc=null;
                ctx.beginPath=function(...a){arc=null;return original.begin.apply(this,a);};
                ctx.arc=function(x,y,r,...a){arc={x,y,r};return original.arc.call(this,x,y,r,...a);};
                ctx.stroke=function(...a){if(arc)rings.push(arc);return original.stroke.apply(this,a);};
                ctx.fillText=function(text,x,y,...a){
                    if(this.textBaseline==='middle' && /^[A-G]#?[0-9]$/.test(String(text))) {
                        if(this.textAlign==='right') tuning[text]={x,y}; else notes.push(text);
                    }
                    return original.text.call(this,text,x,y,...a);
                };
                try{(await import('/fretboard.js')).drawFretboard();}finally{ctx.beginPath=original.begin;ctx.arc=original.arc;ctx.stroke=original.stroke;ctx.fillText=original.text;}
                const rect=canvas.getBoundingClientRect();
                return {rings,notes,tuning,left:rect.left,top:rect.top};
            }""")

        def pick(string, fret):
            sample = painted()
            point = page.evaluate("""async ({sample,string,fret}) => {
                const {fretboardFor,fretCentre,stringOffsetAt}=await import('/fretboard-core.js');
                const s=fretboardFor('electric'), lo=sample.tuning.E2, hi=sample.tuning.E4;
                const scale=(lo.y-hi.y)/s.spreadAtNut, mm=fretCentre(fret,s);
                return [sample.left+lo.x+8+s.nutDepth*scale+mm*scale,
                    sample.top+(lo.y+hi.y)/2+stringOffsetAt(string,Math.max(0,mm),s)*scale];
            }""", {'sample':sample,'string':string,'fret':fret})
            page.mouse.click(*point)

        self.assertEqual(set(painted()['notes']), {'A2'})
        self.assertEqual(len(painted()['rings']), 2, 'Only the two A2 placements may be outlined; no original-chord ghosts')
        expect(page.locator('#fretboardName')).to_have_text('1 / 3 \u00b7 A2')
        page.locator('#fretboardShapeNext').click()
        expect(page.locator('#fretboardName')).to_have_text('2 / 3 \u00b7 G3')
        page.locator('#fretboardShapePrev').click()
        pick(4,0)
        expect(page.locator('#fretboardName')).to_have_text('2 / 3 \u00b7 G3')
        self.assertEqual(set(painted()['notes']), {'A2','G3'})
        pick(3,5)
        expect(page.locator('#fretboardName')).to_have_text('3 / 3 \u00b7 C4')
        pick(2,5)
        expect(page.locator('#fretboardApply')).to_be_enabled()
        page.locator('#fretboardShapePrev').click()
        expect(page.locator('#fretboardName')).to_have_text('2 / 3 \u00b7 G3')
        page.locator('#fretboardShapePrev').click()
        self.assertEqual(len(painted()['rings']), 2, 'Returning to a note must allow its current string again')
        pick(5,5)
        expect(page.locator('#fretboardApply')).to_be_enabled()
        pick(4,0)
        pick(2,5)  # A previously placed note is selectable without clearing it.
        expect(page.locator('#fretboardName')).to_have_text('3 / 3 \u00b7 C4')
        expect(page.locator('#fretboardApply')).to_be_enabled()
        self.assertEqual(page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)"), original)
        shot=Path(__file__).resolve().parents[1]/'.runs'/'custom-shape-navigation.png'
        page.locator('#fretboardPanel').screenshot(path=str(shot))
        page.locator('#fretboardShape').click()
        expect(page.locator('#fretboardShape')).to_have_text('Custom shape')
        expect(page.locator('#fretboardSetup')).to_be_visible()
        self.assertEqual(page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)"), original)
        page.locator('#fretboardShape').click()
        pick(4,0);pick(3,5);pick(2,5)
        page.locator('#fretboardApply').click()
        expect(page.locator('#fretboardSetup')).to_be_visible()
        expect(page.locator('#fretboardShape')).to_have_text('Custom shape')
        actual=page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.find(n=>n.start===80&&n.pitch===45).pos")
        self.assertEqual((actual['string'],actual['fret']), (4,0))
        page.keyboard.press('Control+z')
        self.assertEqual(page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)"), original)

    def test_fretboard_label_choices_and_custom_shape_targets(self):
        page = self.page
        bundle = self.data / 'label-showcase.chart'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.write(Path(__file__).resolve().parents[1] / 'examples/chord-showcase/project.json', 'project.json')
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(bundle)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        self.fretboard_hover_points(20)

        def painted_labels():
            return page.evaluate("""async () => {
                const { UI_PAINT: paint } = await import('/stage-paint.js');
                const ctx = document.querySelector('#fretboard').getContext('2d');
                const original = ctx.fillText, stroke = ctx.stroke, roundRect = ctx.roundRect;
                const fingers = [], notes = [], inks = [], noteInks = [], noteX = {}, fingerX = [], dotted = [], boxes = [];
                ctx.roundRect = function(x, y, w, h, ...args) {
                    if (w < 40 && h < 20) boxes.push({x, y, w, h});
                    return roundRect.call(this, x, y, w, h, ...args);
                };
                ctx.stroke = function(...args) {
                    if (this.getLineDash().length) dotted.push(this.getLineDash());
                    return stroke.apply(this, args);
                };
                ctx.fillText = function(text, x, y, ...args) {
                    if (this.textBaseline === 'middle' && this.globalAlpha > .9) {
                        if (/^[1-4]$/.test(String(text))) { fingers.push(text); fingerX.push(x); inks.push(this.fillStyle); }
                        if (/^[A-G]#?[0-9]$/.test(String(text)) && ['#0f1012', '#edeef0', paint.text].includes(this.fillStyle)) {
                            notes.push(text); noteInks.push(this.fillStyle); noteX[text] = x;
                        }
                    }
                    return original.call(this, text, x, y, ...args);
                };
                try { (await import('/fretboard.js')).drawFretboard(); } finally { ctx.fillText = original; ctx.stroke = stroke; ctx.roundRect = roundRect; }
                return {fingers, notes, inks, noteInks, noteX, fingerX, dotted, boxes, textInk: paint.text};
            }""")

        page.click('#settingsMenuBtn')
        expect(page.locator('input[name=fretboardLabels][value=both]')).to_be_checked()
        expect(page.locator('#fretboardSettingsPreview')).to_be_visible()
        self.assertEqual(page.locator('input[name=fretboardLabels]').count(), 4)
        shot = Path(__file__).resolve().parents[1] / '.runs' / 'fretboard-label-settings.png'
        shot.parent.mkdir(exist_ok=True)
        page.locator('#settingsModal').screenshot(path=str(shot))
        for mode, fingers, notes in [('fingers', 3, 0), ('notes', 0, 6), ('both', 3, 6), ('none', 0, 0)]:
            page.locator(f'input[name=fretboardLabels][value={mode}]').check()
            actual = painted_labels()
            self.assertEqual(len(actual['fingers']), fingers, mode)
            self.assertEqual(len(actual['notes']), notes, mode)
            if notes:
                self.assertTrue({'D3', 'G3', 'B3'}.issubset(actual['notes']))
                self.assertEqual(len(actual['dotted']), 0, 'Open strings are plain text')
                self.assertEqual(len(actual['boxes']), 3 if mode == 'notes' else 0)
            if mode == 'fingers':
                contact_x = sorted(actual['fingerX'])
            if mode == 'notes':
                self.assertEqual(sorted(actual['noteX'][pitch] for pitch in ['G2', 'B2', 'G4']), contact_x)
            if mode == 'both':
                for pitch in ['D3', 'G3', 'B3']:
                    self.assertEqual(actual['noteX'][pitch], min(contact_x))
        # Contrast follows the selected layer hue in both labels and previews.
        page.evaluate("async () => { const {S} = await import('/store.js'); S.state.editLanes[0].color = '#2b7a53'; }")
        page.locator('input[name=fretboardLabels][value=both]').check()
        self.assertEqual(set(painted_labels()['inks']), {'#edeef0'})
        self.assertEqual(set(painted_labels()['noteInks']), {painted_labels()['textInk']})
        page.evaluate("() => { const theme = document.querySelector('input[name=theme][value=light]'); theme.checked = true; theme.dispatchEvent(new Event('input', {bubbles: true})); }")
        page.locator('#settingsModal').screenshot(path=str(shot.with_name('fretboard-label-settings-light.png')))
        page.evaluate("""async () => {
            const {S} = await import('/store.js'); S.state.editLanes[0].color = '#64ecc0';
            const theme = document.querySelector('input[name=theme][value=dark]'); theme.checked = true; theme.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        self.assertEqual(set(painted_labels()['inks']), {'#0f1012'})
        page.click('#settingsModalClose')
        expect(page.locator('input[name=fretboardLabels][value=both]')).to_be_checked()
        self.assertEqual(len(painted_labels()['notes']), 6)
        page.click('#settingsMenuBtn')
        page.locator('input[name=fretboardLabels][value=none]').check()
        self.apply_settings_and_close()
        self.assertEqual(page.evaluate("JSON.parse(localStorage.getItem('cw.settings')).fretboardLabels"), 'none')
        page.click('#fretboardShape')
        actual = painted_labels()
        self.assertTrue(actual['notes'], 'Custom-shape placement rings must identify their note even with playback labels off')
        self.assertEqual(actual['fingers'], [])
        page.locator('#fretboardPanel').screenshot(path=str(shot.with_name('fretboard-custom-labels.png')))
        page.reload()
        expect(page.locator('input[name=fretboardLabels][value=none]')).to_be_checked()

    def test_showcase_hand_poses_are_rendered_with_matching_anchors(self):
        page = self.page
        bundle = self.data / 'joint-hand-showcase.chart'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.write(Path(__file__).resolve().parents[1] / 'examples/chord-showcase/project.json', 'project.json')
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(bundle)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        self.fretboard_hover_points(68)
        for start, anchor, digits in [(20,2,[1,2,4]), (68,4,[1,2,3,4]), (72,6,[1,2,3,4]), (84,5,[1,3]), (92,5,[1,3])]:
            page.evaluate("async t => (await import('/playback.js')).seekPlayback(t)", start)
            expect(page.locator('#fretboardAltCount')).not_to_contain_text('Loading')
            actual = page.evaluate("""async start => {
                const { S } = await import('/store.js');
                const found = await (await import('/tablature.js')).laneFingering(S.state.editLanes[0]);
                const notes = found.notes.filter(n => n.start === start);
                const ctx = document.querySelector('#fretboard').getContext('2d');
                const original = ctx.fillText, clear = ctx.clearRect, digits = [];
                // Layout can repaint recursively. Only the last cleared canvas remains visible.
                ctx.clearRect = function(...args) { digits.length = 0; return clear.apply(this, args); };
                ctx.fillText = function(text, x, y, ...args) {
                    if (/^[1-4]$/.test(String(text)) && this.textBaseline === 'middle' && this.globalAlpha > .9)
                        digits.push(Number(text));
                    return original.call(this,text,x,y,...args);
                };
                try { (await import('/fretboard.js')).drawFretboard(); }
                finally { ctx.fillText = original; ctx.clearRect = clear; }
                return {seats:notes.map(n=>found.seats.get(n)),digits:digits.sort()};
            }""", start)
            self.assertEqual(set(actual['seats']), {anchor})
            self.assertEqual(actual['digits'], digits)
            expect(page.locator('#fretboardHandAuto')).to_have_text(f'({anchor})')
            expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count','0')
            shot = Path(__file__).resolve().parents[1] / '.runs' / f'joint-hand-case-{int(start/4+1)}.png'
            shot.parent.mkdir(exist_ok=True)
            page.locator('#fretboardPanel').screenshot(path=str(shot))

    def test_fretboard_anchor_band_moves_with_animation(self):
        self.open_reference_project()
        page = self.page
        self.fretboard_hover_points()
        result = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { drawFretboard, setFretboardEdit } = await import('/fretboard.js');
            const { laneFingering } = await import('/tablature.js');
            const { hexA } = await import('/util.js');
            const { WASH } = await import('/stage-paint.js');
            const lane = S.state.editLanes[0];
            lane.notes = [{id:'a',start:0,end:1,pitch:52,pos:{string:3,fret:2}},
                {id:'b',start:1,end:2,pitch:58,pos:{string:3,fret:8}}];
            lane.refBoxes = {}; S.voicingRevision++;
            (await import('/store.js')).setSelection(new Set());
            setFretboardEdit(false);  // sample the transport, without a held alternative-edit column
            (await import('/playback.js')).seekPlayback(.75);
            await laneFingering(lane);
            drawFretboard(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            const ctx = document.querySelector('#fretboard').getContext('2d');
            const original = {begin:ctx.beginPath,move:ctx.moveTo,line:ctx.lineTo,fill:ctx.fill};
            ctx.fillStyle = hexA(lane.color,WASH); const bandColor = ctx.fillStyle;
            let points = [], bands = [];
            ctx.beginPath = function(...a) {points=[];return original.begin.apply(this,a);};
            ctx.moveTo = function(x,y) {points.push([x,y]);return original.move.call(this,x,y);};
            ctx.lineTo = function(x,y) {points.push([x,y]);return original.line.call(this,x,y);};
            ctx.fill = function(...a) {if(this.fillStyle===bandColor && points.length===4) bands.push(points.map(p=>[...p])); return original.fill.apply(this,a);};
            const paint = async (time,playing,animate) => {
                S.scorePlaying=playing; S.scoreTime=time; S.scoreAnchorSong=time; S.scoreAnchorClock=performance.now()/1000;
                document.querySelector('#fretboardAnimations').checked=animate;
                drawFretboard(); await new Promise(requestAnimationFrame);
                S.scoreTime=time; S.scoreAnchorSong=time; S.scoreAnchorClock=performance.now()/1000;
                bands=[];drawFretboard();return bands[0]?.[0][0];
            };
            try {
                return {from:await paint(0,false,false),middle:await paint(.75,true,true),
                    off:await paint(.75,true,false),to:await paint(1,false,false)};
            } finally {
                S.scorePlaying=false;
                ctx.beginPath=original.begin;ctx.moveTo=original.move;ctx.lineTo=original.line;ctx.fill=original.fill;
            }
        }""")
        self.assertGreater(result['middle'], min(result['from'], result['to']), result)
        self.assertLess(result['middle'], max(result['from'], result['to']), result)
        self.assertAlmostEqual(result['off'],result['from'],places=5)

    def test_unplayable_chord_warning_and_shape_exit_on_seek(self):
        page = self.page
        bundle = self.data / 'chord-warnings.chart'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.write(Path(__file__).resolve().parents[1] / 'examples/chord-showcase/project.json', 'project.json')
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(bundle)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        self.fretboard_hover_points(76)
        expect(page.locator('#fretboardAltCount')).to_have_text('No alternatives')
        expect(page.locator('#fretboardAltNext')).to_be_disabled()
        shot = Path(__file__).resolve().parents[1] / '.runs' / 'fretboard-controls-b7.png'
        shot.parent.mkdir(exist_ok=True)
        page.locator('#fretboardPanel').screenshot(path=str(shot))
        page.evaluate("async () => (await import('/playback.js')).seekPlayback(80)")
        page.locator('#fretboardShape').click()
        expect(page.locator('#fretboardShape')).to_have_text('Cancel')
        page.evaluate("async () => (await import('/playback.js')).seekPlayback(100)")
        expect(page.locator('#fretboardShape')).to_have_attribute('aria-pressed', 'false')
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-unplayable', '')
        expect(page.locator('#fretboardWarning')).to_contain_text('No valid shape found')
        for start in [96,100,104,108]:
            page.evaluate("async t => (await import('/playback.js')).seekPlayback(t)", start)
            expect(page.locator('#fretboardWarning')).to_be_visible()
            expect(page.locator('#fretboardShowAnyway')).to_be_hidden()
            count = page.evaluate("""async () => {
                const ctx = document.querySelector('#fretboard').getContext('2d'), original = ctx.fillText;
                let digits = 0; const strings = [];
                ctx.fillText = function(text,...args) {
                    if (/^[1-4]$/.test(String(text)) && this.textBaseline === 'middle') digits++;
                    if (['E2','E4'].includes(String(text))) strings.push(args[1]);
                    return original.call(this,text,...args);
                };
                try { (await import('/fretboard.js')).drawFretboard(); } finally { ctx.fillText = original; }
                return {digits,strings};
            }""")
            self.assertEqual(count['digits'],0,'invalid chords must not paint fingerings or onion skins')
            expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count','0')
        warning = page.locator('#fretboardWarning').bounding_box()
        board = page.locator('#fretboard').bounding_box()
        self.assertAlmostEqual(warning['x']+warning['width']/2,board['x']+board['width']/2,delta=2)
        self.assertEqual(len(count['strings']),2)
        self.assertAlmostEqual(warning['y']+warning['height']/2,board['y']+sum(count['strings'])/2,delta=2)
        page.evaluate("async () => (await import('/playback.js')).seekPlayback(100)")

        page.evaluate("""async () => {
            const { xOf } = await import('/geometry.js');
            document.querySelector('#scroll').scrollLeft = xOf(98);
            (await import('/repaint.js')).drawNow();
        }""")
        shot = Path(__file__).resolve().parents[1] / '.runs' / 'chord-warning.png'
        shot.parent.mkdir(exist_ok=True)
        page.locator('#appshell').screenshot(path=str(shot))
        page.evaluate("""async () => {
            (await import('/store.js')).setSelection(new Set());
            (await import('/playback.js')).seekPlayback(0);
        }""")
        expect(page.locator('#fretboardPanel')).not_to_have_attribute('data-unplayable', '')

    def test_fretboard_previews_only_one_chord_alternative(self):
        page = self.page
        bundle = self.data / 'chord-showcase.chart'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.write(Path(__file__).resolve().parents[1] / 'examples/chord-showcase/project.json', 'project.json')
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(bundle)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        points = self.fretboard_hover_points(80)
        original = page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)")
        page.mouse.move(*points['note'])
        expect(page.locator('#fretboardPin')).to_be_visible()
        expect(page.locator('#fretboardAltCount')).to_have_text(re.compile(r'[1-9][0-9]* alternatives'))
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        expect(page.locator('#fretboardChoose')).to_be_hidden()
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text(re.compile(r'1 / [1-9][0-9]*'))
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '1')
        count = int(page.locator('#fretboardAltCount').inner_text().split('/')[1])
        self.assertGreater(count, 1)
        alphas = page.evaluate("""async () => {
            const { drawFretboard, setFretboardEdit } = await import('/fretboard.js');
            const ctx = document.querySelector('#fretboard').getContext('2d'), original = ctx.fillText, alphas = [];
            ctx.fillText = function(text, x, y, ...args) {
                if (/^[1-4]$/.test(String(text)) && this.textBaseline === 'middle') alphas.push(this.globalAlpha);
                return original.call(this, text, x, y, ...args);
            };
            try { drawFretboard(); } finally { ctx.fillText = original; }
            return alphas;
        }""")
        self.assertTrue(any(0 < a < 0.5 for a in alphas), alphas)
        self.assertIn(1, alphas)
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text(f'2 / {count}')
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '1')
        page.keyboard.press('ArrowLeft')
        expect(page.locator('#fretboardAltCount')).to_have_text(f'1 / {count}')
        self.assertEqual(page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)"), original)
        page.locator('#fretboardPanel').screenshot(path=str(self.data / 'one-chord-alternative.png'))
        page.locator('#fretboardChoose').click()
        self.assertNotEqual(page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes)"), original)

    def test_fretboard_reset_preview_restores_original_shape(self):
        self.test_fretboard_previews_only_one_chord_alternative()
        page = self.page
        page.mouse.move(5, 5)
        page.locator('#fretboardAuto').hover()
        expect(page.locator('#fretboardResetStatus')).to_have_text('Reset preview')
        self.assertFalse(self.faults, self.faults)
        page.locator('#fretboardAuto').click()
        expect(page.locator('#fretboardResetStatus')).to_be_hidden()
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        positions = page.evaluate("""async () => {
            const lane = (await import('/store.js')).S.state.editLanes[0];
            return lane.notes.filter(n => n.start === 80).map(n => [n.pos.string, n.pos.fret]).sort();
        }""")
        self.assertEqual(positions, [[2, 5], [3, 5], [5, 5]])
        page.keyboard.press('Control+z')
        self.assertTrue(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.some(n => n.start === 80 && n.written)"))

    def test_fretboard_integer_steppers_and_defaults(self):
        self.open_reference_project()
        page = self.page
        self.fretboard_hover_points()
        expect(page.locator('#fretboardHand')).to_have_attribute('type','text')
        expect(page.locator('#fretboardCapo')).to_have_attribute('type','text')
        expect(page.locator('#fretboardHandAuto')).to_have_text(re.compile(r'\([1-9][0-9]*\)'))
        page.locator('#fretboardCapoNext').click()
        expect(page.locator('#fretboardCapo')).to_have_value('1')
        page.locator('#fretboardCapoPrev').click()
        expect(page.locator('#fretboardCapo')).to_have_value('0')
        for invalid in ['-1','1.5','text']:
            page.locator('#fretboardCapo').fill(invalid)
            page.locator('#fretboardCapo').press('Enter')
            expect(page.locator('#fretboardCapo')).to_have_value('0')
        page.locator('#fretboardHand').fill('7')
        page.locator('#fretboardHand').press('Enter')
        page.locator('#fretboardHandNext').click()
        expect(page.locator('#fretboardHand')).to_have_value('8')
        page.locator('#fretboardHandPrev').click()
        expect(page.locator('#fretboardHand')).to_have_value('7')
        expect(page.locator('#fretboardHandAuto')).to_be_hidden()
        for invalid in ['0','-1','1.5']:
            page.locator('#fretboardHand').fill(invalid)
            page.locator('#fretboardHand').press('Enter')
            expect(page.locator('#fretboardHand')).to_have_value('7')
        page.locator('#fretboardHand').fill('')
        page.locator('#fretboardHand').press('Enter')
        expect(page.locator('#fretboardHandAuto')).to_be_visible()
        defaults = page.evaluate("async () => (await import('/voicing-core.js')).defaultPinFlags()")
        self.assertEqual(set(defaults.values()), {False})

    def test_fretboard_hand_position_field(self):
        self.open_reference_project()
        page = self.page
        self.fretboard_hover_points()
        expect(page.locator('#fretboardHand')).to_be_visible()
        expect(page.locator('#fretboardHand')).to_be_enabled()
        page.locator('#fretboardHand').fill('7')
        page.locator('#fretboardHand').press('Enter')
        holds = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].handHolds")
        self.assertEqual(holds, [{'t': 2, 'fret': 7}])
        page.locator('#fretboardHand').fill('')
        page.locator('#fretboardHand').press('Enter')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].handHolds"), [])
        page.keyboard.press('Control+z')
        expect(page.locator('#fretboardHand')).to_have_value('7')
        page.locator('#lanes .lock-btn').click()
        expect(page.locator('#fretboardHand')).to_be_disabled()
        page.locator('#lanes .lock-btn').click()
        expect(page.locator('#fretboardHand')).to_be_enabled()

    def test_minimap_eases_while_pointer_keeps_moving(self):
        self.open_reference_project()
        result = self.page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { MM_HEAD } = await import('/constants.js');
            const { moveViewportTo, stopViewportMotion, viewportMoving } = await import('/viewport-motion.js');
            const scroll = document.querySelector('#scroll');
            const minimap = document.querySelector('#minimap');
            const r = minimap.getBoundingClientRect();
            const frame = () => new Promise(requestAnimationFrame);
            const event = (target, type, fraction, y) => target.dispatchEvent(new MouseEvent(type,
                { bubbles: true, button: 0, buttons: type === 'mouseup' ? 0 : 1,
                  clientX: r.left + r.width * fraction, clientY: y }));
            const samples = [];
            for (const y of [r.top + MM_HEAD + 8, r.top + 3]) {
                stopViewportMotion(); scroll.scrollLeft = 0;
                moveViewportTo(scroll.scrollWidth - scroll.clientWidth);
                event(minimap, 'mousedown', 1, y);
                const immediate = scroll.scrollLeft;
                const path = [];
                // Continual events must not reset easing and stall its progress.
                for (let i = 0; i < 8; i++) {
                    event(window, 'mousemove', 1, y);
                    await frame();
                    path.push(scroll.scrollLeft);
                }
                const max = scroll.scrollWidth - scroll.clientWidth;
                const beforeReverse = scroll.scrollLeft;
                event(window, 'mousemove', 0, y);
                const afterReverse = scroll.scrollLeft;
                await frame(); await frame();
                const reversed = scroll.scrollLeft;
                event(window, 'mouseup', 0, y);
                for (let i = 0; i < 120 && viewportMoving(); i++) await frame();
                samples.push({ immediate, path, max, beforeReverse, afterReverse, reversed,
                    finalLeft: scroll.scrollLeft, moving: viewportMoving() });
            }
            return { samples, dragging: S.mmDragging, seeking: S.mmSeeking };
        }""")
        for sample in result["samples"]:
            self.assertEqual(sample["immediate"], 0, "viewport eases instead of jumping")
            self.assertGreater(sample["max"], 0)
            self.assertGreater(sample["path"][-1], sample["max"] * 0.4,
                               "viewport follows even while mouse events keep arriving")
            self.assertTrue(all(a <= b for a, b in zip(sample["path"], sample["path"][1:])))
            self.assertLess(sample["path"][0], sample["max"], "first frame does not jump to the target")
            self.assertEqual(sample["afterReverse"], sample["beforeReverse"])
            self.assertLess(sample["reversed"], sample["beforeReverse"])
            self.assertEqual(sample["finalLeft"], 0)
            self.assertFalse(sample["moving"])
        self.assertFalse(result["dragging"])
        self.assertFalse(result["seeking"])
        self.page.emulate_media(reduced_motion="reduce")
        self.assertTrue(self.page.evaluate("""async () => {
            const { followViewportTo, viewportMoving } = await import('/viewport-motion.js');
            const scroll = document.querySelector('#scroll');
            const target = scroll.scrollWidth - scroll.clientWidth;
            followViewportTo(target);
            return scroll.scrollLeft === target && !viewportMoving();
        }"""))

    def test_timeline_scrolling_preview_animation(self):
        self.open_reference_project()
        page = self.page
        before = page.evaluate("async () => (await import('/playback.js')).playbackTime()")
        page.click('#settingsMenuBtn')
        preview = page.locator('#timelineScrollPreview')
        follow = page.locator('#timelineScrollPreviewFollow')
        expect(preview).to_be_visible()
        expect(preview).to_have_attribute('data-running', 'false')
        preview.hover()
        expect(preview).to_have_attribute('data-running', 'true')
        boundary = page.evaluate("""async () => {
            const canvas = document.querySelector('#timelineScrollPreview');
            let lastHead = 0;
            const deadline = performance.now() + 10000;
            while (!Number(canvas.dataset.scroll) && performance.now() < deadline) {
                lastHead = Number(canvas.dataset.playhead);
                await new Promise(requestAnimationFrame);
            }
            const viewport = canvas.clientWidth - 16;
            const referenceWidth = document.querySelector('#scroll').clientWidth;
            return {lastHead, viewport, scrolled:Number(canvas.dataset.scroll), expected:viewport * (1 - 60 / referenceWidth)};
        }""")
        self.assertGreater(boundary['scrolled'], 0, boundary)
        self.assertGreater(boundary['lastHead'], boundary['viewport'] * .85)
        self.assertAlmostEqual(boundary['lastHead'], boundary['expected'], delta=8)
        # Hovering the other card switches the animation, without choosing a preference.
        follow.hover()
        expect(preview).to_have_attribute('data-running', 'false')
        expect(follow).to_have_attribute('data-running', 'true')
        page.wait_for_function("Number(document.querySelector('#timelineScrollPreviewFollow').dataset.scroll) > 0")
        sample = follow.evaluate("""canvas => ({head:Number(canvas.dataset.playhead), width:canvas.clientWidth,
            referenceWidth:document.querySelector('#scroll').clientWidth})""")
        self.assertAlmostEqual(sample['head'], (sample['width'] - 16) * min(60 / sample['referenceWidth'], .1), delta=1)
        expect(page.locator('#playbackScrollMode')).to_have_value('page')
        page.locator('#settingsModalTitle').hover()
        expect(follow).to_have_attribute('data-running', 'false')
        paused = follow.evaluate('(canvas) => canvas.toDataURL()')
        page.evaluate('() => new Promise(resolve => setTimeout(resolve, 150))')
        self.assertEqual(follow.evaluate('(canvas) => canvas.toDataURL()'), paused)
        self.assertEqual(page.locator('input[name=playbackScrollMode]').count(), 2)
        page.click('[data-settings-pane=appearance]')
        expect(preview).to_have_attribute('data-running', 'false')
        page.click('[data-settings-pane=trace]')
        expect(preview).to_have_attribute('data-running', 'false')
        preview.hover()
        expect(preview).to_have_attribute('data-running', 'true')
        page.click('#settingsModalClose')
        expect(preview).to_have_attribute('data-running', 'false')
        after = page.evaluate("async () => (await import('/playback.js')).playbackTime()")
        self.assertEqual(after, before, 'The preview must not move the project playhead')
        page.emulate_media(reduced_motion='reduce')
        page.reload()
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=trace]')
        preview.hover()
        expect(preview).to_have_attribute('data-running', 'false')
        page.emulate_media(reduced_motion='no-preference')
        expect(preview).to_have_attribute('data-running', 'true')
        page.click('#settingsModalClose')
        expect(preview).to_have_attribute('data-running', 'false')

    def test_fretboard_settings_preview_matches_the_live_neck(self):
        self.open_reference_project()
        page=self.page
        page.click('#settingsMenuBtn')
        page.locator('#spectrogramSettings > button').click()
        result=page.evaluate("""async () => {
            const {S}=await import('./store.js'); const board=await import('./fretboard.js');
            const {UI_PAINT}=await import('./stage-paint.js'); const {hexA,dpr}=await import('./util.js');
            document.querySelector('#fretboardAnimations').checked=false;
            document.querySelector('#fretboardOnionEnabled').checked=false;
            document.querySelector('input[name=fretboardLabels][value=none]').checked=true;
            board.setFretboardVisible(true);
            await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
            const live=document.querySelector('#fretboard'),preview=document.querySelector('#fretboardSettingsPreview');
            preview.style.width=(live.width/dpr()+2)+'px';preview.style.height=(live.height/dpr()+2)+'px';
            const capture=(canvas,draw) => {
                const ctx=canvas.getContext('2d'),original=ctx.fillRect,wires=[];
                ctx.fillStyle=hexA(UI_PAINT.label,.6);const wireColor=ctx.fillStyle;
                ctx.fillRect=function(...bounds){if(this.fillStyle===wireColor)wires.push(bounds.map(n=>+n.toFixed(5)));return original.apply(this,bounds);};
                try{draw();}finally{ctx.fillRect=original;}
                return wires;
            };
            const actual=capture(live,()=>board.drawFretboard());
            const settings=capture(preview,()=>board.drawFretboardSettingsPreview(1.5));
            preview.style.width='';preview.style.height='';
            return {actual,settings};
        }""")
        self.assertEqual(len(result['actual']),22)
        self.assertEqual(len(result['settings']),12)
        actual, settings = result['actual'][:12], result['settings']
        scale = settings[0][3] / actual[0][3]
        for live, preview in zip(actual, settings):
            # Cropping changes the fitted scale, not the physical instrument.
            self.assertAlmostEqual(preview[0]-settings[0][0], (live[0]-actual[0][0])*scale, delta=.001)
            self.assertAlmostEqual(preview[1]-settings[0][1], (live[1]-actual[0][1])*scale, delta=.001)
            self.assertAlmostEqual(preview[3], live[3]*scale, delta=.001)
        page.screenshot(path='design-shots/editor-fretboard-two-columns.png')
        samples=page.evaluate("""async () => {
            const board=await import('./fretboard.js'),canvas=document.querySelector('#fretboardSettingsPreview');
            const control=document.querySelector('#fretboardAnimations');
            const sample=(time)=>{board.drawFretboardSettingsPreview(time);return canvas.toDataURL();};
            const still=[sample(.08),sample(.14),sample(2.0),sample(6.08)];
            control.checked=true;
            const moving=[sample(.08),sample(.14)];
            return {still,moving};
        }""")
        self.assertTrue(samples['still'][0]==samples['still'][1], 'no movement between attacks when disabled')
        self.assertTrue(samples['still'][0]!=samples['still'][2], 'chords still change with animation disabled')
        self.assertTrue(samples['still'][2]!=samples['still'][3], 'phrase continues into single notes')
        self.assertTrue(samples['moving'][0]!=samples['moving'][1], 'enabled preview includes string attack effects')


    def test_note_label_font_size_preview_apply_and_cancel(self):
        self.open_reference_project()
        page = self.page
        page.click('#settingsMenuBtn')
        slider = page.locator('#noteLabelSize')
        expect(slider).to_have_value('12')
        slider.evaluate("el => {el.value='16'; el.dispatchEvent(new Event('input', {bubbles:true}));}")
        expect(page.locator('#noteLabelSizeValue')).to_have_text('16 px')
        fonts = page.evaluate("""async () => {
            const preview = await import('./editor-previews.js');
            const notes = await import('./note-render.js');
            const capture = (id, paint) => {
                const ctx=document.querySelector(id).getContext('2d'), original=ctx.fillText, fonts=[];
                ctx.fillText=function(...args){fonts.push(this.font); return original.apply(this,args);};
                try{paint();}finally{ctx.fillText=original;}
                return fonts;
            };
            return {preview:capture('#noteAppearancePreview',preview.drawNoteAppearancePreview),
                actual:capture('#stage',notes.drawNoteFx)};
        }""")
        self.assertTrue(fonts['preview'])
        self.assertTrue(fonts['actual'])
        self.assertTrue(all('16px' in font for font in fonts['preview']+fonts['actual']), fonts)
        page.locator('#noteAppearancePreview').scroll_into_view_if_needed()
        page.screenshot(path='design-shots/editor-note-appearance.png')
        page.click('#settingsApply')
        slider.evaluate("el => {el.value='10'; el.dispatchEvent(new Event('input', {bubbles:true}));}")
        page.click('#settingsModalClose')
        page.click('#settingsMenuBtn')
        expect(slider).to_have_value('16')
        expect(page.locator('#noteLabelSizeValue')).to_have_text('16 px')
        page.click('#settingsModalClose')
        page.reload()
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=trace]')
        expect(slider).to_have_value('16')

    def test_playback_and_fretboard_preferences(self):
        self.open_reference_project()
        page = self.page
        page.click("#settingsMenuBtn")
        expect(page.locator("#playbackScrollMode")).to_have_value("page")
        expect(page.locator("#fretboardStringOrder")).to_have_value("low-bottom")
        expect(page.locator("#fretboardAnimations")).to_be_checked()
        page.locator("input[name=playbackScrollMode][value=follow]").check()
        page.select_option("#fretboardStringOrder", "low-top")
        page.uncheck("#fretboardAnimations")
        page.click("#settingsModalClose")
        expect(page.locator("#playbackScrollMode")).to_have_value("page")
        expect(page.locator("#fretboardStringOrder")).to_have_value("low-bottom")
        expect(page.locator("#fretboardAnimations")).to_be_checked()
        page.click("#settingsMenuBtn")
        page.locator("input[name=playbackScrollMode][value=follow]").check()
        page.select_option("#fretboardStringOrder", "low-top")
        page.uncheck("#fretboardAnimations")
        self.apply_settings_and_close()
        # Exercise the actual transport reveal path.
        positions = page.evaluate("""async () => {
            const { seekPlayback, revealPlaybackPosition } = await import('/playback.js');
            const { stopViewportMotion, viewportMoving } = await import('/viewport-motion.js');
            stopViewportMotion();
            const { S } = await import('/store.js');
            const scroll = document.querySelector('#scroll');
            seekPlayback(12);
            scroll.scrollLeft = 0;
            revealPlaybackPosition();
            for (let i = 0; i < 120 && viewportMoving(); i++) await new Promise(requestAnimationFrame);
            const followed = scroll.scrollLeft;
            const expected = Math.min(scroll.scrollWidth - scroll.clientWidth, 12 * S.pxPerSec - 60);
            return { followed, expected };
        }""")
        self.assertAlmostEqual(positions["followed"], positions["expected"], delta=1)
        # Flip the real canvas: tuning labels stay readable and swap vertical order.
        labels = page.evaluate("""async () => {
            const { setFretboardVisible, drawFretboard } = await import('/fretboard.js');
            setFretboardVisible(true);
            await new Promise(requestAnimationFrame);
            const ctx = document.querySelector('#fretboard').getContext('2d');
            const original = ctx.fillText;
            const orders = [];
            try {
                for (const value of ['low-bottom', 'low-top']) {
                    document.querySelector('#fretboardStringOrder').value = value;
                    const texts = [];
                    ctx.fillText = function(text, x, y, ...args) {
                        if (/^[A-G]#?-?[0-9]$/.test(String(text))) texts.push({ text, y });
                        return original.call(this, text, x, y, ...args);
                    };
                    drawFretboard();
                    orders.push(texts);
                }
            } finally { ctx.fillText = original; }
            return orders;
        }""")
        self.assertGreaterEqual(len(labels[0]), 4)
        self.assertEqual([x["text"] for x in labels[0]], [x["text"] for x in labels[1]])
        self.assertLess(labels[0][0]["y"], labels[0][-1]["y"])
        self.assertGreater(labels[1][0]["y"], labels[1][-1]["y"])
        page.reload()
        expect(page.locator("#playbackScrollMode")).to_have_value("follow")
        expect(page.locator("#fretboardStringOrder")).to_have_value("low-top")
        expect(page.locator("#fretboardAnimations")).not_to_be_checked()

    def test_legacy_no_follow_preference_becomes_page(self):
        page = self.page
        page.evaluate("localStorage.setItem('cw.settings', JSON.stringify({playbackScrollMode:'off'}))")
        page.reload()
        expect(page.locator('#playbackScrollMode')).to_have_value('page')
        expect(page.locator('input[name=playbackScrollMode][value=page]')).to_be_checked()
        self.assertEqual(page.locator('input[name=playbackScrollMode]').count(), 2)
        self.assertEqual(page.evaluate("JSON.parse(localStorage.getItem('cw.settings')).playbackScrollMode"), 'page')

    def test_manual_scrolling_suspends_playback_follow_until_restart(self):
        self.open_reference_project()
        self.page.emulate_media(reduced_motion='reduce')
        results = self.page.evaluate("""async () => {
            const { playTransport, pauseTransport, seekPlayback, revealPlaybackPosition } = await import('/playback.js');
            const { stopViewportMotion, followViewportTo } = await import('/viewport-motion.js');
            const scroll = document.querySelector('#scroll');
            const { S } = await import('/store.js');
            const frame = () => new Promise(requestAnimationFrame);
            const results = [];
            for (const mode of ['page', 'follow']) for (const gesture of ['wheel', 'overview', 'scrollbar']) {
                pauseTransport(); stopViewportMotion();
                document.querySelector('#playbackScrollMode').value = mode;
                seekPlayback(12); scroll.scrollLeft = 0;
                await playTransport(); await frame(); await frame();
                const before = scroll.scrollLeft;
                if (gesture === 'wheel') {
                    scroll.dispatchEvent(new WheelEvent('wheel', {deltaY:-180, bubbles:true, cancelable:true}));
                } else if (gesture === 'overview') {
                    followViewportTo(100);
                } else {
                    const rect = scroll.getBoundingClientRect();
                    scroll.dispatchEvent(new PointerEvent('pointerdown', {clientX:rect.left+20, clientY:rect.top+scroll.clientHeight+1}));
                    scroll.scrollLeft = 100;
                }
                const manual = scroll.scrollLeft;
                seekPlayback(20); revealPlaybackPosition();
                await frame(); await frame();
                const held = scroll.scrollLeft;
                pauseTransport(); scroll.scrollLeft = 0;
                await playTransport(); await frame(); await frame();
                const resumed = scroll.scrollLeft;
                results.push({mode, gesture, before, manual, held, resumed});
            }
            pauseTransport();
            return results;
        }""")
        for result in results:
            self.assertGreater(result['before'], 100, result)
            self.assertNotEqual(result['before'], result['manual'], result)
            self.assertEqual(result['held'], result['manual'], result)
            self.assertGreater(result['resumed'], result['manual'] + 100, result)

    def test_playback_scrolling_resumes_after_two_seconds_with_playhead_in_frame(self):
        self.open_reference_project()
        self.page.emulate_media(reduced_motion='reduce')
        results = self.page.evaluate("""async () => {
            const { playTransport, pauseTransport, seekPlayback, playbackTime } = await import('/playback.js');
            const { manualViewportNavigation, stopViewportMotion } = await import('/viewport-motion.js');
            const { S } = await import('/store.js');
            const scroll = document.querySelector('#scroll'), audio = document.querySelector('#audio');
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const originalRate = audio.playbackRate, results = [];
            try {
                // Keep the playhead in the paging edge zone for the full idle
                // interval, so both Page and Follow have a visible resume.
                audio.playbackRate = .125;
                for (const mode of ['page', 'follow']) {
                    pauseTransport(); stopViewportMotion();
                    document.querySelector('#playbackScrollMode').value = mode;
                    seekPlayback(12); await playTransport();
                    manualViewportNavigation(); scroll.scrollLeft = 0;
                    await wait(2150);
                    const outside = scroll.scrollLeft;
                    manualViewportNavigation();
                    scroll.scrollLeft = playbackTime() * S.pxPerSec - scroll.clientWidth + 45;
                    const returned = scroll.scrollLeft;
                    await wait(1000);
                    const beforeTimeout = scroll.scrollLeft;
                    // More movement restarts the complete two-second window.
                    scroll.scrollLeft += 30;
                    const moved = scroll.scrollLeft;
                    await wait(1300);
                    const afterMovement = scroll.scrollLeft;
                    await wait(1050);
                    const resumed = scroll.scrollLeft;
                    results.push({mode, outside, returned, beforeTimeout, moved, afterMovement, resumed});
                }
            } finally { pauseTransport(); audio.playbackRate = originalRate; }
            return results;
        }""")
        for result in results:
            self.assertEqual(result['outside'], 0, result)
            self.assertEqual(result['beforeTimeout'], result['returned'], result)
            self.assertEqual(result['afterMovement'], result['moved'], result)
            self.assertGreater(result['resumed'], result['moved'] + 100, result)

    def test_playback_follow_eases_and_retargets(self):
        self.open_reference_project()
        result = self.page.evaluate("""async () => {
            const { seekPlayback, revealPlaybackPosition } = await import('/playback.js');
            const { stopViewportMotion, viewportMoving } = await import('/viewport-motion.js');
            const { S } = await import('/store.js');
            const scroll = document.querySelector('#scroll');
            const mode = document.querySelector('#playbackScrollMode');
            const frame = () => new Promise(requestAnimationFrame);
            const target = t => Math.min(scroll.scrollWidth - scroll.clientWidth, t * S.pxPerSec - 60);
            stopViewportMotion(); scroll.scrollLeft = 0;
            mode.value = 'follow';
            seekPlayback(8); revealPlaybackPosition();
            const immediate = scroll.scrollLeft;
            await frame(); await frame(); revealPlaybackPosition();
            const catchingUp = scroll.scrollLeft;
            // Seek again during the ease: it must update the destination, not wait
            // for the old destination or snap straight to the new one.
            seekPlayback(16); revealPlaybackPosition();
            const retargeted = scroll.scrollLeft;
            const samples = [];
            for (let i = 0; i < 8; i++) {
                await frame(); revealPlaybackPosition(); samples.push(scroll.scrollLeft);
            }
            for (let i = 0; i < 120 && viewportMoving(); i++) await frame();
            const settled = scroll.scrollLeft;
            seekPlayback(4); revealPlaybackPosition();
            await frame(); await frame();
            stopViewportMotion();
            const stopped = scroll.scrollLeft;
            await frame(); await frame();
            return { immediate, catchingUp, retargeted, samples, settled, target: target(16),
                firstTarget: target(8), stopped, afterStop: scroll.scrollLeft, moving: viewportMoving() };
        }""")
        self.assertEqual(result["immediate"], 0)
        self.assertGreater(result["catchingUp"], 0)
        self.assertLess(result["catchingUp"], result["firstTarget"])
        self.assertEqual(result["retargeted"], result["catchingUp"])
        self.assertGreater(result["samples"][-1], result["firstTarget"])
        self.assertTrue(all(a <= b for a, b in zip(result["samples"], result["samples"][1:])))
        self.assertAlmostEqual(result["settled"], result["target"], delta=1)
        self.assertEqual(result["stopped"], result["afterStop"])
        self.assertFalse(result["moving"])

    def test_playback_follow_locks_after_catchup(self):
        self.open_reference_project()
        result = self.page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { seekPlayback, revealPlaybackPosition } = await import('/playback.js');
            const { stopViewportMotion, viewportMoving } = await import('/viewport-motion.js');
            const scroll = document.querySelector('#scroll');
            document.querySelector('#playbackScrollMode').value = 'follow';
            stopViewportMotion(); scroll.scrollLeft = 0;
            seekPlayback(8); revealPlaybackPosition();
            const immediate = scroll.scrollLeft;
            const samples = [];
            for (let i = 0; i < 40; i++) {
                await new Promise(requestAnimationFrame);
                // Advance the clock without seeking: ordinary continuous playback.
                S.scoreTime = 8 + i / 60;
                revealPlaybackPosition();
                const expected = Math.min(scroll.scrollWidth - scroll.clientWidth, S.scoreTime * S.pxPerSec - 60);
                samples.push({ error: Math.abs(scroll.scrollLeft - expected), moving: viewportMoving() });
            }
            seekPlayback(16); revealPlaybackPosition();
            const seekEases = viewportMoving();
            for (let i = 0; i < 120 && viewportMoving(); i++) await new Promise(requestAnimationFrame);
            scroll.scrollLeft = 0;
            revealPlaybackPosition();
            const manualEases = viewportMoving();
            stopViewportMotion();
            return { immediate, samples, seekEases, manualEases };
        }""")
        self.assertEqual(result["immediate"], 0)
        for sample in result["samples"][-10:]:
            self.assertLessEqual(sample["error"], 0.5, "locked following has no easing lag")
            self.assertFalse(sample["moving"], "easing stays off once caught up")
        self.assertTrue(result["seekEases"])
        self.assertTrue(result["manualEases"])

    def test_artifact_previews_fit_when_sidebar_shrinks(self):
        self.open_reference_project()
        page = self.page
        page.emulate_media(reduced_motion="reduce")
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { markMotif } = await import('/motifs.js');
            markMotif(S.state.editLanes[0].notes.filter(n => n.start >= 8 && n.start < 12), 'motif_v2_1');
            (await import('/artifacts.js')).renderArtifacts();
        }""")
        expect(page.locator('#motifList .artifact-preview')).to_have_count(1)
        panel = page.locator('#artifactsPanel')
        for width in [400, 280, 260, 240, 220, 300]:
            grip = page.locator('#artifactsResize').bounding_box()
            x, y = grip['x'] + grip['width'] / 2, grip['y'] + grip['height'] / 2
            current = panel.bounding_box()['width']
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + current - width, y, steps=5)
            page.mouse.up()
            bounds = page.locator('.artifact-preview').evaluate_all("""previews => previews.map(preview => {
                const row = preview.closest('.artifact-row').getBoundingClientRect();
                const stage = preview.querySelector('.artifact-preview-stage').getBoundingClientRect();
                const canvas = preview.querySelector('canvas').getBoundingClientRect();
                const footer = preview.querySelector('.artifact-preview-footer').getBoundingClientRect();
                const move = preview.querySelector('.artifact-jump').getBoundingClientRect();
                return { rowLeft: row.left, rowRight: row.right, stageRight: stage.right,
                    canvasLeft: canvas.left, canvasRight: canvas.right, footerRight: footer.right,
                    moveRight: move.right, canvasWidth: canvas.width };
            })""")
            self.assertEqual(len(bounds), 3)
            for box in bounds:
                self.assertGreater(box['canvasWidth'], 0)
                self.assertGreaterEqual(box['canvasLeft'], box['rowLeft'])
                for key in ['stageRight', 'canvasRight', 'footerRight', 'moveRight']:
                    self.assertLessEqual(box[key], box['rowRight'], f'{key} overflows at sidebar width {width}')

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
        first.locator('.artifact-preview-play').click()
        expect(first.locator('.artifact-preview')).to_have_attribute('data-playing', '')
        second.locator('.artifact-preview-play').click()
        expect(first.locator('.artifact-preview')).not_to_have_attribute('data-playing', '')
        expect(second.locator('.artifact-preview')).to_have_attribute('data-playing', '')
        first.locator('.artifact-instance-previous').click()
        expect(first.locator('.artifact-preview')).to_have_attribute('data-instance', '1')
        second.locator('.artifact-preview-play').click()
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
        page.evaluate("() => { window.artifactWindow = document.querySelector('.artifact-preview'); }")
        # Hovering never plays; the play button starts and stops it.
        preview.hover()
        page.wait_for_timeout(700)
        expect(preview).not_to_have_attribute('data-playing', '')
        play = first.locator('.artifact-preview-play')
        play.click()
        expect(preview).to_have_attribute('data-playing', '')
        expect(play).to_have_attribute('aria-pressed', 'true')
        play.click()
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
        preview.locator('.artifact-preview-play').click()
        expect(preview).to_have_attribute('data-playing', '')
        expect(preview).not_to_have_attribute('data-playing', '', timeout=10000)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.scoreTime"), 0)
        expect(page.locator('.toast')).to_have_count(0)
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
        page.locator('.artifact-preview-play').first.click()
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
        page.locator('.artifact-preview-play').first.click()
        page.wait_for_function("window.referenceAudio.some(e => e.type === 'playing')")
        expect(page.locator('.artifact-preview').first).not_to_have_attribute('data-playing', '')
        events = page.evaluate('window.referenceAudio')
        self.assertAlmostEqual(events[0]['time'], 16, delta=0.2)
        self.assertEqual(page.locator('#audio').evaluate('el => el.currentTime'), 0)

    def test_reference_rename_and_corner_resize(self):
        self.open_reference_project()
        page = self.page
        row = page.locator('.artifact-row[data-reference="1"]')
        # Rename from the artifact row; Undo restores the numbered name.
        row.locator('.artifact-name').dblclick()
        page.locator('.artifact-rename').fill('Intro riff')
        page.keyboard.press('Enter')
        expect(row.locator('.artifact-name')).to_have_text('Intro riff')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].refBoxes[1].name"), 'Intro riff')
        page.keyboard.press('Control+z')
        expect(row.locator('.artifact-name')).to_have_text('Reference #1')
        # Where the first box's label and bottom-right corner are, in client px.
        where = """async () => {
            const { S } = await import('/store.js');
            const r = document.querySelector('#stage').getBoundingClientRect(), sc = document.querySelector('#scroll');
            const at = (x, y) => [x - sc.scrollLeft + r.left, y - sc.scrollTop + r.top];
            const b = S.refBoxRects.find(b => b.ref === 1 && b.i === 0), l = S.refBadges.find(b => b.ref === 1 && b.i === 0);
            return { label: at(l.x + l.w / 2, l.y + l.h / 2), corner: at(b.x1, b.y1) };
        }"""
        spots = page.evaluate(where)
        # Rename on the stage by double-clicking the label.
        page.mouse.dblclick(*spots['label'])
        page.locator('.artifact-rename').fill('Hook')
        page.keyboard.press('Enter')
        expect(row.locator('.artifact-name')).to_have_text('Hook')
        # The corner shows a diagonal cursor and resizes time and pitch at once.
        page.mouse.move(*spots['corner'])
        expect(page.locator('#stage')).to_have_css('cursor', 'nwse-resize')
        before = page.evaluate("async () => { const g = (await import('/store.js')).S.state.editLanes[0].refBoxes[1]; return [g.rt1, g.pLo]; }")
        page.mouse.down()
        page.mouse.move(spots['corner'][0] + 80, spots['corner'][1] + 40, steps=5)
        page.mouse.up()
        after = page.evaluate("async () => { const g = (await import('/store.js')).S.state.editLanes[0].refBoxes[1]; return [g.rt1, g.pLo]; }")
        self.assertGreater(after[0], before[0])
        self.assertLess(after[1], before[1])

    def test_reference_double_click_moves_and_drag_places_an_occurrence(self):
        self.open_reference_project()
        page = self.page
        anchors = "async () => (await import('/store.js')).S.state.editLanes[0].refBoxes[1].anchors"
        row = page.locator('.artifact-row[data-reference="1"]')
        # Double-clicking the entry moves there, like Move to.
        row.locator('.artifact-preview-canvas').dblclick()
        page.wait_for_timeout(300)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.scoreTime"), 2)
        # Dropping it on the spectrogram adds a linked occurrence where it lands.
        page.evaluate("""async () => {
            const { xOf } = await import('/geometry.js');
            const scroll = document.querySelector('#scroll'), r = scroll.getBoundingClientRect();
            const at = { clientX: r.left + xOf(12) - scroll.scrollLeft, clientY: r.top + r.height / 2 };
            const dataTransfer = new DataTransfer();
            const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
            const row = document.querySelector('.artifact-row[data-reference="1"]');
            fire(row, 'dragstart'); fire(scroll, 'dragover', at);
            window.dropDrag = { fire, row, scroll, at };
        }""")
        # While dragging, the stage previews exactly where the notes will land.
        preview = page.evaluate("async () => (await import('/store.js')).S.dropPreview.notes.map(n => [n.start, n.pitch])")
        self.assertEqual(len(preview), 6)
        self.assertAlmostEqual(min(start for start, _ in preview), 12, delta=0.6)
        page.evaluate("() => { const { fire, row, scroll, at } = window.dropDrag; fire(scroll, 'drop', at); fire(row, 'dragend'); }")
        self.assertIsNone(page.evaluate("async () => (await import('/store.js')).S.dropPreview"))
        expect(row.locator('.artifact-preview-title')).to_contain_text('/ 3')
        landed = page.evaluate("""async () => (await import('/store.js')).S.selection.size
            && [...(await import('/store.js')).S.selection].map(n => [n.start, n.pitch])""")
        self.assertEqual(sorted(landed), sorted(preview))
        self.assertTrue(any(abs(a - 12) < 0.6 for a in page.evaluate(anchors)), page.evaluate(anchors))
        page.keyboard.press('Control+z')
        expect(row.locator('.artifact-preview-title')).to_contain_text('/ 2')

    def test_reference_pitch_can_be_freed_and_locked_again(self):
        self.open_reference_project()
        page = self.page
        group = "async () => JSON.parse(JSON.stringify((await import('/store.js')).S.state.editLanes[0].refBoxes[1]))"
        inside = """async (t0) => (await import('/store.js')).S.state.editLanes[0].notes
            .filter(n => n.start >= t0 - 0.01 && n.start < t0 + 3).sort((a, b) => a.start - b.start).map(n => n.pitch)"""
        row = page.locator('.artifact-row[data-reference="1"]')
        menu = page.locator('.ctxmenu')
        base = page.evaluate(inside, 2)
        # Locked by default: the menu offers to free it.
        row.locator('.artifact-preview').click(button='right')
        menu.get_by_text('Allow transposition', exact=True).click()
        self.assertTrue(page.evaluate(group)['transposable'])
        # Drop a copy at 0:12, two semitones above the first note.
        page.evaluate("""async (pitch) => {
            const { xOf, yOf } = await import('/geometry.js');
            const { S } = await import('/store.js');
            const scroll = document.querySelector('#scroll'), r = scroll.getBoundingClientRect();
            const at = { clientX: r.left + xOf(12) - scroll.scrollLeft + 2,
                clientY: r.top + yOf(pitch) + S.state.rowH / 2 - scroll.scrollTop };
            const dataTransfer = new DataTransfer();
            const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
            const row = document.querySelector('.artifact-row[data-reference="1"]');
            fire(row, 'dragstart'); fire(scroll, 'dragover', at); fire(scroll, 'drop', at); fire(row, 'dragend');
        }""", base[0] + 2)
        expect(row.locator('.artifact-preview-title')).to_contain_text('/ 3')
        g = page.evaluate(group)
        self.assertEqual(len(g['anchors']), 3)
        self.assertEqual(g['shifts'][2], 2)
        self.assertEqual(page.evaluate(inside, 12), [p + 2 for p in base])
        # An edit in the first occurrence mirrors into the shifted one, relative to its pitch.
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { snapshotEdit, commit } = await import('/edit.js');
            const lane = S.state.editLanes[0], prev = snapshotEdit();
            const first = lane.notes.filter(n => n.start >= 1.99 && n.start < 5).sort((a, b) => a.start - b.start)[1];
            first.pitch += 1;
            commit(prev);
        }""")
        edited = page.evaluate(inside, 2)
        self.assertEqual(page.evaluate(inside, 12), [p + 2 for p in edited])
        self.assertEqual(page.evaluate(inside, 16), edited)
        # Locking again asks; Move back returns the copy to the first's pitch.
        row.locator('.artifact-preview').click(button='right')
        menu.get_by_text('Use the same pitch', exact=True).click()
        expect(page.locator('#actionConfirmModal')).to_be_visible()
        page.locator('#actionConfirmAccept').click()
        self.assertEqual(page.evaluate(inside, 12), edited)
        g = page.evaluate(group)
        self.assertNotIn('shifts', g)
        self.assertNotIn('transposable', g)
        # Undo, then lock again and detach the shifted copy instead.
        page.keyboard.press('Control+z')
        self.assertEqual(page.evaluate(inside, 12), [p + 2 for p in edited])
        row.locator('.artifact-preview').click(button='right')
        menu.get_by_text('Use the same pitch', exact=True).click()
        page.locator('#actionConfirmDiscard').click()
        self.assertEqual(len(page.evaluate(group)['anchors']), 2)
        self.assertEqual(page.evaluate(inside, 12), [p + 2 for p in edited])

    def test_reference_label_drag_moves_in_pitch_only_when_freed(self):
        self.open_reference_project()
        page = self.page
        shifts = "async () => (await import('/store.js')).S.state.editLanes[0].refBoxes[1].shifts || []"
        label = """async () => {
            const { S } = await import('/store.js');
            const r = document.querySelector('#stage').getBoundingClientRect(), sc = document.querySelector('#scroll');
            const l = S.refBadges.find(b => b.ref === 1 && b.i === 0);
            return [l.x + l.w / 2 - sc.scrollLeft + r.left, l.y + l.h / 2 - sc.scrollTop + r.top, S.state.rowH];
        }"""
        def drag_up(rows):
            x, y, row_h = page.evaluate(label)
            page.mouse.move(x, y); page.mouse.down()
            page.mouse.move(x, y - rows * row_h, steps=5); page.mouse.up()
        # Locked: dragging up changes nothing in pitch.
        drag_up(3)
        self.assertEqual(page.evaluate(shifts), [])
        page.keyboard.press('Control+z')
        page.locator('.artifact-row[data-reference="1"] .artifact-preview').click(button='right')
        page.locator('.ctxmenu').get_by_text('Allow transposition', exact=True).click()
        drag_up(3)
        self.assertEqual(page.evaluate(shifts)[0], 3)
        expect(page.locator('.artifact-row[data-reference="1"] .artifact-preview-title')).to_contain_text('+3')

    def test_references_never_land_inside_another_reference(self):
        self.open_reference_project()
        page = self.page
        anchors = "async () => (await import('/store.js')).S.state.editLanes[0].refBoxes[1].anchors"
        # Dropping Reference #1 over its own second occurrence (0:16) is refused,
        # and the preview says so while dragging.
        blocked = page.evaluate("""async () => {
            const { xOf, yOf } = await import('/geometry.js');
            const { S } = await import('/store.js');
            const scroll = document.querySelector('#scroll'), r = scroll.getBoundingClientRect();
            const at = { clientX: r.left + xOf(17) - scroll.scrollLeft + 2, clientY: r.top + 100 };
            const dataTransfer = new DataTransfer();
            const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
            const row = document.querySelector('.artifact-row[data-reference="1"]');
            fire(row, 'dragstart'); fire(scroll, 'dragover', at);
            const blocked = S.dropPreview.blocked;
            fire(scroll, 'drop', at); fire(row, 'dragend');
            return blocked;
        }""")
        self.assertTrue(blocked)
        self.assertEqual(page.evaluate(anchors), [2, 16])
        expect(page.locator('.toast').filter(has_text='inside another reference')).to_be_visible()
        # Dragging an occurrence's label into the other one stops at its last free spot.
        x, y, px = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { zoomCenter } = await import('/geometry.js');
            zoomCenter('x', 0.3); document.querySelector('#scroll').scrollLeft = 0;
            (await import('/repaint.js')).drawNow();
            const r = document.querySelector('#stage').getBoundingClientRect(), sc = document.querySelector('#scroll');
            const l = S.refBadges.find(b => b.ref === 1 && b.i === 0);
            const { xOf } = await import('/geometry.js');
            return [l.x + l.w / 2 - sc.scrollLeft + r.left, l.y + l.h / 2 - sc.scrollTop + r.top, xOf(1) - xOf(0)];
        }""")
        page.mouse.move(x, y); page.mouse.down()
        page.mouse.move(x + 14.5 * px, y, steps=20); page.mouse.up()
        first, second = sorted(page.evaluate(anchors))
        self.assertEqual(second, 16)
        self.assertLessEqual(first, 13 + 1e-6)

    def test_reference_edit_lock_protects_content_and_survives_reload(self):
        self.open_reference_project()
        page = self.page
        row = page.locator('.artifact-row[data-reference="1"]')
        lock = row.get_by_role('button', name='Lock reference', exact=True)
        transpose = row.get_by_role('button', name='Transposable', exact=True)
        expect(lock).to_have_attribute('aria-pressed', 'false')
        lock.click()
        expect(lock).to_have_attribute('aria-pressed', 'true')
        expect(transpose).to_be_disabled()
        expect(row).to_have_attribute('draggable', 'false')
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('Control+z')
        expect(lock).to_have_attribute('aria-pressed', 'false')
        page.keyboard.press('Control+Shift+z')
        expect(lock).to_have_attribute('aria-pressed', 'true')
        # Destructive actions are visibly unavailable, while Copy remains useful.
        row.locator('.artifact-preview').click(button='right')
        menu = page.locator('.ctxmenu')
        expect(menu.get_by_text('Delete entire reference', exact=True)).to_be_disabled()
        expect(menu.get_by_text('Allow transposition', exact=True)).to_be_disabled()
        expect(menu.get_by_text('Copy', exact=True)).to_be_enabled()
        page.keyboard.press('Escape')
        # The commit boundary protects keyboard edits, effects, insertion and
        # reference geometry, even if a caller bypasses the disabled controls.
        checks = page.evaluate("""async () => {
            const { S, setSelection } = await import('/store.js');
            const { snapshotEdit, commit, doDelete } = await import('/edit.js');
            const refs = await import('/references.js');
            const lane = () => S.state.editLanes[0];
            const group = () => lane().refBoxes[1];
            const signature = () => JSON.stringify({ notes: lane().notes, group: group() });
            const before = signature(), undo = S.undoStack.length;
            const protectedNotes = () => refs.notesInBox(refs.occurrenceBox(group(), 0, refs.laneClock(lane())), lane().notes);
            const results = [];
            setSelection(new Set(protectedNotes())); doDelete(); results.push(signature() === before);
            let prev = snapshotEdit();
            protectedNotes()[0].pitch += 1; commit(prev); results.push(signature() === before);
            prev = snapshotEdit();
            const n = protectedNotes()[0]; n.fx ||= {}; n.fx.vibrato = true;
            commit(prev); results.push(signature() === before);
            prev = snapshotEdit();
            lane().notes.push({ ...protectedNotes()[0], id: 'locked-insertion' });
            commit(prev); results.push(signature() === before);
            prev = snapshotEdit();
            group().anchors[0] += 1; commit(prev); results.push(signature() === before);
            refs.moveRefOccurrence({lane: lane(), ref: 1}, 0, 0);
            refs.resizeRefBox({lane: lane(), ref: 1}, 0, 0);
            refs.deleteRefGroup(lane(), 1); refs.detachRefGroup(lane(), 1);
            await refs.setRefPitchLock(lane(), 1, false);
            results.push(signature() === before);
            const undoUnchanged = S.undoStack.length === undo;
            // Other references and notes remain editable in the same layer.
            prev = snapshotEdit();
            const outside = lane().notes.find(n => n.start >= 8 && n.start < 9);
            const outsideId = outside.id, oldPitch = outside.pitch;
            outside.pitch += 1; commit(prev);
            const unrelatedAllowed = lane().notes.find(n => n.id === outsideId)?.pitch === oldPitch + 1;
            return { results, undoUnchanged, unrelatedAllowed };
        }""")
        self.assertTrue(all(checks['results']), checks)
        self.assertTrue(checks['undoUnchanged'])
        self.assertTrue(checks['unrelatedAllowed'])
        # A note drag on the real canvas must not even start moving the note.
        point = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { xOf, yOf } = await import('/geometry.js');
            const n = S.state.editLanes[0].notes.find(n => n.start >= 2 && n.start < 3);
            const rect = document.querySelector('#stage').getBoundingClientRect(), sc = document.querySelector('#scroll');
            window.lockedNoteSignature = JSON.stringify(S.state.editLanes[0].notes);
            return [rect.left + xOf((n.start + n.end) / 2) - sc.scrollLeft,
                rect.top + yOf(n.pitch) + S.state.rowH / 2 - sc.scrollTop];
        }""")
        page.mouse.move(*point); page.mouse.down()
        page.mouse.move(point[0] + 80, point[1] - 15, steps=5); page.mouse.up()
        self.assertTrue(page.evaluate("async () => JSON.stringify((await import('/store.js')).S.state.editLanes[0].notes) === window.lockedNoteSignature"))
        page.evaluate("async () => { const p = await import('/project.js'); await p.saveToServer(); p.markSaved(); }")
        page.reload()
        page.locator(f'#recentList [data-job="{self.reference_job}"] .ri-open').click()
        expect(lock).to_have_attribute('aria-pressed', 'true')
        expect(transpose).to_be_disabled()
        lock.click()
        expect(lock).to_have_attribute('aria-pressed', 'false')
        expect(transpose).to_be_enabled()
        transpose.click()
        expect(transpose).to_have_attribute('aria-pressed', 'true')
        self.assertTrue(page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { snapshotEdit, commit } = await import('/edit.js');
            const prev = snapshotEdit(), lane = S.state.editLanes[0];
            const note = lane.notes.find(n => n.start >= 2 && n.start < 3), pitch = note.pitch;
            note.pitch += 1; commit(prev);
            return S.state.editLanes[0].notes.find(n => n.id === note.id)?.pitch === pitch + 1;
        }"""))

    def test_reference_edit_lock_on_timeline(self):
        self.open_reference_project()
        page = self.page
        x, y = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const r = document.querySelector('#stage').getBoundingClientRect(), sc = document.querySelector('#scroll');
            const l = S.refLocks.find(b => b.ref === 1 && b.i === 0 && b.kind === 'edit');
            return [l.x + l.w / 2 - sc.scrollLeft + r.left, l.y + l.h / 2 - sc.scrollTop + r.top];
        }""")
        lock = page.locator('.artifact-row[data-reference="1"] .artifact-edit-lock')
        page.mouse.click(x, y)
        expect(lock).to_have_attribute('aria-pressed', 'true')
        page.mouse.click(x, y)
        expect(lock).to_have_attribute('aria-pressed', 'false')

    def test_reference_transpose_toggle_describes_pitch_without_a_padlock(self):
        self.open_reference_project()
        page = self.page
        row = page.locator('.artifact-row[data-reference="1"]')
        toggle = row.get_by_role('button', name='Transposable', exact=True)
        expect(toggle).to_have_attribute('aria-pressed', 'false')
        expect(toggle).to_have_attribute('title', re.compile('Same pitch for all instances'))
        expect(toggle.locator('svg ellipse')).to_have_count(1)
        expect(toggle.locator('svg rect')).to_have_count(0)
        toggle.click()
        expect(toggle).to_have_attribute('aria-pressed', 'true')
        expect(toggle).to_have_attribute('title', re.compile('transposed independently'))
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('Control+z')
        expect(toggle).to_have_attribute('aria-pressed', 'false')
        page.keyboard.press('Control+Shift+z')
        expect(toggle).to_have_attribute('aria-pressed', 'true')
        toggle.click()
        expect(toggle).to_have_attribute('aria-pressed', 'false')

    def test_reference_transpose_on_the_stage_flips_transposability(self):
        self.open_reference_project()
        page = self.page
        free = "async () => !!(await import('/store.js')).S.state.editLanes[0].refBoxes[1].transposable"
        x, y = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const r = document.querySelector('#stage').getBoundingClientRect(), sc = document.querySelector('#scroll');
            const box = S.refBoxRects.find(b => b.ref === 1 && b.i === 0), l = S.refLocks.find(b => b.ref === 1 && b.i === 0);
            if (l.x + l.w < box.x1 - 24) throw new Error('the transposition icon is not at the right end of its box');
            return [l.x + l.w / 2 - sc.scrollLeft + r.left, l.y + l.h / 2 - sc.scrollTop + r.top];
        }""")
        page.mouse.move(x, y)
        expect(page.locator('#stage')).to_have_css('cursor', 'pointer')
        page.mouse.click(x, y)
        page.wait_for_function("() => document.querySelector('.artifact-transpose').getAttribute('aria-pressed') === 'true'")
        self.assertTrue(page.evaluate(free))
        page.mouse.click(x, y)   # nothing is shifted, so locking needs no question
        page.wait_for_function("() => document.querySelector('.artifact-transpose').getAttribute('aria-pressed') === 'false'")
        self.assertFalse(page.evaluate(free))

    def test_reference_keeps_its_rhythm_under_another_tempo(self):
        self.open_reference_project()
        page = self.page
        # 120 BPM up to 0:20, then 240: after the marker a beat is half as long.
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            S.state.tempoMap = [{ t: 20, bpm: 240, tsNum: 4, tsDen: 4, subdiv: 2 }];
            (await import('/repaint.js')).draw();
        }""")
        starts = """async (t0) => (await import('/store.js')).S.state.editLanes[0].notes
            .filter(n => n.start >= t0 - 0.01 && n.start < t0 + 3).sort((a, b) => a.start - b.start).map(n => [n.start, n.end])"""
        source = page.evaluate(starts, 2)
        # Drop Reference #1 at 0:20.5, under the faster tempo.
        page.evaluate("""async () => {
            const { xOf } = await import('/geometry.js');
            const scroll = document.querySelector('#scroll'), r = scroll.getBoundingClientRect();
            const at = { clientX: r.left + xOf(20.5) - scroll.scrollLeft + 2, clientY: r.top + 100 };
            const dataTransfer = new DataTransfer();
            const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
            const row = document.querySelector('.artifact-row[data-reference="1"]');
            fire(row, 'dragstart'); fire(scroll, 'dragover', at); fire(scroll, 'drop', at); fire(row, 'dragend');
        }""")
        expect(page.locator('.artifact-row[data-reference="1"] .artifact-preview-title')).to_contain_text('/ 3')
        copy = page.evaluate(starts, 20.5)
        self.assertEqual(len(copy), len(source))
        # Every onset and length is halved: the same beats at twice the tempo.
        for (s0, e0), (s1, e1) in zip(source, copy):
            self.assertAlmostEqual(s1 - copy[0][0], (s0 - source[0][0]) / 2, places=6)
            self.assertAlmostEqual(e1 - s1, (e0 - s0) / 2, places=6)
        # The box on the stage is half as long there too.
        widths = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { laneClock, occurrenceBox } = await import('/references.js');
            const lane = S.state.editLanes[0], group = lane.refBoxes[1], clock = laneClock(lane);
            return group.anchors.map((a, i) => [a, occurrenceBox(group, i, clock)]).sort((p, q) => p[0] - q[0]).map(([, b]) => b.t1 - b.t0);
        }""")
        self.assertAlmostEqual(widths[-1], widths[0] / 2, places=6)
        # An edit in the first occurrence mirrors into the copy in beats, not seconds.
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const { snapshotEdit, commit } = await import('/edit.js');
            const lane = S.state.editLanes[0], prev = snapshotEdit();
            const note = lane.notes.filter(n => n.start >= 1.99 && n.start < 5).sort((a, b) => a.start - b.start)[1];
            note.end = note.start + 0.25;   // half a beat at 120
            commit(prev);
        }""")
        copy = page.evaluate(starts, 20.5)
        self.assertAlmostEqual(copy[1][1] - copy[1][0], 0.125, places=6)
        # A motif dropped there keeps its rhythm in beats as well.
        page.evaluate("""async () => {
            const { S } = await import('/store.js');
            const lane = S.state.editLanes[0];
            const notes = lane.notes.filter(n => n.start >= 8 && n.start < 9.9).sort((a, b) => a.start - b.start);
            (await import('/motifs.js')).markMotif(notes, (await import('/ids.js')).motifId());
            (await import('/repaint.js')).draw();
        }""")
        motif = [n for n in page.evaluate(starts, 8) if n[0] < 9.9]   # the marked notes
        page.evaluate("""async () => {
            const { xOf } = await import('/geometry.js');
            const scroll = document.querySelector('#scroll'), r = scroll.getBoundingClientRect();
            const at = { clientX: r.left + xOf(22.5) - scroll.scrollLeft + 2, clientY: r.top + 100 };
            const dataTransfer = new DataTransfer();
            const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
            const row = document.querySelector('#motifList .artifact-row');
            fire(row, 'dragstart'); fire(scroll, 'dragover', at); fire(scroll, 'drop', at); fire(row, 'dragend');
        }""")
        expect(page.locator('#motifList .artifact-row')).to_have_count(2)
        dropped = sorted(page.evaluate("""async () => [...(await import('/store.js')).S.selection].map(n => n.start)"""))
        self.assertAlmostEqual(dropped[-1] - dropped[0], (motif[-1][0] - motif[0][0]) / 2, places=6)

    def test_motif_drop_keeps_its_intervals_at_the_pointers_pitch(self):
        self.open_reference_project()
        page = self.page
        original = page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const lane = S.state.editLanes[0];
            const notes = [...lane.notes].sort((a, b) => a.start - b.start).slice(0, 3);
            (await import('/motifs.js')).markMotif(notes, (await import('/ids.js')).motifId());
            (await import('/repaint.js')).draw();
            return notes.map(n => n.pitch);
        }""")
        row = page.locator('#motifList .artifact-row')
        expect(row).to_have_count(1)
        # Drag it to 0:13 (clear of any reference box), three semitones above its first note.
        page.evaluate("""async (pitch) => {
            const { xOf, yOf } = await import('/geometry.js');
            const { S } = await import('/store.js');
            const scroll = document.querySelector('#scroll'), r = scroll.getBoundingClientRect();
            const at = { clientX: r.left + xOf(13) - scroll.scrollLeft + 2,
                clientY: r.top + yOf(pitch) + S.state.rowH / 2 - scroll.scrollTop };
            const dataTransfer = new DataTransfer();
            const fire = (el, type, extra = {}) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...extra }));
            const row = document.querySelector('#motifList .artifact-row');
            fire(row, 'dragstart'); fire(scroll, 'dragover', at); fire(scroll, 'drop', at); fire(row, 'dragend');
        }""", original[0] + 3)
        expect(row).to_have_count(2)
        placed = page.evaluate("""async () => [...(await import('/store.js')).S.selection]
            .sort((a, b) => a.start - b.start).map(n => [n.start, n.pitch, n.pos ?? null])""")
        self.assertAlmostEqual(placed[0][0], 13, delta=0.3)
        self.assertEqual([p for _, p, _ in placed], [p + 3 for p in original])
        self.assertTrue(all(pos is None for _, _, pos in placed))

    def test_motifs_are_only_note_labels_and_live_artifacts(self):
        self.open_reference_project()
        page = self.page
        # Two non-adjacent notes: the unmarked note between them is not a member.
        page.evaluate("""async () => {
            const {S, setSelection} = await import('/store.js');
            const notes = S.state.editLanes[0].notes;
            window.motifMusicBefore = JSON.stringify(notes);
            setSelection(new Set(notes.filter(n => n.start === 8 || n.start === 9)));
            (await import('/edit.js')).openNoteMenu(600, 300);
        }""")
        page.locator('.ctxmenu').get_by_text('Mark as motif', exact=True).click()
        expect(page.locator('#motifList .artifact-row')).to_have_count(1)
        motif = page.locator('#motifList .artifact-row').first
        expect(motif.locator('canvas')).to_have_attribute('aria-label', 'Motif #1, instance 1 in Guitar motif, 2 notes')
        self.assertTrue(page.evaluate("""async () => {
            const {S} = await import('/store.js');
            return JSON.stringify(S.state.editLanes[0].notes.map(({motifId, ...note}) => note)) === window.motifMusicBefore;
        }"""))
        motif.locator('.artifact-jump').click()
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.selection.size"), 2)
        motif.click(button='right')
        page.locator('.ctxmenu').get_by_text('Copy', exact=True).click()
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.clipboard.length"), 2)
        # A copy receives its own marking and neither motif constrains fingering.
        page.evaluate("""async () => {
            (await import('/playback.js')).seekPlayback(20);
            await (await import('/edit.js')).doPaste({mode:'copy'});
        }""")
        expect(page.locator('#motifList .artifact-row')).to_have_count(2)
        expect(page.locator('#motifList .artifact-name')).to_have_text(['Motif #1', 'Motif #2'])
        page.evaluate("""async () => {
            const {S, setSelection} = await import('/store.js');
            const lane = S.state.editLanes[0], note = lane.notes.find(n => n.start === 8);
            const {snapshotEdit, commit, doDelete} = await import('/edit.js');
            const prev = snapshotEdit();
            (await import('/lanes.js')).setLaneNotePitch(lane, note, 66);
            commit(prev);
            window.tagAfterPitchEdit = note.motifId;
            setSelection(new Set([note])); doDelete();
        }""")
        self.assertTrue(page.evaluate('!!window.tagAfterPitchEdit'))
        expect(motif.locator('canvas')).to_have_attribute('aria-label', re.compile(r', 1 notes$'))
        page.keyboard.press('Control+z')
        expect(motif.locator('canvas')).to_have_attribute('aria-label', re.compile(r', 2 notes$'))
        page.evaluate("async () => { const p = await import('/project.js'); await p.saveToServer(); p.markSaved(); }")
        page.reload()
        page.locator(f'#recentList [data-job="{self.reference_job}"] .ri-open').click()
        expect(page.locator('#motifList .artifact-row')).to_have_count(2)
        expect(page.locator('#motifList .artifact-name')).to_have_text(['Motif #1', 'Motif #2'])
        page.locator('#artifactMotifsToggle').click()
        expect(page.locator('#artifactMotifsBody')).to_be_hidden()
        page.locator('#artifactMotifsToggle').click()
        page.locator('#motifList .artifact-row').first.click(button='right')
        before = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.length")
        page.locator('.ctxmenu').get_by_text('Unmark motif (keep notes)', exact=True).click()
        expect(page.locator('#motifList .artifact-row')).to_have_count(1)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.length"), before)
        page.keyboard.press('Control+z')
        expect(page.locator('#motifList .artifact-row')).to_have_count(2)
        # A linked reference's sibling notes are not silently marked as a motif.
        page.evaluate("""async () => {
            const {S, setSelection} = await import('/store.js');
            setSelection(new Set([S.state.editLanes[0].notes.find(n => n.start === 2)]));
            (await import('/edit.js')).markSelectionAsMotif();
        }""")
        self.assertFalse(page.evaluate("async () => !!(await import('/store.js')).S.state.editLanes[0].notes.find(n => n.start === 16).motifId"))

    def test_mark_as_motif_extends_a_fully_selected_motif(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S, setSelection} = await import('/store.js');
            const {markSelectionAsMotif} = await import('/edit.js');
            const notes = S.state.editLanes[0].notes;
            setSelection(new Set(notes.filter(n => n.start === 8 || n.start === 9)));
            markSelectionAsMotif();
            window.originalMotifId = notes.find(n => n.start === 8).motifId;
            setSelection(new Set(notes.filter(n => n.start >= 8 && n.start <= 9)));
            (await import('/edit.js')).openNoteMenu(600, 300);
        }""")
        page.locator('.ctxmenu').get_by_text('Motif', exact=True).click()
        page.locator('.ctxmenu').get_by_text('Mark as motif', exact=True).click()
        motif = page.locator('#motifList .artifact-row')
        expect(motif).to_have_count(1)
        expect(motif.locator('canvas')).to_have_attribute('aria-label', 'Motif #1, instance 1 in Guitar motif, 3 notes')
        self.assertTrue(page.evaluate("""async () => {
            const {S} = await import('/store.js');
            return S.state.editLanes[0].notes.filter(n => n.start >= 8 && n.start <= 9)
                .every(n => n.motifId === window.originalMotifId) && S.motifUid === 2;
        }"""))
        page.keyboard.press('Control+z')
        expect(motif.locator('canvas')).to_have_attribute('aria-label', re.compile(r'Motif #1,.*2 notes$'))
        page.keyboard.press('Control+Shift+z')
        expect(motif.locator('canvas')).to_have_attribute('aria-label', re.compile(r'Motif #1,.*3 notes$'))

    def test_tone_designer_existing_presets_remain_live_references(self):
        self.open_reference_project()
        page = self.page
        page.evaluate('''async () => {
            const {S} = await import('/store.js'); const lane=S.state.editLanes[0];
            (await import('/tone-markers.js')).openToneMarkerPop(600,200,lane.toneMarkers[0],lane);
        }''')
        page.select_option('#toneMarkerPreset', label='Bass Clean')
        key = page.locator('#toneMarkerPreset').input_value()
        page.click('#toneMarkerEditPreset')
        expect(page.locator('#soundPreset')).to_be_enabled()
        expect(page.locator('#soundPreset')).to_have_value(key)
        expect(page.locator('#soundName')).to_have_value('Bass Clean')
        expect(page.locator('#soundPresetScope')).to_have_count(0)
        expect(page.locator('#soundPreset optgroup[label="Project presets"]')).to_have_count(0)
        page.fill('#soundName', 'Live app bass')
        page.fill('#soundVolumeNumber', '7')
        page.click('#settingsApply')
        page.click('#settingsModalClose')
        result = page.evaluate('''async () => {
            const {S} = await import('/store.js');
            const {readAvailableSoundPresets} = await import('/sound-presets-core.js');
            return {marker:S.state.editLanes[0].toneMarkers[0], presets:readAvailableSoundPresets()};
        }''')
        self.assertEqual(result['marker']['tone'], key)
        self.assertNotIn('toneData', result['marker'])
        self.assertEqual(len(result['presets']), 6, 'editing an existing preset keeps its identity')
        current = next(p for p in result['presets'] if p['id'] == key)
        self.assertEqual(current['tone']['Name'], 'Live app bass')
        self.assertEqual(current['tone']['Volume'], '-7')
        spec = page.evaluate('''async () => {
            const {S} = await import('/store.js');
            return (await import('/tablature.js')).buildSpecForLanesAsync([S.state.editLanes[0]]);
        }''')
        self.assertEqual(spec['tracks'][0]['toneMarkers'][0]['toneData']['Name'], 'Live app bass')
        chart = self.data / 'reference-tones.chart'
        chart.write_bytes(self.download('#saveAs').read_bytes())
        saved = page.request.get(f'{self.url}api/projects/{self.reference_job}').json()
        self.assertNotIn('toneData', saved['editLanes'][0]['toneMarkers'][0])
        with zipfile.ZipFile(chart) as archive:
            portable = json.loads(archive.read('project.json'))
        self.assertEqual(portable['editLanes'][0]['toneMarkers'][0]['toneData']['Name'], 'Live app bass')
        # Import where the preset exists: retain the reference and discard the definition.
        self.home()
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(chart)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        marker = page.evaluate('''async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers[0]''')
        self.assertNotIn('toneData', marker)
        # Import where it does not exist: use the portable definition as a project preset.
        self.home()
        page.evaluate("localStorage.removeItem('cw.soundPresets.v1')")
        page.route('**/api/sound-presets', lambda route: route.fulfill(json={'presets': [], 'errors': [], 'folder': 'Other machine'}))
        with page.expect_file_chooser() as chooser: page.click('#welcomeOpen')
        chooser.value.set_files(chart)
        expect(page.locator('#lanes .lane-row')).to_be_visible()
        marker = page.evaluate('''async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers[0]''')
        self.assertEqual(marker['toneData']['Name'], 'Live app bass')
        page.evaluate('''async () => {
            const {S} = await import('/store.js'); const lane=S.state.editLanes[0];
            (await import('/tone-markers.js')).openToneMarkerPop(600,200,lane.toneMarkers[0],lane);
        }''')
        page.click('#toneMarkerEditPreset')
        expect(page.locator('#soundPreset')).to_be_enabled()
        expect(page.locator('#soundPreset option:checked')).to_have_attribute('value', re.compile('^project:'))
        expect(page.locator('#soundName')).to_have_value('Live app bass')

    def test_tone_designer_imported_unavailable_versions_remain_project_local(self):
        self.open_reference_project()
        page = self.page
        app_before = page.evaluate('''async () => {
            const {S} = await import('/store.js');
            const {readAvailableSoundPresets, cloneSound} = await import('/sound-presets-core.js');
            const original = readAvailableSoundPresets().find(entry => entry.tone.Name === 'Bass Clean');
            const preset = {id:'sound_imported_bass', tone:{...cloneSound(original.tone),Name:'Imported bass'}};
            S.state.editLanes[0].toneMarkers = [
                {id:'first',t:0,tone:preset.id,toneData:cloneSound(preset.tone)},
                {id:'shared',t:4,tone:preset.id,toneData:cloneSound(preset.tone)},
                {id:'variant',t:8,tone:preset.id,toneData:{...cloneSound(preset.tone),Name:'Other version'}},
            ];
            (await import('/repaint.js')).draw();
            return readAvailableSoundPresets();
        }''')
        def snapshots():
            return page.evaluate('''async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers.map(marker => marker.toneData)''')
        page.evaluate('''async () => {
            const {S} = await import('/store.js'); const lane = S.state.editLanes[0];
            (await import('/tone-markers.js')).openToneMarkerPop(600,200,lane.toneMarkers[1],lane);
        }''')
        expect(page.locator('#toneMarkerPreset option:checked')).to_have_text('Imported bass')
        shots = Path(__file__).resolve().parents[1] / 'design-shots'
        shots.mkdir(exist_ok=True)
        page.locator('#toneMarkerPop').screenshot(path=str(shots / 'tone-switch-designer-link.png'))
        page.click('#toneMarkerEditPreset')
        expect(page.locator('#settingsModal')).to_be_visible()
        expect(page.locator('#soundPreset')).to_be_enabled()
        expect(page.locator('#soundName')).to_have_value('Imported bass')
        expect(page.locator('#soundPreset option:checked')).to_have_attribute('value', re.compile('^project:'))
        expect(page.locator('#soundPreset optgroup[label="Project presets"] option')).to_have_count(2)
        expect(page.locator('#soundPresetScope')).to_have_count(0)
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.fill('#soundName', 'Song bass')
        page.fill('#soundVolumeNumber', '7')
        self.assertEqual(snapshots()[0]['Name'], 'Imported bass', 'project edits remain staged')
        page.click('#settingsApply')
        self.assertEqual([tone['Name'] for tone in snapshots()], ['Song bass', 'Song bass', 'Other version'])
        self.assertEqual(snapshots()[1]['Volume'], '-7')
        self.assertEqual(page.evaluate('''async () => (await import('/sound-presets-core.js')).readAvailableSoundPresets()'''), app_before)
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.locator('#settingsModal').screenshot(path=str(shots / 'project-tone-designer.png'))
        page.click('#settingsModalClose')
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('Control+z')
        self.assertEqual(snapshots()[0]['Name'], 'Imported bass')
        page.keyboard.press('Control+Shift+z')
        self.assertEqual(snapshots()[0]['Name'], 'Song bass')
        page.evaluate('''async () => { await (await import('/project.js')).saveToServer(); }''')
        page.reload()
        page.evaluate('''async job => { await (await import('/project.js')).loadCached(job); }''', self.reference_job)
        self.assertEqual([tone['Name'] for tone in snapshots()], ['Song bass', 'Song bass', 'Other version'])
        page.click('#settingsMenuBtn')
        page.click('[data-settings-pane=sounds]')
        expect(page.locator('#soundPreset')).to_be_enabled()
        project = page.locator('#soundPreset optgroup[label="Project presets"] option').filter(has_text='Song bass')
        page.select_option('#soundPreset', project.get_attribute('value'))
        expect(page.locator('#soundName')).to_have_value('Song bass')

    def test_tone_designer_reference_edits_cancel_without_creating_presets(self):
        self.open_reference_project()
        page = self.page
        before = page.evaluate('''async () => ({
            marker:(await import('/store.js')).S.state.editLanes[0].toneMarkers[0],
            library:localStorage.getItem('cw.soundPresets.v1')
        })''')
        page.evaluate('''async () => {
            const {S} = await import('/store.js'); const lane=S.state.editLanes[0];
            (await import('/tone-markers.js')).openToneMarkerPop(600,200,lane.toneMarkers[0],lane);
        }''')
        page.click('#toneMarkerEditPreset')
        expect(page.locator('#soundPreset')).to_be_enabled()
        page.fill('#soundName', 'Discarded project edit')
        page.click('[data-settings-pane=appearance]')
        page.click('[data-settings-pane=sounds]')
        expect(page.locator('#soundName')).to_have_value('Discarded project edit')
        page.click('#settingsModalClose')
        after = page.evaluate('''async () => ({
            marker:(await import('/store.js')).S.state.editLanes[0].toneMarkers[0],
            library:localStorage.getItem('cw.soundPresets.v1')
        })''')
        self.assertEqual(after, before)

    def test_tone_switch_offers_only_current_presets_without_opening_settings(self):
        self.open_reference_project()
        page = self.page
        page.evaluate('''async () => {
            const {S} = await import('/store.js');
            const lane = S.state.editLanes[0];
            (await import('/tone-markers.js')).openToneMarkerPop(600, 200, lane.toneMarkers[0], lane);
        }''')
        options = page.locator('#toneMarkerPreset option')
        expect(options).to_have_count(6)
        self.assertEqual(options.evaluate_all('els => els.map(el => el.value).filter(value => ["lead","clean","crunch","bass"].includes(value))'), [])
        self.assertEqual(options.evaluate_all('els => els.every(el => el.value.startsWith("sound_file_"))'), True)
        page.select_option('#toneMarkerPreset', label='Bass Clean')
        selected = page.evaluate('''async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers[0]''')
        self.assertNotIn('toneData', selected)
        expect(page.locator('#toneMarkerPreset option')).to_have_count(6)
        expect(page.locator('#toneMarkerPreset option:disabled')).to_have_count(0)

    def test_tone_switch_empty_library_does_not_restore_old_defaults(self):
        page = self.page
        page.route('**/api/sound-presets', lambda route: route.fulfill(json={'presets': [], 'errors': [], 'folder': 'Empty'}))
        self.open_reference_project()
        page.evaluate('''async () => (await import('/tone-markers.js')).addToneMarkerAtTime(3, 600, 200)''')
        expect(page.locator('.toast').filter(has_text='No tone presets are available')).to_be_visible()
        self.assertEqual(page.evaluate('''async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers'''), [])

    def test_tone_switch_missing_presets_warn_on_load_and_can_be_repaired(self):
        page = self.page
        root = Path(__file__).resolve().parents[1]
        data = json.loads((root / 'examples/reference-showcase/project.json').read_text('utf-8'))
        tone = json.loads((root / 'presets/sounds/guitar-clean.json').read_text('utf-8'))
        tone['Name'] = 'Removed custom preset'
        data['editLanes'][0]['toneMarkers'] = [
            {'id': f'removed_{key}', 't': index, 'tone': key}
            for index, key in enumerate(['lead', 'clean', 'crunch', 'bass'])] + [
            {'id': 'removed_custom', 't': 4, 'tone': 'sound_removed', 'toneData': tone}]
        bundle = self.data / 'missing-tones.chart'
        with zipfile.ZipFile(bundle, 'w') as archive:
            archive.writestr('project.json', json.dumps(data))
        with page.expect_file_chooser() as chooser:
            page.click('#welcomeOpen')
        chooser.value.set_files(bundle)
        warning = page.locator('.toast').filter(has_text='Missing tone presets:')
        expect(warning).to_have_count(1)
        expect(warning.locator('.dot.warn')).to_be_visible()
        self.assertEqual(warning.locator('.dot.warn').evaluate('el => getComputedStyle(el, "::before").content'), 'none')
        for name in ['lead', 'clean', 'crunch', 'bass']:
            expect(warning).to_contain_text(name)
        before = page.evaluate('''async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers''')
        self.assertEqual([m['tone'] for m in before], ['lead', 'clean', 'crunch', 'bass', 'sound_removed'])
        strokes = page.evaluate('''async () => {
            const {sctx} = await import('/dom.js'), {PAINT} = await import('/stage-paint.js');
            const original = sctx.stroke; let warnings = 0;
            sctx.stroke = function(...args) { if (this.strokeStyle === PAINT.warn) warnings++; return original.apply(this, args); };
            try { (await import('/tone-markers.js')).drawToneMarkers(); } finally { sctx.stroke = original; }
            return warnings;
        }''')
        self.assertEqual(strokes, 4, 'each unresolved flag draws its warning triangle')
        shots = root / 'design-shots'
        shots.mkdir(exist_ok=True)
        page.screenshot(path=str(shots / 'tone-missing-presets.png'))
        page.evaluate('''async () => {
            const {S} = await import('/store.js'); const lane = S.state.editLanes[0];
            (await import('/tone-markers.js')).openToneMarkerPop(600,200,lane.toneMarkers[0],lane);
        }''')
        expect(page.locator('#toneMarkerPreset')).to_have_value('lead')
        expect(page.locator('#toneMarkerPreset option[value=lead]')).to_have_attribute('disabled', '')
        expect(page.locator('#toneMarkerPreset option[value=lead]')).to_contain_text('Missing preset: lead')
        expect(page.locator('#toneMarkerPreset option:not(:disabled)')).to_have_count(6)
        page.select_option('#toneMarkerPreset', label='Guitar Clean')
        expect(page.locator('#toneMarkerPreset option:disabled')).to_have_count(0)
        repaired = page.evaluate('''async () => (await import('/store.js')).S.state.editLanes[0].toneMarkers[0]''')
        self.assertTrue(repaired['tone'].startswith('sound_file_'))
        self.assertNotIn('toneData', repaired)
        self.assertEqual(repaired['t'], 0)

    def test_all_marker_artifacts_edit_jump_and_update_live(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const lane = S.state.editLanes[0];
            S.state.sectionMarkers = [{id:'section_song', t:4, text:'Verse', sectionType:'verse'}];
            S.state.tempoMap = [{t:12, bpm:120, tsNum:3, tsDen:4, subdiv:2}];
            const {readAvailableSoundPresets} = await import('/sound-presets-core.js');
            const library = readAvailableSoundPresets();
            const clean = library.find(p => p.tone.Name === 'Guitar Clean');
            const crunch = library.find(p => p.tone.Name === 'Guitar Crunch');
            lane.toneMarkers = [{id:'start', t:0, tone:clean.id}, {id:'tone_song', t:12, tone:crunch.id}];
            lane.phraseBoundaries = [{id:'phrase_song', t:6}];
            const other = {...lane, id:'other', name:'Other guitar', active:false,
                notes:[], refBoxes:{}, toneMarkers:[{id:'tone_other', t:10, tone:clean.id}],
                phraseBoundaries:[{id:'phrase_other', t:14}, {id:'phrase_other2', t:18}]};
            S.state.editLanes.push(other);
            const {rebuildLanes, renderLanes} = await import('/lanes.js');
            rebuildLanes(); renderLanes();
            (await import('/section-markers.js')).sectionMarkersChanged();
            (await import('/repaint.js')).draw();
        }""")
        root = page.locator('#artifactMarkers')
        # Only the active layer's markers are listed.
        expect(root.locator('[data-marker-kind="tempo"] .artifact-row')).to_have_count(2)
        expect(root.locator('[data-marker-kind="section"] .artifact-row')).to_have_count(1)
        expect(root.locator('[data-marker-kind="phrase"] .artifact-row')).to_have_count(1)
        expect(root.locator('[data-marker-kind="tone"] .artifact-row')).to_have_count(2)
        expect(root.locator('[data-marker-key$=":tone_other"]')).to_have_count(0)
        # Real editor dialog: the section can be renamed and undone from here.
        verse = root.locator('.artifact-row').filter(has_text='Verse')
        verse.locator('.artifact-marker-edit').click()
        expect(page.locator('#sectionMarkerPop')).to_be_visible()
        page.locator('#sectionMarkerKind').select_option('custom')
        page.locator('#sectionMarkerName').fill('Opening verse')
        page.locator('#sectionMarkerName').press('Tab')
        page.locator('#sectionMarkerPopClose').click()
        expect(root.locator('.artifact-name').filter(has_text='Opening verse')).to_have_count(1)
        page.keyboard.press('Control+z')
        expect(root.locator('.artifact-name').filter(has_text='Opening verse')).to_have_count(0)
        # Move to seeks and animates the viewport; clicking the row does the same.
        page.evaluate("async () => { const {S} = await import('/store.js'); S.zoomX = 8; (await import('/repaint.js')).draw(); }")
        tone = root.locator('[data-marker-key$=":tone_song"]')
        tone.locator('.artifact-marker-jump').click()
        self.assertEqual(page.evaluate("async () => (await import('/playback.js')).playbackTime()"), 12)
        page.wait_for_function("document.querySelector('#scroll').scrollLeft > 100")
        root.locator('[data-marker-kind="tempo"] .artifact-row').filter(has_text='Start').locator('.artifact-name').click()
        self.assertEqual(page.evaluate("async () => (await import('/playback.js')).playbackTime()"), 0)
        tone.locator('.artifact-marker-edit').click()
        page.locator('#toneMarkerPreset').select_option(label='Bass Clean')
        expect(tone.locator('.artifact-name')).to_have_text('Bass Clean')
        page.locator('#toneMarkerPopClose').click()
        # Right-click opens the same phrase editor, with time and delete actions.
        phrase = root.locator('[data-marker-kind="phrase"] .artifact-row')
        phrase.click(button='right')
        expect(page.locator('#phraseMarkerPop')).to_be_visible()
        page.locator('#phraseMarkerTime').fill('15')
        page.locator('#phraseMarkerTime').press('Tab')
        expect(phrase.locator('.artifact-detail')).to_contain_text('0:15.000')
        page.locator('#phraseMarkerDelete').click()
        expect(root.locator('[data-marker-kind="phrase"] .artifact-row')).to_have_count(0)
        # An empty list is hidden, header included.
        expect(root.get_by_role('button', name='Collapse phrases', exact=True)).to_be_hidden()
        # The start tempo is present, editable, and cannot be deleted.
        start = root.locator('[data-marker-kind="tempo"] .artifact-row').filter(has_text='Start')
        start.locator('.artifact-marker-edit').click()
        expect(page.locator('#markerDelete')).to_be_hidden()
        page.locator('#markerPopClose').click()
        tempo = root.locator('[data-marker-kind="tempo"] .artifact-row').filter(has_text='3/4')
        tempo.locator('.artifact-marker-edit').click()
        page.locator('#markerTsNum').fill('5')
        page.locator('#markerTsNum').dispatch_event('input')
        expect(root.locator('[data-marker-kind="tempo"] .artifact-name').filter(has_text='5/4')).to_have_count(1)
        page.locator('#markerDelete').click()
        expect(root.locator('[data-marker-kind="tempo"] .artifact-row')).to_have_count(1)
        page.keyboard.press('Control+z')
        expect(root.locator('[data-marker-kind="tempo"] .artifact-row')).to_have_count(2)
        toggle = root.get_by_role('button', name='Collapse tone switches', exact=True)
        toggle.click()
        expect(page.locator('#artifact-tone-body')).to_be_hidden()
        root.get_by_role('button', name='Expand tone switches', exact=True).click()
        expect(page.locator('#artifact-tone-body')).to_be_visible()
        # Timeline-side edits also refresh an existing artifact row.
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            S.state.editLanes[0].toneMarkers[1].tone = (await import('/sound-presets-core.js')).readAvailableSoundPresets().find(p => p.tone.Name === 'Guitar Crunch').id;
            delete S.state.editLanes[0].toneMarkers[1].toneData;
            (await import('/repaint.js')).draw();
        }""")
        expect(tone.locator('.artifact-name')).to_have_text('Guitar Crunch')
        # Switching the active layer switches the list.
        page.locator('#lanes .lane-row').filter(has_text='Other guitar').click()
        expect(root.locator('[data-marker-kind="phrase"] .artifact-row')).to_have_count(2)
        expect(root.locator('[data-marker-key$=":tone_other"]')).to_have_count(1)
        expect(root.locator('[data-marker-key$=":tone_song"]')).to_have_count(0)

    def test_marker_artifacts_follow_the_active_layers_own_timing(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            S.state.sectionMarkers = [{id:'song_section', t:4, text:'Song verse', sectionType:'verse', custom:true}];
            (await import('/timing.js')).splitTiming(S.state.editLanes[0]);
            S.state.sectionMarkers = [{id:'own_section', t:8, text:'Layer solo', sectionType:'solo', custom:true}];
            (await import('/repaint.js')).draw();
        }""")
        root = page.locator('#artifactMarkers')
        expect(root.locator('.artifact-name').filter(has_text='Layer solo')).to_have_count(1)
        expect(root.locator('.artifact-name').filter(has_text='Song verse')).to_have_count(0)

    def test_hand_anchors_have_live_artifacts_and_editable_timeline_markers(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const {setHandAnchor} = await import('/edit.js');
            setHandAnchor(S.state.editLanes[0], 2, 5);
            setHandAnchor(S.state.editLanes[0], 6, 9);
        }""")
        anchors = page.locator('[data-marker-kind="anchor"] .artifact-row')
        expect(anchors).to_have_count(2)
        expect(anchors.locator('.artifact-name')).to_have_text(['Fret 5', 'Fret 9'])
        anchors.first.locator('.artifact-marker-edit').click()
        expect(page.locator('#handAnchorPop')).to_be_visible()
        page.locator('#handAnchorFret').fill('7')
        page.locator('#handAnchorFret').press('Tab')
        expect(anchors.first.locator('.artifact-name')).to_have_text('Fret 7')
        page.locator('#handAnchorPopClose').click()
        page.keyboard.press('Control+z')
        expect(anchors.first.locator('.artifact-name')).to_have_text('Fret 5')
        page.keyboard.press('Control+Shift+z')
        expect(anchors.first.locator('.artifact-name')).to_have_text('Fret 7')
        anchors.last.locator('.artifact-marker-jump').click()
        self.assertEqual(page.evaluate("async () => (await import('/playback.js')).playbackTime()"), 6)
        page.wait_for_function("document.querySelector('#scroll').scrollLeft > 100")

        def anchor_point(t):
            return page.evaluate("""async t => {
                (await import('/viewport-motion.js')).stopViewportMotion();
                (await import('/repaint.js')).drawNow();
                const {xOf} = await import('/geometry.js');
                const {railBand} = await import('/marker-rails.js');
                const r = document.querySelector('#stage').getBoundingClientRect();
                return [r.left + xOf(t) - document.querySelector('#scroll').scrollLeft + 8,
                    r.top + railBand('hand-anchor').y + 10];
            }""", t)

        # The framed timeline marker itself opens the same editor on right-click.
        page.mouse.click(*anchor_point(6), button='right')
        expect(page.locator('#handAnchorPop')).to_be_visible()
        page.locator('#handAnchorTime').fill('8')
        page.locator('#handAnchorTime').press('Tab')
        page.locator('#handAnchorPopClose').click()
        expect(anchors.last.locator('.artifact-detail')).to_contain_text('0:08.000')
        # Clicking also edits; dragging is a beat-snapped move and one undo step.
        page.mouse.click(*anchor_point(8))
        expect(page.locator('#handAnchorPop')).to_be_visible()
        page.locator('#handAnchorPopClose').click()
        start, end = anchor_point(8), anchor_point(10)
        page.mouse.move(*start); page.mouse.down()
        page.mouse.move(*end, steps=5); page.mouse.up()
        expect(anchors.last.locator('.artifact-detail')).to_contain_text('0:10.000')
        page.keyboard.press('Control+z')
        expect(anchors.last.locator('.artifact-detail')).to_contain_text('0:08.000')
        # An existing beat cannot be overwritten accidentally through the editor.
        anchors.last.locator('.artifact-marker-edit').click()
        page.locator('#handAnchorTime').fill('2')
        page.locator('#handAnchorTime').press('Tab')
        expect(page.locator('#handAnchorTime')).to_have_value('8')
        expect(anchors).to_have_count(2)
        page.locator('#handAnchorDelete').click()
        expect(anchors).to_have_count(1)
        page.keyboard.press('Control+z')
        expect(anchors).to_have_count(2)
        # Existing project serialization preserves the anchors and their labels.
        page.evaluate("async () => { const p = await import('/project.js'); await p.saveToServer(); p.markSaved(); }")
        page.reload()
        page.locator(f'#recentList [data-job="{self.reference_job}"] .ri-open').click()
        expect(anchors).to_have_count(2)
        expect(anchors.locator('.artifact-name')).to_have_text(['Fret 7', 'Fret 9'])
        page.get_by_role('button', name='Collapse hand anchors', exact=True).click()
        expect(page.locator('#artifact-anchor-body')).to_be_hidden()
        page.get_by_role('button', name='Expand hand anchors', exact=True).click()
        expect(page.locator('#artifact-anchor-body')).to_be_visible()

    def test_hand_anchor_artifacts_target_their_layer_and_respect_locks(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const lane = S.state.editLanes[0];
            lane.handHolds = [{t:2, fret:5}];
            const other = {...lane, id:'anchor_other', name:'Other guitar', active:false,
                notes:[], refBoxes:{}, handHolds:[{t:4, fret:3}]};
            S.state.editLanes.push(other);
            const {rebuildLanes, renderLanes} = await import('/lanes.js');
            rebuildLanes(); renderLanes(); (await import('/repaint.js')).draw();
        }""")
        anchors = page.locator('[data-marker-kind="anchor"] .artifact-row')
        expect(anchors.locator('.artifact-name')).to_have_text(['Fret 5'])
        page.locator('#lanes .lane-row').filter(has_text='Other guitar').click()
        expect(anchors.locator('.artifact-name')).to_have_text(['Fret 3'])
        anchors.first.locator('.artifact-marker-edit').click()
        page.locator('#handAnchorFret').fill('4')
        page.locator('#handAnchorFret').press('Tab')
        page.locator('#handAnchorPopClose').click()
        expect(anchors.first.locator('.artifact-name')).to_have_text('Fret 4')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].handHolds[0].fret"), 5)
        page.evaluate("""async () => {
            const {S} = await import('/store.js'); S.state.editLanes[1].locked = true;
            (await import('/repaint.js')).draw();
        }""")
        expect(anchors.first.locator('.artifact-marker-edit')).to_be_disabled()
        anchors.first.click(button='right')
        expect(page.locator('#handAnchorPop')).to_be_hidden()

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
        expect(page.locator("#rsLeadIn")).to_have_value("9.5")
        row = page.locator(".rs-arr-row")
        expect(row).to_have_count(1)
        expect(row.locator(".rs-arr-on")).to_be_checked()
        expect(row.locator(".count")).to_have_text("8 notes")
        expect(row.locator(".rs-arr-kind")).to_have_value("lead")
        # Bass needs four strings: the tuning list follows the arrangement type.
        row.locator(".rs-arr-kind").select_option("bass")
        self.assertEqual(row.locator(".rs-arr-tuning").input_value().count(","), 3)
        page.click("#rsExportClose")
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
        # The row's summary ("Lead · E Standard · 2 notes"), not the whole row: the
        # volume's level follows it in the row's text with no space between.
        notes = lambda count: expect(page.locator("#lanes .lane-row .count")).to_contain_text(re.compile(rf"\b{count} notes?\b"))
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

    def test_project_start_translates_all_timings_and_locked_references(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S} = await import('./store.js');
            const {addTiming} = await import('./timing.js');
            const lane = S.state.editLanes[0];
            lane.refBoxes[1].locked = true;
            lane.notes[0].start += .013; lane.notes[0].end += .013;
            lane.handHolds = [{t: 2, fret: 3}];
            lane.phraseBoundaries = [{id:'p',t:8}];
            S.state.tempoMap = [{t:4,bpm:160,tsNum:4,tsDen:4,subdiv:2},{t:12,bpm:100,tsNum:3,tsDen:4,subdiv:4}];
            S.state.sectionMarkers = [{id:'v',t:0,text:'Verse',sectionType:'verse'},{id:'s',t:12,text:'Solo',sectionType:'solo'}];
            const bars = await import('./score-structure-core.js');
            S.state.scoreBars = bars.coverScoreDuration(bars.normalizeScoreBars([{seconds:0,durationSeconds:2},{seconds:2,durationSeconds:2}]),S.state.duration);
            const own = addTiming({grid:{bpm:90,offset:.125,tsNum:4,tsDen:4,subdiv:2},
                tempoMap:[{t:10,bpm:110,tsNum:4,tsDen:4,subdiv:2}],sectionMarkers:[{id:'other',t:2,text:'Riff'}],scoreBars:[{seconds:.125,durationSeconds:2}]});
            S.state.editLanes.push({id:'own',name:'Own timing',kind:'edit',instrument:lane.instrument,tuning:lane.tuning,
                active:false,locked:true,visible:false,timing:own,color:lane.color,volume:1,handHolds:[],phraseBoundaries:[],
                refBoxes:{},notes:[{id:'own-note',start:14.137,end:15.137,pitch:45}],toneMarkers:[{id:'own-tone',t:0,tone:lane.toneMarkers[0].tone}]});
            (await import('./lanes.js')).renderLanes();
            (await import('./repaint.js')).drawNow();
        }""")
        state = """async () => {
            const {S} = await import('./store.js');
            const {timingSnapshot} = await import('./timing.js');
            return {start:S.state.projectStart||0,duration:S.state.duration,
                lanes:S.state.editLanes.map(l=>({notes:l.notes.map(n=>[n.start,n.end]),boxes:l.refBoxes,
                    holds:l.handHolds,tones:l.toneMarkers,phrases:l.phraseBoundaries})),
                timings:Object.fromEntries(Object.entries(timingSnapshot().timings).map(([id,t])=>[id,{grid:t.grid,
                    tempoMap:t.tempoMap.map(m=>({t:m.t})),sectionMarkers:t.sectionMarkers.map(m=>({t:m.t})),scoreBars:t.scoreBars.map(b=>({seconds:b.seconds}))}]))};
        }"""
        before = page.evaluate(state)
        handle = page.locator('#projectStartHandle')
        expect(handle).to_be_visible()
        def assert_start_alignment():
            positions = page.evaluate("""async () => {
                const {S}=await import('./store.js'); const {xOf}=await import('./geometry.js');
                const {gridOffset}=await import('./grid.js'); const {firstMarkerViewportRect}=await import('./markers.js');
                const {drawNow}=await import('./repaint.js'); drawNow();
                const stage=document.querySelector('#stage').getBoundingClientRect();
                const line=document.querySelector('#projectStartHandle').getBoundingClientRect();
                const scroll=document.querySelector('#scroll');
                return {tempo:firstMarkerViewportRect().left,tempoTime:stage.left+xOf(gridOffset())-scroll.scrollLeft,
                    start:stage.left+xOf(S.state.projectStart||0)-scroll.scrollLeft,line:line.left+line.width/2};
            }""")
            self.assertAlmostEqual(positions['tempo'],positions['tempoTime'],delta=.1)
            self.assertAlmostEqual(positions['start']-positions['line'],12,delta=.1)
        assert_start_alignment()
        self.assertEqual(handle.evaluate('e=>getComputedStyle(e).position'), 'absolute')
        self.assertEqual(handle.evaluate('e=>getComputedStyle(e,"::before").width'), '1px')
        self.assertEqual(handle.evaluate('e=>getComputedStyle(e).backgroundColor'), 'rgba(0, 0, 0, 0)')
        box = handle.bounding_box()
        x, y = box['x'] + box['width'] / 2 + 1, box['y'] + 175
        px = page.evaluate("async () => (await import('./store.js')).S.pxPerSec")
        page.mouse.move(x,y)
        expect(handle.locator('svg')).to_have_css('opacity','1')
        page.mouse.down()
        page.mouse.move(x + .375 * px,y,steps=8)
        during = page.evaluate(state)
        self.assertAlmostEqual(during['start'], .375, places=3)
        page.mouse.up()
        moved = page.evaluate(state)
        assert_start_alignment()
        self.assertEqual(moved, during, 'release must not quantize the imported rhythm')
        for old, new in zip(before['lanes'], moved['lanes']):
            for note0, note1 in zip(old['notes'],new['notes']):
                for a,b in zip(note0,note1): self.assertAlmostEqual(b-a,.375,places=6)
            for field in ['holds','tones','phrases']:
                for a,b in zip(old[field],new[field]): self.assertAlmostEqual(b['t']-a['t'],.375,places=6)
            for key, group in old['boxes'].items():
                for a,b in zip(group['anchors'],new['boxes'][key]['anchors']): self.assertAlmostEqual(b-a,.375,places=6)
        for key, timing in before['timings'].items():
            shifted=moved['timings'][key]
            self.assertAlmostEqual(shifted['grid']['offset']-timing['grid']['offset'],.375,places=6)
            for field,time_key in [('tempoMap','t'),('sectionMarkers','t'),('scoreBars','seconds')]:
                for a,b in zip(timing[field],shifted[field]): self.assertAlmostEqual(b[time_key]-a[time_key],.375,places=6)
        self.assertEqual(page.evaluate("async () => (await import('./store.js')).S.undoStack.length"),1)
        self.assertAlmostEqual(moved['duration']-before['duration'],.375,places=6)
        page.keyboard.press('Control+z')
        self.assertEqual(page.evaluate(state),before)
        page.keyboard.press('Control+Shift+z')
        self.assertEqual(page.evaluate(state),moved)
        saved = page.evaluate("""async () => {
            const {S}=await import('./store.js'); const p=await import('./project.js');
            await p.saveToServer();
            const saved=await (await fetch('/api/projects/'+S.state.job)).json();
            await p.applyProject(saved);
            return saved;
        }""")
        self.assertAlmostEqual(saved['projectStart'],.375,places=6)
        self.assertEqual(page.evaluate(state),moved)
        exported = page.request.post(self.url + 'api/projects/' + saved['job'] + '/export',data={})
        self.assertTrue(exported.ok)
        with zipfile.ZipFile(io.BytesIO(exported.body())) as chart:
            self.assertAlmostEqual(json.loads(chart.read('project.json'))['projectStart'],.375)
        handle = page.locator('#projectStartHandle')
        box = handle.bounding_box()
        page.mouse.move(box['x']+box['width']/2,box['y']+175)
        page.screenshot(path='design-shots/project-start-implemented.png')

    def test_project_start_blocks_placement_and_drag_can_be_cancelled(self):
        self.open_reference_project()
        page = self.page
        handle = page.locator('#projectStartHandle')
        handle.focus()
        for _ in range(5): page.keyboard.press('Shift+ArrowRight')
        page.evaluate('document.activeElement.blur()')
        self.assertAlmostEqual(page.evaluate("async ()=>(await import('./store.js')).S.state.projectStart"),.5)
        lane_state = "async ()=>JSON.stringify((await import('./edit.js')).snapshotEdit())"
        before = page.evaluate(lane_state)
        p = page.evaluate("""async () => {
            const {xOf}=await import('./geometry.js'); const stage=document.querySelector('#stage').getBoundingClientRect();
            return {x:stage.left+xOf(.1), y:stage.top+180};
        }""")
        page.mouse.dblclick(p['x'],p['y'])
        page.mouse.click(p['x'],p['y'],button='right')
        self.assertEqual(page.evaluate(lane_state),before)
        self.assertEqual(page.locator('.ctxmenu:visible').count(),0)
        self.assertGreaterEqual(page.evaluate("async ()=>(await import('./grid.js')).snap(-10)"),.5)
        self.assertGreaterEqual(page.evaluate("async ()=>(await import('./tone-markers.js')).snapToneTime(-1)"),.5)
        box=handle.bounding_box()
        page.mouse.move(box['x']+box['width']/2,box['y']+170)
        page.mouse.down(); page.mouse.move(box['x']+45,box['y']+170,steps=5)
        page.keyboard.press('Escape');page.mouse.up()
        self.assertAlmostEqual(page.evaluate("async ()=>(await import('./store.js')).S.state.projectStart"),.5)
        self.assertEqual(page.evaluate(lane_state),before)

    def test_project_start_keeps_audio_fixed_and_preserves_the_last_note(self):
        self.new_audio_project()
        page=self.page
        original=page.evaluate("""async () => {
            const {S}=await import('./store.js'); const {restoreGridState}=await import('./grid.js');
            restoreGridState({bpm:120,offset:0,tsNum:4,tsDen:4,subdiv:2});
            const lane=S.state.editLanes[0];
            lane.notes=[{id:'tail',start:S.state.duration-1,end:S.state.duration-.25,pitch:45}];
            (await import('./repaint.js')).drawNow();
            return {duration:S.state.duration,src:document.querySelector('#audio').currentSrc,
                image:S.spectImg?.src,grid:S.appliedGrid.offset};
        }""")
        handle=page.locator('#projectStartHandle');box=handle.bounding_box()
        page.mouse.move(box['x']+box['width']/2+1,box['y']+170)
        page.mouse.down();page.mouse.move(box['x']+180,box['y']+170,steps=10);page.mouse.up()
        result=page.evaluate("""async()=>{
            const {S}=await import('./store.js');return {start:S.state.projectStart,duration:S.state.duration,
                end:S.state.editLanes[0].notes[0].end,src:document.querySelector('#audio').currentSrc,image:S.spectImg?.src};
        }""")
        self.assertAlmostEqual(result['start'],.25,places=6)
        self.assertAlmostEqual(result['end'],original['duration'],places=6)
        for key in ['duration','src','image']: self.assertEqual(result[key],original[key])
        page.keyboard.press('Control+z')
        self.assertAlmostEqual(page.evaluate("async ()=>(await import('./store.js')).S.state.projectStart||0"),0)

    def test_guitar_pro_import_respects_an_existing_project_start(self):
        self.open_reference_project()
        page = self.page
        page.locator('#projectStartHandle').focus()
        for _ in range(5): page.keyboard.press('Shift+ArrowRight')
        page.evaluate('document.activeElement.blur()')
        page.click('#fileMenuBtn')
        with page.expect_file_chooser() as chooser: page.click('#importGp')
        chooser.value.set_files(self.data / 'song.gp5')
        page.click('#gpImportConfirm')
        expect(page.locator('#gpImportBackdrop')).to_be_hidden()
        self.loaded()
        imported = page.evaluate("""async () => {
            const {S}=await import('./store.js'); const {timingData,timingIdOf}=await import('./timing.js');
            const lane=S.state.editLanes.find(l=>l.sourceTrackIndex!=null);
            const timing=timingData(timingIdOf(lane));
            return {start:S.state.projectStart,notes:lane.notes.map(n=>n.start),offset:timing.grid.offset,
                tones:lane.toneMarkers.map(m=>m.t),bars:timing.scoreBars.map(b=>b.seconds)};
        }""")
        self.assertAlmostEqual(imported['start'],.5)
        self.assertAlmostEqual(imported['offset'],.5)
        self.assertAlmostEqual(min(imported['notes']),.5)
        self.assertTrue(all(t>=.5 for t in imported['tones']+imported['bars']))

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
            x, y = self.rail_point(t)
            x1 = x + by * page.evaluate("async () => (await import('./store.js')).S.pxPerSec")
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
        original_time = marker_t()  # addMarker snaps to the song's detected note grid.
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
        edited_time = marker_t()
        page.click("#markerPopClose")
        page.evaluate('document.activeElement.blur()')       # global undo ignores focused form buttons
        page.keyboard.press("Control+z")                     # the popover session is one step
        self.assertEqual(marker_t(), original_time)
        page.keyboard.press("Control+Shift+z")
        self.assertEqual(marker_t(), edited_time)

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
        page.click("#layerSave"); expect(page.locator("#layerSettingsBackdrop")).to_be_visible(); expect(page.locator("#layerSave")).to_be_hidden(); page.click("#settingsClose")
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
        page.click("#layerSave"); expect(page.locator("#layerSettingsBackdrop")).to_be_visible(); expect(page.locator("#layerSave")).to_be_hidden(); page.click("#settingsClose")
        expect(page.locator("#layerSettingsBackdrop")).to_be_hidden()
        expect(page.locator("#lanes")).to_contain_text("Rhythm")
        expect(page.locator("#lanes")).to_contain_text("Capo 2")
        self.file_menu("#menuExportRocksmith")
        row = page.locator(".rs-arr-row")
        expect(row.locator(".rs-arr-kind")).to_have_value("rhythm")
        expect(row.locator(".rs-arr-capo")).to_have_value("2")
        page.click("#rsExportClose")

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

    def test_tuning_string_rows_edit_pitch_and_preserve_order(self):
        page = self.page
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=tunings]')
        page.click('#tuningNewBtn')
        rows = page.locator('.tuning-string-row')
        expect(rows).to_have_count(6)
        self.assertEqual(rows.locator('.tuning-pitch').all_text_contents(), ['E4', 'B3', 'G3', 'D3', 'A2', 'E2'])
        self.assertEqual(rows.evaluate_all('els => els.map(el => el.dataset.string)'), ['1', '2', '3', '4', '5', '6'])
        low = page.locator('.tuning-string-row[data-string="6"]')
        low.locator('.tuning-string-down').click()
        expect(low.locator('.tuning-pitch')).to_have_text('D#2')
        expect(low.locator('.tuning-string-down')).to_be_focused()
        low.locator('.tuning-pitch').click()
        low.locator('.tuning-note').select_option('2')
        low.locator('.tuning-octave').select_option('1')
        expect(low.locator('.tuning-pitch')).to_have_text('D1')
        expect(low.locator('.tuning-octave')).to_be_focused()
        page.keyboard.press('Escape')
        expect(low.locator('.tuning-pitch-picker')).to_be_hidden()
        expect(low.locator('.tuning-pitch')).to_be_focused()
        expect(page.locator('#settingsModal')).to_be_visible()
        expect(rows.first.locator('.tuning-pitch')).to_have_text('E4')
        page.fill('.tuning-name', 'String row tuning')
        page.click('#settingsApply')
        page.click('#settingsModalClose')
        page.reload()
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=tunings]')
        page.locator('.tuning-item', has_text='String row tuning').click()
        expect(low.locator('.tuning-pitch')).to_have_text('D1')
        expect(rows.first.locator('.tuning-pitch')).to_have_text('E4')
        page.select_option('.tuning-shape select >> nth=1', '8')
        expect(rows).to_have_count(8)
        self.assertEqual(rows.locator('.tuning-pitch').all_text_contents(), ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'B1', 'F#1'])
        shots = Path(__file__).resolve().parents[1] / 'design-shots'
        shots.mkdir(exist_ok=True)
        page.locator('#settingsModal').screenshot(path=str(shots / 'tuning-string-rows-dark.png'))
        page.click('[data-settings-pane=appearance]')
        page.locator('input[name=theme][value=light]').check()
        page.click('[data-settings-pane=tunings]')
        page.locator('#settingsModal').screenshot(path=str(shots / 'tuning-string-rows-light.png'))
        self.assertTrue(rows.evaluate_all('els => els.every(el => el.getBoundingClientRect().right <= document.querySelector("#tuningEditor").getBoundingClientRect().right)'))
        rows.first.locator('.tuning-pitch').click()
        page.locator('#settingsModal').screenshot(path=str(shots / 'tuning-string-pitch-picker.png'))
        page.keyboard.press('Escape')
        # Smaller windows keep the list and editor independently scrollable.
        page.set_viewport_size({'width': 900, 'height': 720})
        rows.last.locator('.tuning-pitch').scroll_into_view_if_needed()
        expect(rows.last.locator('.tuning-pitch')).to_be_in_viewport()
        page.locator('#tuningEditor .tuning-actions button').scroll_into_view_if_needed()
        expect(page.locator('#tuningEditor .tuning-actions button')).to_be_in_viewport()

    def test_settings_height_changes_ease_and_respect_reduced_motion(self):
        page = self.page
        page.emulate_media(reduced_motion='no-preference')
        page.click('#welcomeSettingsBtn')
        def sample(pane):
            return page.evaluate('''async pane => {
                const modal = document.querySelector('#settingsModal');
                const initial = modal.getBoundingClientRect().height;
                document.querySelector(`[data-settings-pane="${pane}"]`).click();
                const heights = [], started = performance.now();
                await new Promise(resolve => {
                    const frame = now => {
                        heights.push(modal.getBoundingClientRect().height);
                        if (now - started < 350) requestAnimationFrame(frame); else resolve();
                    };
                    requestAnimationFrame(frame);
                });
                return {initial, heights, end: modal.getBoundingClientRect().height};
            }''', pane)
        standard = sample('tunings')
        self.assertAlmostEqual(standard['end'],standard['initial'],delta=1)
        grown = sample('trace')
        self.assertGreater(grown['end'], grown['initial'])
        self.assertTrue(any(grown['initial'] + 1 < h < grown['end'] - 1 for h in grown['heights']))
        shrunk = sample('appearance')
        self.assertAlmostEqual(shrunk['end'], grown['initial'], delta=1)
        self.assertTrue(any(shrunk['end'] + 1 < h < shrunk['initial'] - 1 for h in shrunk['heights']))
        page.emulate_media(reduced_motion='reduce')
        page.click('[data-settings-pane=sounds]')
        page.wait_for_function('document.querySelector("#settingsModal").getBoundingClientRect().height >= 799')
        self.assertEqual(page.locator('#settingsModal').evaluate('el => getComputedStyle(el).transitionDuration'), '0.001s')

    def test_tuning_string_order_preference(self):
        page = self.page
        page.click('#welcomeSettingsBtn')
        modal = page.locator('#settingsModal')
        original_size = modal.bounding_box()
        page.click('[data-settings-pane=tunings]')
        self.assertEqual(modal.bounding_box()['width'], original_size['width'])
        expect(page.locator('#tuningStringOrder')).to_have_value('low-bottom')
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.select_option('#tuningStringOrder', 'low-top')
        expect(page.locator('#settingsApply')).to_be_hidden()
        page.reload()
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=tunings]')
        expect(page.locator('#tuningStringOrder')).to_have_value('low-top')
        page.click('#tuningNewBtn')
        rows = page.locator('.tuning-string-row')
        expect(rows.first.locator('.tuning-pitch')).to_have_text('E2')
        low = page.locator('.tuning-string-row[data-string="6"]')
        low.locator('.tuning-string-up').click()
        expect(rows.first.locator('.tuning-pitch')).to_have_text('F2')
        page.select_option('#tuningStringOrder', 'low-bottom')
        expect(rows.last.locator('.tuning-pitch')).to_have_text('F2')
        expect(rows.first.locator('.tuning-pitch')).to_have_text('E4')
        expect(page.locator('.tuning-item[aria-selected=true] .tuning-item-notes')).to_have_text('F A D G B E')

    def test_tuning_builtin_string_changes_can_be_reset(self):
        page = self.page
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=tunings]')
        page.get_by_role('option', name='Standard E A D G B E', exact=True).click()
        low = page.locator('.tuning-string-row[data-string="6"]')
        low.locator('.tuning-string-down').click()
        expect(low.locator('.tuning-pitch')).to_have_text('D#2')
        expect(page.locator('#tuningEditor').get_by_role('button', name='Save', exact=True)).to_be_enabled()
        page.locator('.tuning-string-section .field-revert').click()
        expect(low.locator('.tuning-pitch')).to_have_text('E2')
        expect(page.locator('#tuningEditor').get_by_role('button', name='Save', exact=True)).to_be_disabled()
        expect(page.locator('#settingsApply')).to_be_hidden()

    def test_tuning_string_pitch_limits_disable_steps(self):
        page = self.page
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=tunings]')
        page.click('#tuningNewBtn')
        row = page.locator('.tuning-string-row[data-string="6"]')
        row.locator('.tuning-pitch').click()
        row.locator('.tuning-note').select_option('0')
        row.locator('.tuning-octave').select_option('0')
        expect(row.locator('.tuning-pitch')).to_have_text('C0')
        expect(row.locator('.tuning-string-down')).to_be_disabled()
        expect(page.locator('.tuning-whole-btn').first).to_be_disabled()
        row.locator('.tuning-octave').select_option('6')
        row.locator('.tuning-note').select_option('4')
        expect(row.locator('.tuning-pitch')).to_have_text('E6')
        expect(row.locator('.tuning-string-up')).to_be_disabled()
        expect(row.locator('.tuning-note option[value="5"]')).to_have_attribute('disabled', '')
        expect(page.locator('.tuning-whole-btn').last).to_be_disabled()
        row.locator('.tuning-pitch').click()
        row.locator('.tuning-string-down').click()
        expect(row.locator('.tuning-pitch')).to_have_text('D#6')
        expect(row.locator('.tuning-string-up')).to_be_enabled()
        row.locator('.tuning-pitch').click()
        row.locator('.tuning-octave').select_option('5')
        row.locator('.tuning-note').select_option('11')
        expect(row.locator('.tuning-pitch')).to_have_text('B5')
        expect(row.locator('.tuning-octave option[value="6"]')).to_have_attribute('disabled', '')

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
        self.apply_settings_and_close()
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
        self.apply_settings_and_close()
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
        # A cold process may still be compiling the audio-analysis kernels.
        expect(card).to_be_visible(timeout=120000)
        expect(card.locator('.tour-body')).to_be_visible()
        expect(card.locator('textarea')).to_have_count(0)
        head = card.locator(".tour-head")
        # The demo song starts on its real grid, at detection's 1/32.
        expect(page.locator("#bpm")).to_have_value("120")
        expect(page.locator("#offset")).to_have_value("0.35")
        expect(page.locator("#subdiv")).to_have_value("8")
        seen = []
        while not card.locator(".tour-home").is_visible():
            expect(card.locator('.tour-body')).to_be_visible()
            self.assertTrue(page.evaluate('''async () => {
                const {S} = await import('/store.js');
                const marker = S.state.editLanes.flatMap(lane => lane.toneMarkers || []).find(marker => marker.id === 'tour_tone_middle');
                return !marker || marker.tone.startsWith('sound_file_') && !marker.toneData;
            }'''))
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
