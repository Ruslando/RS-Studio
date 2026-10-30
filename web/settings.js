// App-wide preferences that survive reloads (localStorage), independent of the
// open project. Each setting has one authoritative input (the one feature code
// reads) plus an optional mirror copy in the Settings modal; the two stay in
// lock-step and changes are persisted by the input's id.

import { $ } from "./dom.js";
import { drawFretboard } from "./fretboard.js";
import { PAINT, refreshStagePaint } from "./stage-paint.js";
import { paintBarNumber, paintNoteRow, paintTimeGridLine } from "./timeline-paint.js";
import { EDIT_PALETTE } from "./constants.js";
import { dpr } from "./util.js";
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

// The theme previews show a slice of the editor built from its real parts: the
// toolbar and the note layer section are clones of the live ones, the stage strip
// is painted by the stage's own painters (its colours are the spectral palette,
// which is the same in both themes). The clones live in a closed shadow root with
// the app's stylesheets, so they keep their ids, and with them their real styling,
// without clashing with the app's. Rebuilt whenever the pane shows, so they are the
// current ones; laid out at a fixed natural width and zoomed to fit.
// The sidebar keeps its real 300px; padding and gap are --s-sibling (8px) each.
const STAGE_W = 520, STAGE_H = 150, PREVIEW_W = 300 + STAGE_W + 3 * 8;
const previewRoots = new WeakMap();

function paintPreviewStage(canvas, color) {
  const dp = dpr();
  canvas.width = Math.round(STAGE_W * dp); canvas.height = Math.round(STAGE_H * dp);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dp, 0, 0, dp, 0, 0);
  ctx.fillStyle = PAINT.ground; ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  const half = 15, rowH = 12;
  for (let i = 0; i * half < STAGE_W; i++) paintTimeGridLine(ctx, i * half, 0, STAGE_H, i % 8 ? i % 2 ? 'sub' : 'beat' : 'bar');
  for (const [beat, row, beats] of [[0, 6, 2], [2, 4, 1], [3, 3, 1], [4, 5, 3], [8, 2, 2], [10, 4, 2], [12, 1, 4]])
    paintNoteRow(ctx, beat * 2 * half, 10 + row * rowH, beats * 2 * half, rowH, color);
  for (let bar = 0; bar * 8 * half < STAGE_W; bar++) paintBarNumber(ctx, bar * 8 * half, STAGE_H - 3, String(bar + 1));
  ctx.strokeStyle = PAINT.accent; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(5 * 2 * half, 0); ctx.lineTo(5 * 2 * half, STAGE_H); ctx.stroke();
}

function renderThemePreviews() {
  const active = document.querySelector('#lanes .lane-row.active');
  const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')];
  for (const surface of document.querySelectorAll('.theme-preview-surface')) {
    let root = previewRoots.get(surface);
    if (!root) previewRoots.set(surface, root = surface.attachShadow({ mode: 'closed' }));
    const content = document.createElement('div');
    content.className = 'theme-preview-content';
    content.inert = true;
    content.style.width = PREVIEW_W + 'px';
    content.style.zoom = String(surface.clientWidth / PREVIEW_W);
    const side = document.createElement('aside');
    side.id = 'sidebar';
    side.append($('layersSection').cloneNode(true));
    const stage = document.createElement('canvas');
    stage.className = 'theme-preview-stage';
    stage.style.width = STAGE_W + 'px'; stage.style.height = STAGE_H + 'px';
    const editor = document.createElement('div');
    editor.className = 'theme-preview-editor';
    editor.append(side, stage);
    content.append($('transport').cloneNode(true), editor);
    root.replaceChildren(...sheets.map(link => link.cloneNode()), content);
    paintPreviewStage(stage, active?.querySelector('.lane-dot')?.style.background || EDIT_PALETTE[0]);
  }
}

function init_theme() {
  new ResizeObserver(() => { if (!$('spAppearance').hidden) renderThemePreviews(); }).observe($('spAppearance'));
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
  persistSetting($("traceThreshold"), { mirror: $('quickTraceThreshold') });
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
