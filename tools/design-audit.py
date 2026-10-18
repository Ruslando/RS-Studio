"""Measure the running app against the design system in docs/design.md.

Opens every screen, window, menu and popover in the engine the desktop window
uses (Edge), reads the computed style of each visible element and reports every
value that is not one of the tokens in web/tokens.css. Writes a screenshot per
screen, a crop per finding and findings.json into design-shots/ (git-ignored).

    .venv/Scripts/python tools/design-audit.py

It prints the number of findings per category. It is a report, not a gate: some
findings are deliberate and are listed as such in docs/design.md.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

from rs_studio import tutorial
from rs_studio.tab import build_gp5

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "design-shots"

MEASURE = r"""
(rootSel) => {
  const root = document.querySelector(rootSel) || document.body;
  const probe = document.createElement('i'); document.body.append(probe);
  const names = new Set();
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules)
    if (rule.style) for (const p of rule.style) if (p.startsWith('--')) names.add(p);
  const colors = new Map(), shadows = new Map();
  for (const n of names) {
    probe.style.color = `var(${n})`; colors.set(getComputedStyle(probe).color, n);
    probe.style.boxShadow = `var(${n})`; shadows.set(getComputedStyle(probe).boxShadow, n);
  }
  probe.style.boxShadow = '0 0 0 2px var(--ring)'; shadows.set(getComputedStyle(probe).boxShadow, 'ring');
  probe.remove();
  shadows.delete('none');
  const num = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  const SIZES = ['small', 'data', 'caption', 'control', 'body', 'heading', 'title'].map((n) => num('--text-' + n));
  const SPACE = [0, 4, 8, 12, 16, 24, 32], RADII = [0, 4, 6, 10], HEIGHTS = [24, 32, 44];
  const clear = (c) => c === 'transparent' || /(, 0\)|\/ 0\))$/.test(c);
  const near = (v, list) => list.some((t) => Math.abs(v - t) < 0.06);
  const sig = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map((c) => '.' + c).join('');
  const out = [], icons = {};
  const add = (el, cat, prop, value, want) => {
    const r = el.getBoundingClientRect();
    const host = el.parentElement && el.parentElement.closest('[id]');
    out.push({ cat, prop, value: String(value), want, el: sig(el), within: host ? '#' + host.id : '',
               key: [cat, prop, value, el.classList.length ? [...el.classList].join('.') : sig(el)].join('|'),
               rect: [r.x, r.y, r.width, r.height] });
  };
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase();
    if (el.closest('#tabRender') || tag === 'canvas' || tag === 'option' || tag === 'script') continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || r.bottom < 0 || r.top > innerHeight) continue;
    if (tag === 'svg') {
      const k = `${Math.round(r.width)}px, stroke ${el.getAttribute('stroke-width') || cs.strokeWidth}`;
      icons[k] = (icons[k] || 0) + 1; continue;
    }
    if (el.closest('svg')) continue;
    const field = ['input', 'select', 'textarea'].includes(tag);
    const inert = tag === 'input' && ['checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(el.type);
    const text = field || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (text && !inert) {
      const px = parseFloat(cs.fontSize);
      if (!near(px, SIZES)) add(el, 'type', 'font-size', px + 'px', 'a --text-* size');
      if (!/Atkinson|IBM Plex Mono/.test(cs.fontFamily.split(',')[0])) add(el, 'type', 'font-family', cs.fontFamily.split(',')[0], '--font-ui / --font-mono');
      if (!['400', '500', '600', '700'].includes(cs.fontWeight)) add(el, 'type', 'font-weight', cs.fontWeight, '400 500 600 700');
      const track = parseFloat(cs.letterSpacing) / px;
      if (track && !near(track, [-.02, -.01, .02])) add(el, 'type', 'letter-spacing', track.toFixed(2) + 'em', '-.02 -.01 .02em');
      if (cs.textTransform !== 'none') add(el, 'type', 'text-transform', cs.textTransform, 'none');
      const lh = parseFloat(cs.lineHeight) / px;
      if (lh && !near(lh, [1, 1.2, 1.4, 1.5])) add(el, 'type', 'line-height', lh.toFixed(2), '1 1.2 1.4 1.5');
      if (!colors.has(cs.color)) add(el, 'color', 'color', cs.color, 'a token');
    }
    for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) {
      const v = cs['border' + corner + 'Radius'], px = parseFloat(v);
      if (v.includes('%') ? px !== 50 : !(near(px, RADII) || px >= 999)) { add(el, 'radius', 'border-radius', v, '0 4 6 10 or a full pill'); break; }
    }
    if (!clear(cs.backgroundColor) && !colors.has(cs.backgroundColor) && el.type !== 'color'
        && !el.matches('.lane-dot, .chip-dot')) add(el, 'color', 'background', cs.backgroundColor, 'a token');
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = parseFloat(cs['border' + side + 'Width']);
      if (!w || cs['border' + side + 'Style'] === 'none') continue;
      if (![1, 2].includes(w)) add(el, 'border', 'border-width', w + 'px', '1 or 2');
      const c = cs['border' + side + 'Color'];
      if (!clear(c) && !colors.has(c)) add(el, 'color', 'border-color', c, 'a token');
      break;
    }
    if (!inert && el.matches('button, select, input, textarea, a[class], [role=button]') && tag !== 'textarea'
        && !near(r.height, HEIGHTS)) add(el, 'height', 'height', Math.round(r.height * 10) / 10 + 'px', '24 32 44');
    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
      const v = parseFloat(cs[prop]);
      if (v && !near(v, SPACE)) { add(el, 'space', prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v + 'px', '4 8 12 16 24 32'); }
    }
    if (cs.boxShadow !== 'none' && !shadows.has(cs.boxShadow)) add(el, 'shadow', 'box-shadow', cs.boxShadow, '--e1 --e2 --e-card or the focus ring');
  }
  return { findings: out, icons };
}
"""


def gp5_song() -> bytes:
    frets = [0, 3, 5, 7, 5, 3, 0, 3]
    notes = [{"start": i * 0.5, "end": i * 0.5 + 0.4, "pitch": 45 + fret, "string": 5, "fret": fret}
             for i, fret in enumerate(frets)]
    track = {"name": "Guitar", "tuning": [64, 59, 55, 50, 45, 40], "capo": 0, "notes": notes}
    grid = {"bpm": 120, "offset": 0.0, "tsNum": 4, "tsDen": 4}
    return build_gp5({"name": "Audit Song", "grid": grid, "resolution": 4, "tracks": [track]})[0]


class Audit:
    def __init__(self, page):
        self.page, self.findings, self.seen, self.icons, self.failed = page, [], set(), {}, []

    def scene(self, name, root="body"):
        page = self.page
        page.wait_for_timeout(350)                       # let the open transition finish
        page.screenshot(path=OUT / f"{name}.png")
        result = page.evaluate(MEASURE, root)
        for key, count in result["icons"].items():
            self.icons[key] = self.icons.get(key, 0) + count
        size = page.viewport_size
        for finding in result["findings"]:
            if finding["key"] in self.seen:
                continue
            self.seen.add(finding["key"])
            x, y, w, h = finding.pop("rect")
            left, top = max(0, x - 16), max(0, y - 16)
            clip = {"x": left, "y": top, "width": max(8, min(size["width"] - left, min(w, 520) + 32)),
                    "height": max(8, min(size["height"] - top, min(h, 200) + 32))}
            finding["scene"], finding["shot"] = name, f"f{len(self.findings):03d}.png"
            page.screenshot(path=OUT / finding["shot"], clip=clip)
            self.findings.append(finding)

    def step(self, name, action):
        """One scene must not end the run: a screen that would not open is reported."""
        try:
            action()
        except Exception as error:                       # noqa: BLE001 - reported, then the next scene
            self.failed.append(f"{name}: {' '.join(str(error).split())[:300]}")
            self.page.keyboard.press("Escape")

    def show(self, selector, name, root=None, at=None):
        """A window with no cheap way in: unhide it where it lives and measure it."""
        self.page.evaluate("""([sel, at]) => { const el = document.querySelector(sel); el.hidden = false;
            if (at) { el.style.left = at[0] + 'px'; el.style.top = at[1] + 'px'; } }""", [selector, at])
        self.scene(name, root or selector)
        self.page.evaluate("(sel) => { const el = document.querySelector(sel); el.hidden = true; el.removeAttribute('style'); }", selector)


def run(page, audit, data, audio):
    step, scene, click = audit.step, audit.scene, page.click

    def dismiss():
        page.mouse.click(700, 37)                        # the project title: inert, and outside every menu

    def settings(prefix):
        for pane in ["appearance", "trace", "tunings", "sounds", "keys", "models", "acceleration"]:
            click(f"[data-settings-pane={pane}]")
            scene(f"{prefix}-settings-{pane}", "#settingsModal")
        click("[data-settings-pane=keys]"); click("#keysTabFixed"); scene(f"{prefix}-settings-keys-fixed", "#settingsModal")
        click("#settingsModalClose")

    def new_project():
        click("#welcomeNew"); scene("new-project-empty", "#newProjModal")
        click("#addStemBtn"); scene("new-project-stem-card", "#newProjModal")
        page.locator("#stemsList .sc-remove").first.click()
        page.fill("#npSongTitle", "Audit Song"); page.fill("#npArtist", "Audit Artist")
        page.set_input_files("#file", audio)
        page.wait_for_timeout(1500); scene("new-project-filled", "#newProjModal")
        click("#go", timeout=60000)
        page.wait_for_selector("#lanes .lane-row", timeout=60000)
        page.wait_for_selector(".project-loading-backdrop", state="detached")   # it takes the clicks while it fades

    def editor():
        stage = page.locator("#stage").bounding_box()
        for dx, dy in [(300, 300), (420, 340), (540, 300), (660, 260)]:
            page.mouse.dblclick(stage["x"] + dx, stage["y"] + dy)
        click("#fretboardToggle") if page.locator("#fretboardPanel[data-collapsed]").count() else None
        page.mouse.click(stage["x"] + 305, stage["y"] + 300)
        scene("editor", "#appshell")
        click("#fileMenuBtn"); scene("menu-file", "#fileMenu"); dismiss()
        page.mouse.click(stage["x"] + 305, stage["y"] + 300, button="right"); scene("context-menu-note", ".ctxmenu:not([hidden])")
        dismiss(); page.keyboard.press("Escape")         # the menu, then the selection
        page.mouse.click(stage["x"] + 800, stage["y"] + 120, button="right"); scene("context-menu-stage", ".ctxmenu:not([hidden])")
        page.get_by_text("Detect notes…").click(); scene("popover-detect", "#detectPanel"); click("#detectClose")
        for pop in ["markerPop", "sectionMarkerPop", "phraseMarkerPop", "toneMarkerPop"]:
            audit.show("#" + pop, "popover-" + pop, at=(500, 260))
        click("#stemTabs .layer-add"); scene("menu-add-audio", ".stem-add-menu"); dismiss()

    def windows():
        page.hover("#lanes .lane-row"); click("#lanes .lane-row .edit-btn"); scene("window-note-layer", "#settingsPanel")
        click("#settingsClose")
        page.hover("#stemTabs .stem-row"); click("#stemTabs .stem-row .stem-btn.edit"); scene("window-audio", "#stemSettingsPanel")
        click("#stemSettingsClose")
        click("#fileMenuBtn"); click("#menuExportRocksmith"); scene("window-rocksmith-export", "#rocksmithExportModal"); click("#rsExportClose")
        click("#fileMenuBtn"); click("#menuProjectSettings"); scene("window-project-details", "#settingsModal"); click("#settingsModalClose")
        click("#fileMenuBtn"); click("#openProjMenu"); scene("window-open-project", "#openProjModal"); click("#openProjClose")
        click("#fileMenuBtn"); click("#menuPreviewTab"); page.wait_for_selector("#tabRender svg", timeout=30000)
        scene("window-tablature", "#tabView"); click("#tabViewClose")
        for box, modal in [("confirmBackdrop", "confirmModal"), ("actionConfirmBackdrop", "actionConfirmModal"), ("pasteBackdrop", "pasteModal"), ("setupBackdrop", "setupModal")]:
            audit.show("#" + box, "window-" + modal, "#" + modal)
        click("#settingsMenuBtn"); settings("editor")
        page.evaluate("""import('./notify.js').then((m) => { m.toast('Saved', 60000, 'ok'); m.toast('Could not read the file', 60000, 'error');
            m.progressToast('Separating audio', 'Bass · htdemucs', () => {}); })""")
        scene("toasts", ".toasts")

    def gp_import():
        with page.expect_file_chooser() as chooser:
            click("#welcomeGp")
        chooser.value.set_files(data / "song.gp5")
        page.wait_for_selector("#gpImportTracks .gp-import-track"); scene("window-gp-import", "#gpImportModal"); click("#gpImportClose")

    def tour():
        click("#welcomeTour"); page.wait_for_selector(".tour-card", timeout=60000); scene("tour-card", ".tour-card")

    scene("welcome-empty", "#welcome")
    step("settings", lambda: (click("#welcomeSettingsBtn"), settings("welcome")))
    step("gp-import", gp_import)
    step("new-project", new_project)
    step("editor", editor)
    step("windows", windows)
    page.reload(); page.wait_for_selector("#welcomeNew")
    scene("welcome-library", "#welcome")
    page.evaluate("localStorage.setItem('cw.theme', 'light')"); page.reload(); page.wait_for_selector("#welcomeNew")
    scene("light-welcome", "#welcome")
    step("light-settings", lambda: (click("#welcomeSettingsBtn"), settings("light")))
    step("light-new-project", lambda: (click("#welcomeNew"), scene("light-new-project", "#newProjModal"), click("#npClose")))

    def light_editor():
        page.locator("#recentList .ri-open").first.click(); page.wait_for_selector("#lanes .lane-row", timeout=60000)
        scene("light-editor", "#appshell")
        page.hover("#lanes .lane-row"); click("#lanes .lane-row .edit-btn"); scene("light-window-note-layer", "#settingsPanel"); click("#settingsClose")
        click("#fileMenuBtn"); scene("light-menu-file", "#fileMenu"); dismiss()
    step("light-editor", light_editor)
    page.evaluate("localStorage.setItem('cw.theme', 'dark')"); page.reload(); page.wait_for_selector("#welcomeNew")
    step("tour", tour)


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    data = Path(tempfile.mkdtemp(prefix="rs-design-"))
    (data / "song.gp5").write_bytes(gp5_song())
    audio = tutorial.write_audio(data / "audio")["bass"]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    url = f"http://127.0.0.1:{port}/"
    log = open(data / "server.log", "w", encoding="utf-8")
    server = subprocess.Popen([sys.executable, "-m", "rs_studio", "serve", "--port", str(port)],
                              env={**os.environ, "RS_STUDIO_DATA_ROOT": str(data)}, stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 120
        while True:
            try:
                urllib.request.urlopen(url, timeout=1).close()
                break
            except OSError:
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("The server did not start: see " + str(data / "server.log"))
                time.sleep(0.2)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge")
            page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
            page.set_default_timeout(15000)
            page.goto(url)
            page.wait_for_selector("#welcomeNew")
            audit = Audit(page)
            run(page, audit, data, audio)
            browser.close()
    finally:
        server.terminate()
        server.wait(10)
        log.close()
        shutil.rmtree(data, ignore_errors=True)
    (OUT / "findings.json").write_text(json.dumps(
        {"findings": audit.findings, "icons": audit.icons, "failed": audit.failed}, indent=1), encoding="utf-8")
    counts = {}
    for finding in audit.findings:
        counts[finding["cat"]] = counts.get(finding["cat"], 0) + 1
    print(f"{len(audit.findings)} findings in {OUT}:", ", ".join(f"{cat} {n}" for cat, n in sorted(counts.items())))
    for failure in audit.failed:
        print("could not open:", failure)


if __name__ == "__main__":
    main()
