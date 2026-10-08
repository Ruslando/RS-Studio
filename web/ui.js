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
import { doCopy, doCut, doDelete, doPaste, redo, undo, updateUndoButtons } from "./edit.js";
import { resetZoom, zoomCenter } from "./geometry.js";
import { FIXED_SHORTCUTS, KEY_COMMANDS, conflictOf, eventKey, keyOf, keySnapshot, resetKeys, restoreKeys, setKey } from "./keymap.js";
import { renderLayerSettings, renderTuningManager } from "./lanes.js";
import { railScale, railsHidden, setRailScale, setRailsHidden } from "./marker-rails.js";
import { panelMotion } from "./panel-motion.js";
import { applyCoverChange, clearProjectCover, metadataPayload, normalizeMetadata, uploadDroppedProjectCover, uploadProjectCover } from "./metadata.js";
import { renderModels, stopModelPolling } from "./models.js";
import { S } from "./store.js";
import { exportRocksmith } from "./rocksmith-export.js";
import { exportModernGp, exportTab, setView } from "./tablature.js";
import { runFindSimilar } from "./tracing.js";

// ---- spectrogram drag mode ----
// A plain drag traces notes; modifiers retain their existing alternate gestures.
export const TOOL_CURSOR = { select: "default", trace: "crosshair", marquee: "crosshair", frame: "col-resize" };

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

export const layerInstr = $("layerInstr"), layerTone = $("layerTone"), layerTun = $("layerTun"), layerArrangement = $("layerArrangement");
export const spLayerName = $("spLayerName");

export const layerVolume = $("layerVolume"), layerVolumeValue = $("layerVolumeValue");

export const layerDeleteBtn = $("layerDelete");

// Staged the same way the settings modal is: the layer's fields repaint the
// stage as you touch them, so Cancel walks them back rather than deferring them.
let layerSnapshot = null;
let layerActions = null;
export function openLayerSettings(actions = null) {
  layerActions = actions;
  $("layerSave").textContent = actions ? "Create" : "Save";
  $("settingsPanel").setAttribute("aria-label", actions ? "Add note layer" : "Edit note layer");
  renderLayerSettings();
  layerSettingsBackdrop.hidden = false;
  layerSnapshot = snapshotInputs($("settingsPanel"));
}

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

// Tuning manager: a separate modal (reached via layerTun's "Manage tunings…"
// option) for creating/editing/deleting named custom tunings.
export const tuningManagerBackdrop = $("tuningManagerBackdrop"), tuningManagerClose = $("tuningManagerClose");
export const tuningListEl = $("tuningList"), tuningAddBtn = $("tuningAdd");

// Staged like the layer editor: a tuning's strings apply as you change them, so
// Cancel puts them back. Adding and deleting a tuning are actions and stand.
let tuningSnapshot = null;
export function openTuningManager() {
  renderTuningManager();
  tuningManagerBackdrop.hidden = false;
  tuningSnapshot = snapshotInputs($("tuningManagerPanel"));
}

function closeTuningManager() { tuningSnapshot = null; tuningManagerBackdrop.hidden = true; }
function cancelTuningManager() {
  revertInputs(tuningSnapshot); tuningSnapshot = null;
  tuningManagerBackdrop.hidden = true;
}

// One modal, panes swapped by `section` ("trace" | "project" | "keys" | "appearance" | "models").
const SP_TITLES = { trace: "Editor options", project: "Project details", keys: "Keyboard shortcuts", appearance: "Appearance", models: "Models" };
// Rule 20: the primary names the work. A settings window applies; an editor saves.
const SP_PRIMARY = { project: "Save" };
let spSection = "trace";

// Rule 17: the scrim is a promise that nothing has changed yet. These panes all
// applied live — theme and trace threshold repaint as you touch
// them, which is the only way to judge them — so staging here is a snapshot on
// open and a revert on Cancel, not a deferred write. Escape, Cancel, the close
// and a backdrop click are all the same key, and all four take this path.
const snapshotInputs = (root) => [...root.querySelectorAll("input, select")]
  .filter((el) => !el.closest("[hidden]"))
  .map((el) => ({ el, v: el.type === "checkbox" ? el.checked : el.value }));

// Put each value back and re-fire the event that applied it, so persistence and
// live preview walk backwards together — no second code path to keep in sync.
function revertInputs(snap) {
  for (const { el, v } of snap || []) {
    if ((el.type === "checkbox" ? el.checked : el.value) === v) continue;
    if (el.type === "checkbox") el.checked = v; else el.value = v;
    for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

let spSnapshot = null;
function snapshotSettings() {
  spSnapshot = { keys: keySnapshot(), inputs: snapshotInputs($("settingsModal")) };
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
  $("settingsModalTitle").textContent = section === "project" ? SP_TITLES.project : "Settings";
  $("settingsApply").textContent = SP_PRIMARY[section] || "Apply";
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
  if (section === "keys") { setKeyTab("edit"); renderKeymap(); }
}

function openSettingsModal(section = "trace") {
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
function closeSettingsModal() { spSnapshot = null; stopModelPolling(); settingsModalBackdrop.hidden = true; }
function cancelSettingsModal() { revertSettings(); stopModelPolling(); settingsModalBackdrop.hidden = true; }
// Project details is the one pane whose values live on the server, so its
// primary is the only one that has work left to do when it is pressed.
function applySettingsModal() {
  if (spSection === "project") { saveProjectSettings(); return; }
  closeSettingsModal();
}

function projectSettingsMeta() {
  if (!S.state) return normalizeMetadata({});
  S.state.metadata = normalizeMetadata(S.state.metadata || {});
  return S.state.metadata;
}

function collectProjectSettingsMeta() {
  const meta = normalizeMetadata(projectSettingsMeta());
  meta.title = ($("projTitle").value || "").trim();
  meta.artist = ($("projArtist").value || "").trim();
  meta.album = ($("projAlbum").value || "").trim();
  meta.year = ($("projYear").value || "").trim();
  return meta;
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

function renderProjectSettings() {
  const on = !!S.state && S.state.job !== "tutorial";
  const meta = projectSettingsMeta();
  $("projTitle").value = meta.title || (S.state && (S.state.name || S.state.filename)) || "";
  $("projArtist").value = meta.artist || "";
  $("projAlbum").value = meta.album || "";
  $("projYear").value = meta.year || "";
  renderProjectCover(meta);
  for (const id of ["projTitle", "projArtist", "projAlbum", "projYear", "projCoverDrop", "settingsApply"])
    if ($(id)) $(id).disabled = !on;
  $("projCoverDrop").setAttribute("aria-disabled", String(!on));
  $("projCoverDrop").tabIndex = on ? 0 : -1;
  $("projCoverClear").disabled = !on;
  setProjectMetaStatus("");
}

async function saveProjectSettings() {
  if (!S.state || S.state.job === "tutorial") return;
  const meta = collectProjectSettingsMeta();
  S.state.metadata = meta;
  setProjectMetaStatus("Saving...");
  try {
    const res = await fetch(`/api/projects/${S.state.job}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: metadataPayload(meta) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "save failed");
    closeSettingsModal();
  } catch (err) {
    setProjectMetaStatus(err.message, true);
  }
}

async function changeProjectSettingsCover(run, working, done) {
  if (!S.state || S.state.job === "tutorial") return;
  const meta = await applyCoverChange(collectProjectSettingsMeta(), run, setProjectMetaStatus, working, done);
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
    const name = document.createElement("span");
    name.className = "keymap-name"; name.textContent = c.label;
    const btn = document.createElement("button");
    btn.className = "keymap-key" + (keyCapture && keyCapture.id === c.id ? " capturing" : "");
    // The paragraph that said this is gone (rule 24); the sentence belongs to
    // the control it is about, and the control is the chip you click.
    btn.title = "Click, then press the new key";
    btn.textContent = keyCapture && keyCapture.id === c.id ? "press a key…" : keyOf(c.id);
    btn.addEventListener("click", () => { keyCapture = { id: c.id }; renderKeymap(); });
    row.append(name, btn);
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
  for (const slot of document.querySelectorAll('[data-ui-icon]')) {
    slot.innerHTML = icon(slot.dataset.uiIcon, 18);
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
    if (tuningManagerBackdrop.hidden) return false;
    cancelTuningManager(); return true;
  });
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (layerSettingsBackdrop.hidden) return false;
    cancelLayerSettings(); return true;
  });
  setTool("trace");
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
  layerSettingsBackdrop.addEventListener("click", (e) => { if (e.target === layerSettingsBackdrop) cancelLayerSettings(); });
  $("layerCancel").addEventListener("click", cancelLayerSettings);
  $("layerSave").addEventListener("click", closeLayerSettings);
  tuningManagerClose.addEventListener("click", cancelTuningManager);
  tuningManagerBackdrop.addEventListener("click", (e) => { if (e.target === tuningManagerBackdrop) cancelTuningManager(); });
  $("tuningCancel").addEventListener("click", cancelTuningManager);
  $("tuningSave").addEventListener("click", closeTuningManager);
  settingsModalClose.addEventListener("click", cancelSettingsModal);
  settingsModalBackdrop.addEventListener("click", (e) => { if (e.target === settingsModalBackdrop) cancelSettingsModal(); });
  $("settingsCancel").addEventListener("click", cancelSettingsModal);
  $("settingsApply").addEventListener("click", applySettingsModal);
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
