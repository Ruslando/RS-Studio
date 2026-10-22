// App-wide preferences that survive reloads (localStorage), independent of the
// open project. Each setting has one authoritative input (the one feature code
// reads) plus an optional mirror copy in the Settings modal; the two stay in
// lock-step and changes are persisted by the input's id.

import { $ } from "./dom.js";
import { drawFretboard } from "./fretboard.js";
import { refreshStagePaint } from "./stage-paint.js";
import { draw } from "./repaint.js";
import { initTimelineScrollPreview, refreshTimelineScrollPreview } from "./timeline-scroll-preview.js";
import { initEditorPreviews, refreshEditorPreviews } from "./editor-previews.js";
import { migrateNoteAppearanceSettings } from "./spectrogram-labels.js";
import { normalizeTraceRange } from './drawing-options.js';

const KEY = "cw.settings";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const store = migrateNoteAppearanceSettings(load());
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode / quota */ } };

const get = (el, bool) => (bool ? el.checked : el.value);
const set = (el, bool, v) => { if (bool) el.checked = !!v; else el.value = v; };

// `main` is read by feature code; `mirror` (if any) just shadows it. The mirror
// dispatches main's native event on change so main's existing handlers run — so
// callers don't need to wire the mirror separately.
function persistSetting(main, { mirror = null, bool = false } = {}) {
  if (!main) return;
  const mirrors = (Array.isArray(mirror) ? mirror : [mirror]).filter(Boolean);
  const key = main.id, evt = bool ? "change" : "input";
  if (key in store) set(main, bool, store[key]);   // silent restore (read before init runs)
  main.addEventListener(evt, () => {
    store[key] = get(main, bool); persist();
    mirrors.forEach((el) => set(el, bool, store[key]));
  });
  mirrors.forEach((el) => {
    set(el, bool, get(main, bool));
    el.addEventListener(evt, () => { set(main, bool, get(el, bool)); main.dispatchEvent(new Event(evt)); });
  });
}

// ---- Light / dark theme ----
// Stored under its own key so the no-FOUC inline script in index.html can apply
// it before the module graph loads. Canvas colours follow the same theme.
const THEME_KEY = "cw.theme";

// Dark is the system default, so the root carries data-theme only for light.
function setTheme(t) {
  const v = t === "light" ? "light" : "dark";
  if (v === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  refreshStagePaint();
  refreshTimelineScrollPreview();
  refreshEditorPreviews();
  draw();
  try { localStorage.setItem(THEME_KEY, v); } catch { /* private mode / quota */ }
  document.querySelectorAll('input[name="theme"]').forEach(radio => { radio.checked = radio.value === v; });
}

function init_theme() {
  // Render the actual launcher components; cloned controls are only an image.
  for (const surface of document.querySelectorAll('.theme-preview-surface')) {
    const content = document.createElement('div');
    content.className = 'theme-preview-content';
    content.inert = true;
    content.setAttribute('aria-hidden', 'true');
    const launcher = document.querySelector('#welcome .welcome-card').cloneNode(true);
    for (const element of launcher.querySelectorAll('[id]')) element.removeAttribute('id');
    content.append(launcher);
    surface.replaceChildren(content);
  }
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.addEventListener("input", () => { if (radio.checked) setTheme(radio.value); });
  }
  // The inline head script already set data-theme; reflect it in the control.
  setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
}

// Restore must happen before the feature inits read these inputs (see main.js).
export function init_settings() {
  if ('traceRange' in store && store.traceRange !== normalizeTraceRange(store.traceRange)) {
    store.traceRange = normalizeTraceRange(store.traceRange); persist();
  }
  persistSetting($("traceSnap"), { mirror: [$("traceSnapM"), $('quickTraceSnap')], bool: true });
  persistSetting($("traceRange"), { mirror: [$("traceRangeM"), $('quickTraceRange')] });
  // The fretboard reads its options straight off the inputs while it draws, the way
  // the voicing engine reads its own preferences — so persisting them and repainting
  // is the whole wiring. These controls live in Editor options.
  persistSetting($("fretboardOnionEnabled"), { bool: true });
  persistSetting($("fretNumbering"));
  persistSetting($("playbackScrollMode"));
  // Migrate the former Off preference to Page. Manual scrolling now suspends
  // following for just the current playback run, independently of this choice.
  const scrollMode = $("playbackScrollMode");
  if (!["page", "follow"].includes(scrollMode.value)) {
    scrollMode.value = "page"; store.playbackScrollMode = "page"; persist();
  }
  const scrollChoices = [...document.querySelectorAll('input[name="playbackScrollMode"]')];
  const syncScrollChoices = () => scrollChoices.forEach(radio => { radio.checked = radio.value === scrollMode.value; });
  syncScrollChoices();
  scrollMode.addEventListener("input", syncScrollChoices);
  for (const radio of scrollChoices) radio.addEventListener("input", () => {
    if (!radio.checked) return;
    scrollMode.value = radio.value; scrollMode.dispatchEvent(new Event("input"));
  });
  initTimelineScrollPreview();
  persistSetting($("fretboardStringOrder"));
  persistSetting($("fretboardAnimations"), { bool: true });
  for (const id of ['spectrogramNoteNames', 'spectrogramPositions', 'spectrogramEffects']) {
    persistSetting($(id));
    $(id).addEventListener('input', () => { refreshEditorPreviews(); draw(); });
  }
  persistSetting($("noteLabelSize"));
  const showNoteSize = () => {
    const input = $("noteLabelSize");
    $("noteLabelSizeValue").textContent = `${input.value} px`;
    input.setAttribute('aria-valuetext', `${input.value} pixels`);
    refreshEditorPreviews(); draw();
  };
  $("noteLabelSize").addEventListener('input', showNoteSize);
  showNoteSize();
  const labelChoices = [...document.querySelectorAll('input[name="fretboardLabels"]')];
  const savedLabels = ["fingers", "notes", "both", "none"].includes(store.fretboardLabels) ? store.fretboardLabels : "both";
  for (const radio of labelChoices) {
    radio.checked = radio.value === savedLabels;
    radio.addEventListener("input", () => {
      if (!radio.checked) return;
      store.fretboardLabels = radio.value; persist(); drawFretboard(); refreshEditorPreviews();
    });
  }
  for (const id of ["playbackScrollMode", "fretboardStringOrder", "fretboardAnimations", "fretNumbering", "fretboardOnionEnabled"]) {
    $(id).addEventListener(["fretboardAnimations", "fretboardOnionEnabled"].includes(id) ? "change" : "input", () => {
      draw(); refreshEditorPreviews();
    });
  }
  for (const id of ["onionAlphaPrev", "onionAlphaNext"]) {
    persistSetting($(id));
    const show = () => {
      $(id + "Value").textContent = `${$(id).value}%`;
      drawFretboard(); refreshEditorPreviews();
    };
    $(id).addEventListener("input", show);
    show();
  }
  initEditorPreviews();
  persist();
  init_theme();
}
