import { closeMenus, wireMenuAnchors } from "./menus.js";
export { wireMenuAnchors } from "./menus.js";
import { panelControls, syncPanelControls } from "./canvas-controls.js";
import { icon } from "./icons.js";
// Top-level chrome: the File/Edit/View menu bar, toolbar view switch, and the
// floating (non-modal) Settings panel.

import { ZOOM_STEP } from "./constants.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { $, inTourCard, stage } from "./dom.js";
import { draw } from "./repaint.js";
import { refreshEditorPreviews } from "./editor-previews.js";
import { initCollapsibleSections } from './collapsible-sections.js';
import { setTimelineScrollPreviewVisible } from "./timeline-scroll-preview.js";
import { doCopy, doCut, doDelete, doPaste, redo, undo, updateUndoButtons } from "./edit.js";
import { resetZoom, zoomCenter } from "./geometry.js";
import { FIXED_SHORTCUTS, KEY_COMMANDS, conflictOf, eventKey, keyOf, keySnapshot, resetKeys, restoreKeys, setKey, shortcutTitle } from "./keymap.js";
import { renderLayerSettings } from "./lanes.js";
import { beginTuningDraft, dropTuningDraft, saveTuningDraft, tuningDraftOpen, tuningDraftDirty } from "./tuning-editor.js";
import { beginSoundDraft, dropSoundDraft, saveSoundDraft, selectToneSound, soundDraftDirty } from "./sound-designer.js";
import { railScale, railsHidden, setRailScale, setRailsHidden } from "./marker-rails.js";
import { panelMotion } from "./panel-motion.js";
import { applyCoverChange, clearProjectCover, coverStatus, latinFields, metadataPayload, normalizeMetadata, uploadDroppedProjectCover, uploadProjectCover } from "./metadata.js";
import { refreshSaveState, setTuning } from "./project.js";
import { renderModels, stopModelPolling } from "./models.js";
import { S } from "./store.js";
import { exportRocksmith } from "./rocksmith-export.js";
import { exportModernGp, exportTab, setView } from "./tablature.js";
import { runFindSimilar } from "./tracing.js";

// ---- spectrogram drag mode ----
// Empty-space drag pans; Ctrl/Cmd draws and Shift/Alt retain selection gestures.
export const TOOL_CURSOR = { pan: "grab", select: "default", trace: "crosshair", marquee: "crosshair", frame: "col-resize" };

function setTool(tool) {
  S.toolMode = tool;
  if (stage) stage.style.cursor = TOOL_CURSOR[tool] || "default";
  draw();
}

// ---- menu bar (File / Edit / View) ----
export const menubarEl = $("menubar");

export const wireMenu = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };

// (The top-level Stem menu was removed — stem solo/mute live on the per-stem
// S/M buttons in the sidebar; Add stem is the "+ Add stem" button there.)

// ---- Settings: two context-sensitive surfaces ----
// 1. Layer modal (#settingsPanel): centered overlay. Opened by a layer's edit button.
// 2. Settings modal (#settingsModal): centered window from the menu-bar Settings
//    dropdown (Trace for now; more sections will swap into its body later).
export const layerSettingsBackdrop = $("layerSettingsBackdrop"), settingsClose = $("settingsClose");
export const settingsModalBackdrop = $("settingsModalBackdrop"), settingsModalClose = $("settingsModalClose");

export const layerName = $("layerName"), layerColor = $("layerColor");

export const layerInstr = $("layerInstr"), layerTun = $("layerTun"), layerCapo = $("layerCapo"), layerArrangement = $("layerArrangement"), layerOwnTiming = $("layerOwnTiming"), layerScrollSpeed = $("layerScrollSpeed");
export const spLayerName = $("spLayerName");

export const layerVolume = $("layerVolume"), layerVolumeValue = $("layerVolumeValue");

export const layerDeleteBtn = $("layerDelete");

// Staged the same way the settings modal is: the layer's fields repaint the
// stage as you touch them, so Cancel walks them back rather than deferring them.
let layerSnapshot = null;
let layerActions = null;
export function openLayerSettings(actions = null) {
  layerActions = actions;
  $("layerSave").textContent = actions ? "Create" : "Apply";
  $("settingsPanel").setAttribute("aria-label", actions ? "Add note layer" : "Edit note layer");
  renderLayerSettings();
  layerSettingsBackdrop.hidden = false;
  layerSnapshot = snapshotInputs($("settingsPanel"));
  syncLayerActions();
}
const inputsDirty = snapshot => (snapshot || []).some(({ el, v }) =>
  (["checkbox", "radio"].includes(el.type) ? el.checked : el.value) !== v);
function syncLayerActions() { $("layerSave").hidden = !layerActions && !inputsDirty(layerSnapshot); }

export function closeLayerSettings() {
  const actions = layerActions;
  layerActions = null; layerSnapshot = null; layerSettingsBackdrop.hidden = true;
  actions?.save();
}
export function cancelLayerSettings() {
  revertInputs(layerSnapshot); layerSnapshot = null;
  layerSettingsBackdrop.hidden = true;
  const actions = layerActions;
  layerActions = null;
  actions?.cancel();
}

// Tunings live in Settings. A layer's "Manage tunings…" opens that page with the
// layer's tuning selected.
export function openTuningManager(selectKey) { openSettingsModal("tunings", selectKey); }

// One modal, panes swapped by `section` ("trace" | "project" | "keys" | "appearance" | "models").
const SP_TITLES = { trace: "Editor options", project: "Project details", keys: "Keyboard shortcuts", appearance: "Appearance", models: "Models", tunings: "Tunings" };
// Rule 20: the primary names the work. A settings window applies; an editor saves.
let spSection = "trace";

// Rule 17: the scrim is a promise that nothing has changed yet. These panes all
// applied live — theme and trace threshold repaint as you touch
// them, which is the only way to judge them — so staging here is a snapshot on
// open and a revert on Cancel, not a deferred write. Escape, Cancel, the close
// and a backdrop click are all the same key, and all four take this path.
// The Tunings page keeps its own draft (tuning-editor.js), so it stays out of this.
const snapshotInputs = (root) => [...root.querySelectorAll("input, select")]
  .filter((el) => !el.closest("[hidden]") && !el.closest("#spTunings, #spSounds, #soundGearDialog, #soundFileActions, #spModels"))
  .map((el) => ({ el, v: ["checkbox", "radio"].includes(el.type) ? el.checked : el.value }));

// Put each value back and re-fire the event that applied it, so persistence and
// live preview walk backwards together — no second code path to keep in sync.
function revertInputs(snap) {
  for (const { el, v } of snap || []) {
    const checked = ["checkbox", "radio"].includes(el.type);
    if ((checked ? el.checked : el.value) === v) continue;
    if (checked) el.checked = v; else el.value = v;
    for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

let spSnapshot = null;
function snapshotSettings() {
  const elements = new Set([...(spSnapshot?.inputs || []).map(({ el }) => el),
    ...snapshotInputs($("settingsModal")).map(({ el }) => el)]);
  spSnapshot = { keys: keySnapshot(), inputs: [...elements].map(el => ({ el,
    v: ["checkbox", "radio"].includes(el.type) ? el.checked : el.value })) };
  syncSettingsActions();
}
function syncSettingsActions() {
  const keys = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const dirty = !!spSnapshot && (inputsDirty(spSnapshot.inputs) || keys(keySnapshot()) !== keys(spSnapshot.keys)
    || soundDraftDirty() || tuningDraftDirty());
  $("settingsApply").textContent = "Apply";
  $("settingsApply").hidden = !dirty || spSection === "models";
  const footer = $("settingsApply").closest(".dialog-footer");
  footer.hidden = $("settingsApply").hidden && $("keymapReset").hidden;
}
function revertSettings() {
  if (!spSnapshot) return;
  revertInputs(spSnapshot.inputs);
  restoreKeys(spSnapshot.keys);
  spSnapshot = null;
}

function showSettingsPane(section) {
  if (spSection === "models" && section !== "models") stopModelPolling();
  spSection = section;
  $("spTempo").hidden = true;
  $("spTrace").hidden = section !== "trace";
  $("spProject").hidden = section !== "project";
  $("spKeys").hidden = section !== "keys";
  $("spAppearance").hidden = section !== "appearance";
  $("spModels").hidden = section !== "models";
  $("spTunings").hidden = section !== "tunings";
  $("spSounds").hidden = section !== "sounds";
  $("settingsModalTitle").textContent = section === "project" ? SP_TITLES.project : "Settings";
  $("settingsApply").textContent = "Apply";
  $("settingsApply").disabled = false;   // renderProjectSettings disables it with no project open
  $("keymapReset").hidden = section !== "keys";
  // Rule 18: 720 only because the body carries repeating rows — the shortcut
  // table, and the model list, whose rows need name, state and size on one line.
  $("settingsModal").classList.toggle("settings-window", section !== "project");
  $("settingsNav").hidden = section === "project";
  document.querySelectorAll("[data-settings-pane]").forEach((button) => {
    const selected = button.dataset.settingsPane === section;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  if (section === "project") renderProjectSettings();
  if (section === "models") renderModels();
  if (section === "tunings" && !tuningDraftOpen()) beginTuningDraft(tuningSelect);
  if (section === "sounds") beginSoundDraft();
  if (section === "keys") { setKeyTab("edit"); renderKeymap(); }
  if (section === "trace") refreshEditorPreviews();
  setTimelineScrollPreviewVisible(section === "trace" && !$("spectrogramSettings").hasAttribute('data-collapsed'));
  syncSettingsActions();
}

let tuningSelect = null;   // the tuning the Tunings page opens on
export function openSettingsModal(section = "trace", selectTuning = null) {
  dropTuningDraft();
  dropSoundDraft();
  tuningSelect = selectTuning;
  showSettingsPane(section);
  settingsModalBackdrop.hidden = false;
  snapshotSettings();
}

function switchSettingsPane(section) {
  showSettingsPane(section);
  // Capture each pane on its first visit. Returning to a pane must keep its
  // original values so Cancel restores changes across the whole window.
  const seen = new Set(spSnapshot.inputs.map(({ el }) => el));
  spSnapshot.inputs.push(...snapshotInputs($("settingsModal")).filter(({ el }) => !seen.has(el)));
  syncSettingsActions();
}

// Toggle the two sub-tabs of the keyboard pane (Editable / Fixed).
function setKeyTab(name) {
  $("keysPaneEdit").hidden = name !== "edit";
  $("keysPaneFixed").hidden = name !== "fixed";
  document.querySelectorAll("#spKeys .keymap-tab").forEach((b) => {
    const active = b.dataset.keytab === name;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
  });
}

// Closing stops the Models poll: a closed window that keeps asking the server
// every second is a window that never actually closed.
function cancelSettingsModal() { revertSettings(); dropTuningDraft(); dropSoundDraft(); stopModelPolling(); setTimelineScrollPreviewVisible(false); settingsModalBackdrop.hidden = true; }
// Project details is the one pane whose values live on the server, so its
// primary is the only one that has work left to do when it is pressed.
async function applySettingsModal() {
  if (spSection === "project") { saveProjectSettings(); return; }
  if (!(await saveTuningDraft({ keepOpen: true }))) return;   // an unsaved built-in edit made them stay
  if (!saveSoundDraft()) { showSettingsPane("sounds"); return; }
  snapshotSettings();
}

function projectSettingsMeta() {
  if (!S.state) return normalizeMetadata({});
  S.state.metadata = normalizeMetadata(S.state.metadata || {});
  return S.state.metadata;
}

const projLatin = latinFields({ title: "projTitle", artist: "projArtist", album: "projAlbum" });

function collectProjectSettingsMeta() {
  const meta = normalizeMetadata(projectSettingsMeta());
  meta.title = ($("projTitle").value || "").trim();
  meta.artist = ($("projArtist").value || "").trim();
  meta.album = ($("projAlbum").value || "").trim();
  meta.year = ($("projYear").value || "").trim();
  return projLatin.read(meta);
}

function setProjectMetaStatus(msg, error = false) {
  const el = $("projMetaStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
  // Status is an 8px dot, never coloured text — the class draws it.
  el.classList.toggle("error", error);
}

function renderProjectCover(meta) {
  const thumb = $("projCoverThumb"), title = $("projCoverTitle"), sub = $("projCoverSub"), clear = $("projCoverClear");
  const has = !!meta.coverArtUrl;
  thumb.classList.toggle("has-cover", has);
  thumb.replaceChildren();
  // .src takes a URL, so an image whose name or address contains quotes or
  // angle brackets can't close the attribute and inject markup.
  if (has) { const img = document.createElement("img"); img.src = meta.coverArtUrl; img.alt = ""; thumb.append(img); }
  title.textContent = has ? (meta.coverArtName || "Cover art") : "Choose image";
  sub.textContent = "";   // rule 24: optional is silent; the title carries the name
  clear.hidden = !has;
}

// Concert pitch: cents from A440 <-> the A4 frequency the field shows.
const hzOf = (cents) => 440 * 2 ** (cents / 1200);
const centsOf = (hz) => Math.round(1200 * Math.log2(hz / 440) * 10) / 10;
const signed = (cents) => { const c = Math.round(cents); return `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c)} ct`; };
const hzText = (cents) => hzOf(cents).toFixed(1);
const pitchText = (cents) => `A4 = ${hzText(cents)} Hz (${signed(cents)})`;

// The field shows 0.1 Hz, coarser than the stored cents: an untouched field keeps
// the stored value instead of its rounded reading.
function readTuningFields() {
  const field = $("projTuningRef").value, hz = parseFloat(field), stored = S.state?.tuning?.reference || 0;
  const reference = field === hzText(stored) ? stored
    : Number.isFinite(hz) ? Math.max(-50, Math.min(50, centsOf(hz))) : stored;
  return { reference, shift: Number($("projTuningShift").value) || 0 };
}

function renderTuningNotes() {
  const tuning = S.state?.tuning || { estimate: null, reference: 0, shift: 0 };
  const { reference, shift } = readTuningFields();
  const hasAudio = !!S.state?.stems?.length;
  $("projTuningShiftValue").textContent = signed(shift);
  $("projTuningDetected").textContent = !hasAudio ? "No audio in this project."
    : tuning.estimate == null ? "Not measured yet." : `Detected: ${pitchText(tuning.estimate)}`;
  $("projTuningUse").hidden = tuning.estimate == null || $("projTuningRef").value === hzText(tuning.estimate);
  $("projTuningMeasure").hidden = !hasAudio || tuning.estimate != null;
  $("projTuningTo440").hidden = Math.abs(reference + shift) < 0.5;
  $("projTuningExport").textContent = hasAudio ? `Plays and exports at ${pitchText(reference + shift)}` : "";
}

function fillTuningFields() {
  const tuning = S.state?.tuning || { reference: 0, shift: 0 };
  $("projTuningRef").value = hzText(tuning.reference);
  $("projTuningShift").value = String(Math.round(tuning.shift));
  renderTuningNotes();
}

// Set a field the way typing would, so Apply and Cancel see the change.
function setTuningField(id, value) {
  $(id).value = value;
  $(id).dispatchEvent(new Event("input", { bubbles: true }));
}

async function measureTuning() {
  if (!S.state) return;
  $("projTuningMeasure").disabled = true;
  setProjectMetaStatus("Measuring...");
  try {
    await setTuning({ measure: true });   // only the estimate changes; the fields keep what is typed
    setProjectMetaStatus("");
    renderTuningNotes();
  } catch (err) {
    setProjectMetaStatus(err.message, true);
  } finally {
    $("projTuningMeasure").disabled = false;
  }
}

function renderProjectSettings() {
  const on = !!S.state && S.state.job !== "tutorial";
  const meta = projectSettingsMeta();
  $("projTitle").value = meta.title || (S.state && (S.state.name || S.state.filename)) || "";
  $("projArtist").value = meta.artist || "";
  $("projAlbum").value = meta.album || "";
  $("projYear").value = meta.year || "";
  renderProjectCover(meta);
  fillTuningFields();
  for (const id of ["projTitle", "projArtist", "projAlbum", "projYear", "projCoverDrop", "settingsApply"])
    if ($(id)) $(id).disabled = !on;
  const tunable = on && !!S.state?.stems?.length;
  for (const id of ["projTuningRef", "projTuningShift", "projTuningUse", "projTuningMeasure", "projTuningTo440"])
    $(id).disabled = !tunable;
  projLatin.fill(meta);
  $("projCoverDrop").setAttribute("aria-disabled", String(!on));
  $("projCoverDrop").tabIndex = on ? 0 : -1;
  $("projCoverClear").disabled = !on;
  setProjectMetaStatus("");
}

async function saveProjectSettings() {
  if (!S.state || S.state.job === "tutorial") return;
  const meta = collectProjectSettingsMeta();
  if (!meta.title || !meta.artist) { setProjectMetaStatus("Enter a song title and an artist.", true); return; }
  S.state.metadata = meta;
  setProjectMetaStatus("Saving...");
  try {
    const res = await fetch(`/api/projects/${S.state.job}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: metadataPayload(meta) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "save failed");
    refreshSaveState();   // the project is named after these details
    const tuning = readTuningFields();
    if (S.state.stems.length && (Math.abs(tuning.reference - S.state.tuning.reference) >= 0.1 || tuning.shift !== S.state.tuning.shift)) {
      setProjectMetaStatus(tuning.shift !== S.state.tuning.shift ? "Shifting audio..." : "Saving...");
      await setTuning(tuning);
      fillTuningFields();
    }
    setProjectMetaStatus("Saved");
    snapshotSettings();
  } catch (err) {
    setProjectMetaStatus(err.message, true);
  }
}

async function changeProjectSettingsCover(run, working, done) {
  if (!S.state || S.state.job === "tutorial") return;
  const meta = await applyCoverChange(collectProjectSettingsMeta(), run, coverStatus($("projCoverDrop"), setProjectMetaStatus), working, done);
  if (!meta) return;
  S.state.metadata = meta;
  renderProjectSettings();
}

const uploadProjectSettingsCover = (file) => file && changeProjectSettingsCover(
  () => uploadProjectCover(S.state.job, file), "Uploading cover art...", "Cover art uploaded");
const uploadProjectSettingsCoverFromDrop = (dataTransfer) => changeProjectSettingsCover(
  () => uploadDroppedProjectCover(S.state.job, dataTransfer), "Uploading cover art...", "Cover art uploaded");
const clearProjectSettingsCover = () => changeProjectSettingsCover(
  () => clearProjectCover(S.state.job), "Removing cover art...", "Cover art removed");

// One row per remappable command: its label + a button showing the bound key.
// Clicking the button captures the next keypress (Esc cancels); a key already in
// use is rejected with an inline note rather than silently stealing the binding.
let keyCapture = null;   // { id } while waiting for the next keypress
function renderKeymap() {
  const list = $("keymapList");
  list.replaceChildren(...KEY_COMMANDS.map((c) => {
    const row = document.createElement("div");
    row.className = "keymap-row";
    row.dataset.command = c.id;
    const name = document.createElement("span");
    name.className = "keymap-name"; name.textContent = c.label;
    const btn = document.createElement("button");
    btn.className = "keymap-key" + (keyCapture && keyCapture.id === c.id ? " capturing" : "");
    // The paragraph that said this is gone (rule 24); the sentence belongs to
    // the control it is about, and the control is the chip you click.
    btn.title = "Click, then press the new key";
    btn.setAttribute('aria-label', `Bind ${c.label}`);
    btn.textContent = keyCapture && keyCapture.id === c.id ? "press a key…" : keyOf(c.id) || "Unassigned";
    btn.addEventListener("click", () => { keyCapture = { id: c.id }; renderKeymap(); });
    const controls = document.createElement('span'); controls.className = 'keymap-actions';
    controls.append(btn);
    const clear = document.createElement('button'); clear.type = 'button';
    clear.className = 'icon-btn icon-btn--compact'; clear.innerHTML = icon('close', 12);
    clear.title = 'Remove shortcut'; clear.setAttribute('aria-label', `Unbind ${c.label}`);
    clear.disabled = !keyOf(c.id);
    clear.addEventListener('click', () => { keyCapture = null; setKey(c.id, null); renderKeymap(); });
    controls.append(clear); row.append(name, controls);
    return row;
  }));
  $("keymapFixed").replaceChildren(...FIXED_SHORTCUTS.map((f) => {
    const row = document.createElement("div");
    row.className = "keymap-row";
    const name = document.createElement("span");
    name.className = "keymap-name"; name.textContent = f.label;
    const key = document.createElement("span");
    key.className = "keymap-key keymap-fixed-key"; key.textContent = f.keys;
    row.append(name, key);
    return row;
  }));
  syncSettingsActions();
}

// Active only while a row is in capture mode; runs at capture phase so the
// pressed key rebinds instead of firing its old action.
function captureKey(e) {
  if (!keyCapture) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === "Escape") { keyCapture = null; renderKeymap(); return; }
  if (/^(Shift|Control|Alt|Meta)$/.test(e.key)) return;   // wait for a real key
  const key = eventKey(e), id = keyCapture.id;
  const clash = conflictOf(key, id);
  keyCapture = null;
  if (clash) { renderKeymap(); $("keymapList").querySelector(".keymap-row").scrollIntoView({ block: "nearest" }); toastKeyClash(clash.label, key); return; }
  setKey(id, key); renderKeymap();
}

function toastKeyClash(label, key) {
  let n = $("keymapNote");
  if (!n) { n = document.createElement("p"); n.id = "keymapNote"; n.className = "sp-note keymap-clash"; $("spKeys").append(n); }
  n.textContent = `“${key}” is already used by ${label}.`;
}

// The marker layer has two ways in — the View menu item and the chevron on the
// stage — so both go through here and the check, the chevron and the canvas
// cannot disagree. The menu item carries no label of its own state: a toggled
// item shows an accent check in the shortcut column, which is the whole readout.
// The chevron does name its action, because a mark on a canvas has no other way
// to say which direction it goes.
function setMarkerLanes(hidden) {
  const from = railScale();
  setRailsHidden(hidden);
  revealRails(from);
  $("menuMarkerLanesCheck").hidden = hidden;
  const label = hidden ? "Show marker lanes" : "Hide marker lanes";
  syncPanelControls("markers", !hidden, label);
  draw();
}

// Reveal the complete stack like the other panels. Reversing mid-gesture starts
// from its current extent; reduced motion settles immediately.
let railFrame = 0;
function revealRails(from) {
  cancelAnimationFrame(railFrame);
  const to = railScale();
  if (from === to) return;
  const { duration: dur, ease } = panelMotion();
  const t0 = performance.now();
  const step = () => {
    const k = dur > 0 ? Math.min(1, (performance.now() - t0) / dur) : 1;
    const eased = ease(k);
    setRailScale(from + (to - from) * eased);
    draw();
    if (k < 1) railFrame = requestAnimationFrame(step);
  };
  step();
}

// Label of the current grid subdivision (e.g. "1/8", "1/16T", "5/beat").
export function gridDivLabelFor(value) {
  const v = String(value);
  const labels = { "1": "1/4", "2": "1/8", "3": "1/8T", "4": "1/16", "6": "1/16T", "8": "1/32" };
  return labels[v] || `${parseInt(v, 10) || 1}/beat`;
}

// Keep the toolbar's read-only tempo/meter/grid readout in sync with grid state.
export function init_ui() {
  // Live editors keep playback usable: blank space releases field focus, and
  // the large field labels must not activate an input through their default click.
  const liveEditorControl = 'input, select, textarea, button, a, [contenteditable], [role="button"], [role="checkbox"], [role="radio"]';
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest(liveEditorControl)) return;
    const labelControl = event.target.closest('label')?.control;
    if (labelControl?.matches('input[type="checkbox"], input[type="radio"]')) return;
    const active = document.activeElement;
    if (active?.closest('.live-editor')) active.blur();
  }, true);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.live-editor') || event.target.closest(liveEditorControl)) return;
    const control = event.target.closest('label')?.control;
    if (control?.matches('input:not([type="checkbox"]):not([type="radio"]), select, textarea')) {
      event.preventDefault();
    }
  }, true);
  const syncShortcutHints = () => {
    for (const [id, command, label] of [
      ['zoomIn', 'zoomIn', 'Zoom in'], ['zoomOut', 'zoomOut', 'Zoom out'],
      ['zoomReset', 'resetZoom', 'Reset zoom'], ['menuZoomReset', 'resetZoom', 'Reset zoom'],
      ['menuDelete', 'delete', 'Delete selection'],
    ]) $(id).title = shortcutTitle(label, command);
    $('menuZoomIn').querySelector('.kbd').textContent = keyOf('zoomIn') || '';
    $('menuZoomOut').querySelector('.kbd').textContent = keyOf('zoomOut') || '';
    $('menuZoomReset').querySelector('.kbd').textContent = keyOf('resetZoom') || '';
    $('menuDelete').querySelector('.kbd').textContent = keyOf('delete') || '';
    for (const control of document.querySelectorAll('[data-panel-toggle]')) {
      const id = { sidebar: 'sidebar', artifacts: 'artifacts', markers: 'markerLanes', fretboard: 'fretboard' }[control.dataset.panelToggle];
      if (id) control.title = shortcutTitle(control.getAttribute('aria-label'), id);
    }
  };
  window.addEventListener('cw-keymap-changed', syncShortcutHints);
  syncShortcutHints();
  initCollapsibleSections($("spTrace"), 'rs-studio.editor-sections.collapsed', () => {
    refreshEditorPreviews();
    setTimelineScrollPreviewVisible(!$("spTrace").hidden && !$("spectrogramSettings").hasAttribute('data-collapsed'));
  });
  window.addEventListener('cw-open-tone-designer', event => {
    if (settingsModalBackdrop.hidden) openSettingsModal('sounds'); else switchSettingsPane('sounds');
    selectToneSound(event.detail.laneId, event.detail.markerId);
  });
  for (const slot of document.querySelectorAll('[data-ui-icon]')) {
    slot.innerHTML = icon(slot.dataset.uiIcon, Number(slot.dataset.iconSize) || 16);
  }
  // A number field marked data-stepper gets its up/down pair (design.md 4.3). The
  // field's own min, max and step decide what a press does.
  for (const input of document.querySelectorAll('.stepper input[data-stepper]')) {
    const nudge = document.createElement('span');
    nudge.className = 'stepper-nudge';
    for (const [name, title, up] of [['chevronUp', 'Increase', true], ['chevronDown', 'Decrease', false]]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'stepper-btn'; button.tabIndex = -1;   // arrow keys already step the field
      button.title = title; button.setAttribute('aria-label', title); button.innerHTML = icon(name, 12);
      button.addEventListener('click', () => {
        if (up) input.stepUp(); else input.stepDown();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      nudge.append(button);
    }
    input.closest('.stepper').append(nudge);
  }
  document.querySelector('#spKeys .keymap-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const name = event.key === 'Home' ? 'edit' : event.key === 'End' ? 'fixed' :
      $("keysPaneEdit").hidden ? 'edit' : 'fixed';
    setKeyTab(name);
    document.querySelector(`[data-keytab="${name}"]`).focus();
  });
  document.querySelectorAll("[data-settings-pane]").forEach((button) =>
    button.addEventListener("click", () => switchSettingsPane(button.dataset.settingsPane)));

  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (settingsModalBackdrop.hidden) return false;
    cancelSettingsModal(); return true;   // rule 17: Escape and Cancel are the same key
  });
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (layerSettingsBackdrop.hidden) return false;
    cancelLayerSettings(); return true;
  });
  setTool("pan");
  wireMenuAnchors(menubarEl, updateUndoButtons);
  $("settingsMenuBtn").addEventListener("click", () => openSettingsModal("trace"));
  $("welcomeSettingsBtn").addEventListener("click", () => openSettingsModal("appearance"));
  wireMenuAnchors($("welcome"), updateUndoButtons);
  document.addEventListener("click", (e) => {
    if (!inTourCard(e.target) && !e.target.closest(".menu-anchor")) closeMenus();
  });
  wireMenu("menuPreviewTab", () => setView("tab"));
  wireMenu("menuExportModernGp", exportModernGp);
  wireMenu("menuExportTab", exportTab);
  wireMenu("menuExportRocksmith", exportRocksmith);
  wireMenu("menuUndo", undo);
  wireMenu("menuRedo", redo);
  wireMenu("menuCut", doCut);
  wireMenu("menuCopy", doCopy);
  wireMenu("menuPaste", () => doPaste());
  wireMenu("menuDelete", doDelete);
  wireMenu("menuFindSimilar", runFindSimilar);
  wireMenu("menuZoomIn", () => zoomCenter("x", ZOOM_STEP));
  wireMenu("menuZoomOut", () => zoomCenter("x", 1 / ZOOM_STEP));
  wireMenu("menuZoomReset", resetZoom);
  wireMenu("menuMarkerLanes", () => setMarkerLanes(!railsHidden()));
  for (const button of panelControls("markers")) button.addEventListener("click", () => setMarkerLanes(!railsHidden()));
  settingsClose.addEventListener("click", cancelLayerSettings);
  $("layerSave").addEventListener("click", () => {
    if (layerActions) { closeLayerSettings(); return; }
    layerSnapshot = snapshotInputs($("settingsPanel")); syncLayerActions();
  });
  settingsModalClose.addEventListener("click", cancelSettingsModal);
  $("settingsApply").addEventListener("click", applySettingsModal);
  for (const type of ["input", "change", "click"]) {
    $("settingsModal").addEventListener(type, () => queueMicrotask(syncSettingsActions));
    $("settingsPanel").addEventListener(type, () => queueMicrotask(syncLayerActions));
  }
  window.addEventListener("settings-draft-changed", syncSettingsActions);
  wireMenu("menuTraceSettings", () => openSettingsModal("trace"));
  wireMenu("menuProjectSettings", () => openSettingsModal("project"));
  wireMenu("menuKeySettings", () => openSettingsModal("keys"));
  wireMenu("menuAppearance", () => openSettingsModal("appearance"));
  wireMenu("menuModels", () => openSettingsModal("models"));
  $("projCoverDrop").addEventListener("click", (e) => {
    if (S.state?.job !== "tutorial" && !e.target.closest(".cover-clear")) $("projCoverInput").click();
  });
  $("projCoverDrop").addEventListener("keydown", (e) => {
    if (S.state?.job === "tutorial") return;
    if (e.target.closest(".cover-clear")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("projCoverInput").click(); }
  });
  $("projCoverInput").addEventListener("change", () => {
    if ($("projCoverInput").files[0]) uploadProjectSettingsCover($("projCoverInput").files[0]);
    $("projCoverInput").value = "";
  });
  $("projCoverClear").addEventListener("click", (e) => { e.stopPropagation(); clearProjectSettingsCover(); });
  for (const id of ["projTuningRef", "projTuningShift"]) $(id).addEventListener("input", renderTuningNotes);
  $("projTuningUse").addEventListener("click", () => setTuningField("projTuningRef", hzText(S.state.tuning.estimate)));
  $("projTuningTo440").addEventListener("click", () =>
    setTuningField("projTuningShift", String(Math.max(-50, Math.min(50, Math.round(-readTuningFields().reference))))));
  $("projTuningMeasure").addEventListener("click", measureTuning);
  ["dragenter", "dragover"].forEach((ev) => $("projCoverDrop").addEventListener(ev, (e) => {
    e.preventDefault();
    if (S.state?.job !== "tutorial") $("projCoverDrop").classList.add("drag");
  }));
  ["dragleave", "drop"].forEach((ev) => $("projCoverDrop").addEventListener(ev, (e) => { e.preventDefault(); $("projCoverDrop").classList.remove("drag"); }));
  $("projCoverDrop").addEventListener("drop", (e) => {
    if (S.state?.job !== "tutorial") uploadProjectSettingsCoverFromDrop(e.dataTransfer);
  });
  $("keymapReset").addEventListener("click", () => { resetKeys(); renderKeymap(); });
  document.querySelectorAll("#spKeys .keymap-tab").forEach((b) =>
    b.addEventListener("click", () => setKeyTab(b.dataset.keytab)));
  window.addEventListener("keydown", captureKey, true);   // capture phase: rebinds before the key fires its action
}
