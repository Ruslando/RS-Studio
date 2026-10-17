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

    def test_fretboard_edit_button_and_single_note_alternative_navigation(self):
        self.open_reference_project()
        page = self.page
        points = self.fretboard_hover_points()
        before = page.evaluate("""async () => {
            const { S } = await import('/store.js');
            return { revision: S.voicingRevision, pitches: S.state.editLanes[0].notes.map(n => n.pitch),
                notes: JSON.stringify(S.state.editLanes[0].notes) };
        }""")
        expect(page.locator('#fretboardEdit')).to_be_visible()
        for target in ('note', 'anchor', 'nut'):
            page.mouse.move(*points[target])
            expect(page.locator('#fretboardPin')).to_be_hidden()
            expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        height = page.locator('#fretboard').bounding_box()['height']
        page.locator('#fretboardEdit').click()
        expect(page.locator('#fretboardPin')).to_be_visible()
        expect(page.locator('#fretboardAltCount')).to_contain_text('Original')
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        expect(page.locator('#fretboardChoose')).to_be_hidden()
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text('1 / 2')
        expect(page.locator('#fretboardEdit')).to_have_attribute('aria-pressed', 'true')
        self.assertGreaterEqual(page.locator('#fretboard').bounding_box()['height'], height)
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '1')
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text('2 / 2')
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_contain_text('Original')
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
        page.locator('#fretboardEdit').click()
        expect(page.locator('#fretboardPin')).to_be_hidden()
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        page.mouse.move(*points['nut'])
        expect(page.locator('#fretboardPin')).to_be_hidden()
        page.locator('#fretboardEdit').click()
        page.keyboard.press('Escape')
        expect(page.locator('#fretboardPin')).to_be_hidden()
        expect(page.locator('#fretboardEdit')).to_have_attribute('aria-pressed', 'false')

    def test_fretboard_capo_control_and_undo(self):
        self.open_reference_project()
        page = self.page
        self.fretboard_hover_points()
        pitches = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.map(n => n.pitch)")
        expect(page.locator('#fretboardCapo')).to_be_disabled()
        expect(page.locator('#fretboardCapo')).to_be_hidden()
        page.locator('#fretboardEdit').click()
        expect(page.locator('#fretboardCapo')).to_be_enabled()
        page.locator('#fretboardCapo').fill('2')
        page.locator('#fretboardCapo').press('Enter')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].capo"), 2)
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].notes.map(n => n.pitch)"), pitches)
        page.keyboard.press('Control+z')
        expect(page.locator('#fretboardCapo')).to_have_value('0')
        page.locator('#fretboardEdit').click()
        expect(page.locator('#fretboardCapo')).to_be_disabled()

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
        page.evaluate("() => { const theme = document.querySelector('#themeSelect'); theme.value = 'light'; theme.dispatchEvent(new Event('change')); }")
        page.locator('#fretboardEdit').click()
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
        # Audit the actual visible buttons, including hovered engaged controls.
        for selector in ['#fretboardEdit', '#fretboardShape']:
            if selector.endswith('Shape'):
                page.locator(selector).click()
            page.locator(selector).hover()
            colors = page.locator(selector).evaluate("el => { const s=getComputedStyle(el); return {ink:s.color,background:s.backgroundColor,on:getComputedStyle(document.documentElement).getPropertyValue('--on-engaged').trim()}; }")
            if selector.endswith('Edit'):
                self.assertEqual(colors['ink'], 'rgb(255, 255, 255)', colors)
        page.keyboard.press('Escape')
        page.mouse.move(5,5)
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
        self.assertEqual(page.evaluate(audit_script), [], 'Visible light-mode buttons need readable foregrounds')
        page.click('#settingsMenuBtn')
        self.assertEqual(page.evaluate(audit_script), [], 'Light-mode settings buttons need readable foregrounds')
        page.click('#settingsCancel')

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
        page.locator('#fretboardEdit').click()
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
        self.assertEqual(page.locator('canvas[data-fretboard-labels]').count(), 4)
        self.assertEqual(page.get_by_text('Each preview shows a fretted note and an open string.').count(), 0)
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
        page.evaluate("() => { const theme = document.querySelector('#themeSelect'); theme.value = 'light'; theme.dispatchEvent(new Event('change')); }")
        page.locator('#settingsModal').screenshot(path=str(shot.with_name('fretboard-label-settings-light.png')))
        page.evaluate("""async () => {
            const {S} = await import('/store.js'); S.state.editLanes[0].color = '#64ecc0';
            const theme = document.querySelector('#themeSelect'); theme.value = 'dark'; theme.dispatchEvent(new Event('change'));
        }""")
        self.assertEqual(set(painted_labels()['inks']), {'#0f1012'})
        page.click('#settingsCancel')
        expect(page.locator('input[name=fretboardLabels][value=both]')).to_be_checked()
        self.assertEqual(len(painted_labels()['notes']), 6)
        page.click('#settingsMenuBtn')
        page.locator('input[name=fretboardLabels][value=none]').check()
        page.click('#settingsApply')
        self.assertEqual(page.evaluate("JSON.parse(localStorage.getItem('cw.settings')).fretboardLabels"), 'none')
        page.click('#fretboardEdit')
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
        page.locator('#fretboardEdit').click()
        for start, anchor, digits in [(20,2,[1,2,4]), (68,4,[1,2,3,4]), (72,6,[1,2,3,4]), (84,5,[1,3]), (92,5,[1,3])]:
            page.evaluate("async t => (await import('/playback.js')).seekPlayback(t)", start)
            expect(page.locator('#fretboardAltCount')).not_to_contain_text('Loading')
            actual = page.evaluate("""async start => {
                const { S } = await import('/store.js');
                const found = await (await import('/tablature.js')).laneFingering(S.state.editLanes[0]);
                const notes = found.notes.filter(n => n.start === start);
                const ctx = document.querySelector('#fretboard').getContext('2d');
                const original = ctx.fillText, digits = [];
                ctx.fillText = function(text, x, y, ...args) {
                    if (/^[1-4]$/.test(String(text)) && this.textBaseline === 'middle' && this.globalAlpha > .9)
                        digits.push(Number(text));
                    return original.call(this,text,x,y,...args);
                };
                try { (await import('/fretboard.js')).drawFretboard(); } finally { ctx.fillText = original; }
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
            const { drawFretboard } = await import('/fretboard.js');
            const { laneFingering } = await import('/tablature.js');
            const { fretDistance } = await import('/fretboard-core.js');
            const { hexA } = await import('/util.js');
            const { WASH } = await import('/stage-paint.js');
            const lane = S.state.editLanes[0];
            lane.notes = [{id:'a',start:0,end:1,pitch:52,pos:{string:3,fret:2}},
                {id:'b',start:1,end:2,pitch:58,pos:{string:3,fret:8}}];
            lane.refBoxes = {}; S.voicingRevision++;
            (await import('/playback.js')).seekPlayback(.75);
            const found = await laneFingering(lane);
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
        self.assertGreater(result['middle'],result['from'])
        self.assertLess(result['middle'],result['to'])
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
        page.locator('#fretboardEdit').click()
        expect(page.locator('#fretboardAltCount')).to_contain_text('Original')
        expect(page.locator('#fretboardAltCount')).not_to_contain_text('Loading')
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
        expect(page.locator('#fretboardPin')).to_be_hidden()
        page.locator('#fretboardEdit').click()
        expect(page.locator('#fretboardPin')).to_be_visible()
        expect(page.locator('#fretboardAltCount')).to_contain_text('Original')
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '0')
        expect(page.locator('#fretboardChoose')).to_be_hidden()
        page.locator('#fretboardAltNext').click()
        expect(page.locator('#fretboardAltCount')).to_have_text(re.compile(r'1 / [1-9][0-9]*'))
        expect(page.locator('#fretboardPanel')).to_have_attribute('data-alternative-count', '1')
        count = int(page.locator('#fretboardAltCount').inner_text().split('/')[1])
        self.assertGreater(count, 1)
        alphas = page.evaluate("""async () => {
            const { drawFretboard } = await import('/fretboard.js');
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
        page.locator('#fretboardEdit').click()
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
        expect(page.locator('#fretboardHand')).to_be_hidden()
        page.locator('#fretboardEdit').click()
        page.locator('#fretboardHand').fill('7')
        page.locator('#fretboardHand').press('Enter')
        holds = page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].handHolds")
        self.assertEqual(holds, [{'t': 2, 'fret': 7}])
        page.locator('#fretboardHand').fill('')
        page.locator('#fretboardHand').press('Enter')
        self.assertEqual(page.evaluate("async () => (await import('/store.js')).S.state.editLanes[0].handHolds"), [])
        page.keyboard.press('Control+z')
        expect(page.locator('#fretboardHand')).to_have_value('7')
        page.locator('#fretboardEdit').click()
        expect(page.locator('#fretboardHand')).to_be_hidden()

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
        expect(preview).to_be_visible()
        expect(preview).to_have_attribute('data-running', 'true')
        boundary = page.evaluate("""async () => {
            const canvas = document.querySelector('#timelineScrollPreview');
            let lastHead = 0;
            while (!Number(canvas.dataset.scroll)) {
                lastHead = Number(canvas.dataset.playhead);
                await new Promise(requestAnimationFrame);
            }
            const viewport = canvas.clientWidth - 16;
            const referenceWidth = document.querySelector('#scroll').clientWidth;
            return {lastHead, viewport, expected:viewport * (1 - 60 / referenceWidth)};
        }""")
        self.assertGreater(boundary['lastHead'], boundary['viewport'] * .85)
        self.assertAlmostEqual(boundary['lastHead'], boundary['expected'], delta=8)
        self.assertEqual(page.get_by_text('Scrolling manually stops following until you pause and play again.').count(), 0)
        page.click('#timelineScrollPreviewToggle')
        expect(preview).to_have_attribute('data-running', 'false')
        paused = preview.evaluate('(canvas) => canvas.toDataURL()')
        page.evaluate('() => new Promise(resolve => setTimeout(resolve, 150))')
        self.assertEqual(preview.evaluate('(canvas) => canvas.toDataURL()'), paused)
        shot = Path(__file__).resolve().parents[1] / '.runs' / 'timeline-scroll-preview.png'
        shot.parent.mkdir(exist_ok=True)
        page.locator('#settingsModal').screenshot(path=str(shot))
        page.locator('input[name=playbackScrollMode][value=follow]').check()
        page.click('#timelineScrollPreviewToggle')
        follow = page.locator('#timelineScrollPreviewFollow')
        expect(follow).to_have_attribute('data-running', 'true')
        sample = follow.evaluate("""canvas => ({head:Number(canvas.dataset.playhead), width:canvas.clientWidth,
            referenceWidth:document.querySelector('#scroll').clientWidth})""")
        self.assertAlmostEqual(sample['head'], (sample['width'] - 16) * min(60 / sample['referenceWidth'], .1), delta=1)
        self.assertEqual(page.locator('input[name=playbackScrollMode]').count(), 2)
        page.click('[data-settings-pane=appearance]')
        expect(preview).to_have_attribute('data-running', 'false')
        page.click('[data-settings-pane=trace]')
        expect(preview).to_have_attribute('data-running', 'true')
        page.click('#settingsCancel')
        expect(preview).to_have_attribute('data-running', 'false')
        expect(page.locator('#playbackScrollMode')).to_have_value('page')
        after = page.evaluate("async () => (await import('/playback.js')).playbackTime()")
        self.assertEqual(after, before, 'The preview must not move the project playhead')
        page.emulate_media(reduced_motion='reduce')
        page.reload()
        page.click('#welcomeSettingsBtn')
        page.click('[data-settings-pane=trace]')
        expect(preview).to_have_attribute('data-running', 'false')
        expect(page.locator('#timelineScrollPreviewToggle')).to_have_text('Play previews')
        page.click('#timelineScrollPreviewToggle')
        expect(preview).to_have_attribute('data-running', 'true')
        page.wait_for_function("Number(document.querySelector('#timelineScrollPreview').dataset.playhead) > 10")
        page.click('#settingsCancel')
        expect(preview).to_have_attribute('data-running', 'false')

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
        page.click("#settingsCancel")
        expect(page.locator("#playbackScrollMode")).to_have_value("page")
        expect(page.locator("#fretboardStringOrder")).to_have_value("low-bottom")
        expect(page.locator("#fretboardAnimations")).to_be_checked()
        page.click("#settingsMenuBtn")
        page.locator("input[name=playbackScrollMode][value=follow]").check()
        page.select_option("#fretboardStringOrder", "low-top")
        page.uncheck("#fretboardAnimations")
        page.click("#settingsApply")
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

    def test_all_marker_artifacts_edit_jump_and_update_live(self):
        self.open_reference_project()
        page = self.page
        page.evaluate("""async () => {
            const {S} = await import('/store.js');
            const lane = S.state.editLanes[0];
            S.state.sectionMarkers = [{id:'section_song', t:4, text:'Verse', sectionType:'verse'}];
            S.state.tempoMap = [{t:12, bpm:120, tsNum:3, tsDen:4, subdiv:2}];
            lane.toneMarkers = [{id:'start', t:0, tone:'lead'}, {id:'tone_song', t:12, tone:'crunch'}];
            lane.phraseBoundaries = [{id:'phrase_song', t:6}];
            const other = {...lane, id:'other', name:'Other guitar', active:false,
                notes:[], refBoxes:{}, toneMarkers:[{id:'tone_other', t:10, tone:'clean'}],
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
        page.locator('#toneMarkerPreset').select_option('bass')
        expect(tone.locator('.artifact-name')).to_have_text('Bass')
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
            S.state.editLanes[0].toneMarkers[1].tone = 'crunch';
            (await import('/repaint.js')).draw();
        }""")
        expect(tone.locator('.artifact-name')).to_have_text('Crunch')
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
