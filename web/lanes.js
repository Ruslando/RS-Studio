// Edit-lane and stem-view helpers (the global edit lanes shared across stems),
// the lane list panel, and the Settings > Layer pane (instrument/tuning/output role).

import { DEFAULT_INSTRUMENT, DEFAULT_LAYER_VOLUME, EDIT_PALETTE, INSTRUMENTS, TONES, instrKey, toneKey } from "./constants.js";
import { confirmAction } from "./dialog.js";
import { clearArriving, lanesEl } from "./dom.js";
import { draw } from "./repaint.js";
import { CLOSE_ICON, icon } from "./icons.js";
import { updateUndoButtons } from "./edit.js";
import { emptyLaneFields } from "./marker-rails.js";
import { ungroupShape } from "./shapes.js";
import { refreshSaveState } from "./project.js";
import { S, setSelection } from "./store.js";
import { TUNINGS, addCustomTuning, customTunings, isValidTuningKey, laneTuning, parseTuning, refreshTabIfOpen, removeCustomTuning, tuningToNames, updateCustomTuning } from "./tablature.js";
import { closeLayerSettings, layerArrangement, layerColor, layerDeleteBtn, layerInstr, layerName, layerTone, layerTun, layerVolume, layerVolumeValue, openLayerSettings, openTuningManager, spLayerName, tuningAddBtn, tuningListEl } from "./ui.js";
import { clamp, layerVolumePercent, normLayerVolume, noteName, volumeToDb } from "./util.js";

// ---- lane / stem helpers ----
// Edit lanes are the only lanes and are GLOBAL (shared across every stem view).
// `state.lanes` mirrors them — kept as a separate array so the rest of the editor
// can iterate one "shown" set — and is rebuilt whenever the lane set changes.
export const editLanes = () => S.state.editLanes;

export const activeLane = () => S.state.lanes.find((l) => l.active);
let newLaneDraft = null;
const settingsLane = () => newLaneDraft || activeLane();

export function targetLane() {
  return activeLane() || editLanes()[0] || null;
}

// Vertical edits on an imported exact-tab lane keep the authored string and
// move along that string. This prevents pitch and string/fret from diverging,
// which would otherwise make a modern Guitar Pro export ambiguous.
export function setLaneNotePitch(lane, note, desiredPitch) {
  if (desiredPitch !== note.pitch && note.shapeId) ungroupShape(lane.notes, note.shapeId);
  let pitch = desiredPitch;
  if (lane?.fingeringMode === "exact" && Number.isInteger(note.pos?.string)) {
    const tuning = laneTuning(lane), open = tuning[note.pos.string];
    if (Number.isFinite(open)) {
      const transposition = Number(lane.transpositionPitch) || 0;
      pitch = Math.max(open - transposition, Math.round(desiredPitch));
      const delta = pitch - note.pitch;
      note.pos = { ...note.pos, fret: pitch + transposition - open, scope: "local" };
      if (Number.isFinite(note.soundingPitch)) note.soundingPitch += delta;
    }
  }
  note.pitch = pitch;
}

function clearLaneShapes(lane) {
  for (const shapeId of new Set((lane?.notes || []).map((note) => note.shapeId).filter(Boolean)))
    ungroupShape(lane.notes, shapeId);
}

function retuneExactLane(lane) {
  if (lane?.fingeringMode !== "exact") return;
  const tuning = laneTuning(lane);
  const transposition = Number(lane.transpositionPitch) || 0;
  for (const note of lane.notes) {
    let string = Number(note.pos?.string);
    if (!Number.isInteger(string) || string < 0 || string >= tuning.length || note.pitch + transposition < tuning[string]) {
      const choices = tuning.map((open, index) => ({ string: index, fret: Math.round(note.pitch + transposition - open) }))
        .filter((choice) => choice.fret >= 0).sort((a, b) => a.fret - b.fret);
      if (!choices.length) continue;
      string = choices[0].string;
    }
    note.pos = { string, fret: Math.round(note.pitch + transposition - tuning[string]), scope: "local" };
  }
}

// A lane is editable only when it's shown and not locked. Editing is further
// scoped to the *active* lane (see pickNote / mousedown), so other visible lanes
// act as read-only reference until you switch to them.
export const canEditLane = (l) => !!(l && l.visible && !l.locked);

export const curStemObj = () => S.state.stems.find((s) => s.id === S.state.curStem) || S.state.stems[0];

export function rebuildLanes() {
  S.state.lanes = [...S.state.editLanes];
  if (!S.state.lanes.some((l) => l.active) && S.state.editLanes[0]) {
    S.state.editLanes[0].active = true;
  }
}

// ---- Settings → Layer pane: instrument & tuning of the active edit lane ----
export let layerOptsBuilt = false;

function buildLayerOptions() {
  if (layerOptsBuilt || !layerInstr) return;
  for (const [key, def] of Object.entries(INSTRUMENTS))
    layerInstr.append(new Option(def.label, key));
  for (const [key, def] of Object.entries(TONES))
    layerTone.append(new Option(def.label, key));
  layerOptsBuilt = true;
}

// The sound, and the two things downstream of it: the voice the scheduler builds
// (dropped so the next note rebuilds it) and the General-MIDI program an export
// writes. gmProgram is only overwritten when the lane already carries one — an
// imported track's program is its own and outlives a tone change.
function setLaneTone(lane, tone) {
  lane.tone = tone;
  if (Number.isFinite(lane.gmProgram)) lane.gmProgram = TONES[tone].gm;
  disposeLaneSynth(lane);
}

// Presets are grouped by string count so the (long) list stays scannable.
// Limitation: length→family is a heuristic that holds for the current presets
// (4/5 = bass, 6+ = guitar); add an explicit `family` field if a 5-string
// guitar or the like ever breaks it.
const STRING_GROUP = { 4: "Bass · 4-string", 5: "Bass · 5-string", 6: "Guitar · 6-string", 7: "Guitar · 7-string", 8: "Guitar · 8-string" };
const tuningGroupLabel = (len) => STRING_GROUP[len] || `${len}-string`;

// Tuning options are rebuilt on every render (cheap, short list) since the
// custom-tuning set can change independently of which lane is active.
function buildTuningOptions(lane) {
  layerTun.replaceChildren();
  const groups = new Map();
  for (const [key, def] of Object.entries(TUNINGS)) {
    const gl = tuningGroupLabel(def.tuning.length);
    let g = groups.get(gl);
    if (!g) { g = document.createElement("optgroup"); g.label = gl; groups.set(gl, g); layerTun.append(g); }
    g.append(new Option(def.label, key));
  }
  if (customTunings.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Custom";
    for (const t of customTunings) grp.append(new Option(`${t.name} (${t.notes})`, t.id));
    layerTun.append(grp);
  }
  // Older projects stored an ad-hoc "custom" tuning inline; keep it selectable
  // (read-only here) so a lane created that way still displays correctly.
  if (lane && lane.tuning === "custom") layerTun.append(new Option("Custom (legacy)", "custom"));
  layerTun.append(new Option("Manage tunings…", "__manage"));
}

export function renderLayerSettings() {
  if (!layerInstr || !S.state) return;
  buildLayerOptions();
  const lane = settingsLane();
  if (layerDeleteBtn) layerDeleteBtn.hidden = !!newLaneDraft;
  if (layerDeleteBtn) layerDeleteBtn.disabled = editLanes().length <= 1;
  spLayerName.textContent = lane ? lane.name : "—";
  // The chip carries the layer's own identity dot — the same colour the stage
  // draws it in, so the dialog names the object the way the sidebar does.
  spLayerName.parentElement?.style.setProperty("--chip-dot", lane?.color || "");
  for (const el of [layerName, layerColor, layerInstr, layerTone, layerTun, layerArrangement, layerVolume]) if (el) el.disabled = !lane;
  buildTuningOptions(lane);
  if (!lane) return;
  if (layerName && document.activeElement !== layerName) layerName.value = lane.name || "";
  if (layerColor && document.activeElement !== layerColor) layerColor.value = lane.color || "#70c0ff";
  const volPct = layerVolumePercent(lane);
  if (document.activeElement !== layerVolume) layerVolume.value = String(volPct);
  if (layerVolumeValue) layerVolumeValue.textContent = `${volPct}%`;
  layerInstr.value = instrKey(lane.instrument);
  layerTone.value = toneKey(lane.tone);
  layerTun.value = isValidTuningKey(lane.tuning) ? lane.tuning : INSTRUMENTS[layerInstr.value].tuning;
  if (layerArrangement) {
    const value = lane.rocksmithArrangement;
    layerArrangement.value = ["none", "lead", "rhythm", "alt_lead", "alt_rhythm", "bonus_lead", "bonus_rhythm", "bass", "alt_bass", "bonus_bass"].includes(value)
      ? value : lane.tablatureEnabled === false ? "none" : "auto";
  }
}

// ---- Settings → Manage tunings modal: create/edit/delete named custom tunings ----
export function renderTuningManager() {
  if (!tuningListEl) return;
  tuningListEl.replaceChildren(...customTunings.map(tuningRow));
}

// C0..E6 — low enough for 5/6-string bass (B0 = 23) and drop tunings, high
// enough for any guitar open string.
const NOTE_MIN = 12, NOTE_MAX = 88;
const TUNE_MIN_STRINGS = 4, TUNE_MAX_STRINGS = 8;

// A per-string note dropdown (highest pitch at top). Value = open-string MIDI,
// so the picker can't produce anything invalid — no free-text parsing needed.
function noteSelect(midi) {
  const sel = document.createElement("select");
  sel.className = "tuning-str";
  for (let p = NOTE_MAX; p >= NOTE_MIN; p--) sel.append(new Option(noteName(p), String(p)));
  sel.value = String(midi);
  return sel;
}

function tuningRow(t) {
  const row = document.createElement("div");
  row.className = "tuning-row";

  const head = document.createElement("div");
  head.className = "tuning-row-head";
  const name = document.createElement("input");
  name.type = "text"; name.className = "tuning-name"; name.value = t.name; name.placeholder = "Name";
  name.addEventListener("change", () => {
    updateCustomTuning(t.id, { name: name.value.trim() || t.name });
    renderLayerSettings();
  });
  const del = document.createElement("button");
  del.type = "button"; del.className = "lane-btn tuning-del"; del.title = "Delete tuning";
  del.setAttribute("aria-label", "Delete tuning");
  del.innerHTML = CLOSE_ICON;   // a literal ✕ is not the app's close mark
  del.addEventListener("click", () => {
    removeCustomTuning(t.id);
    renderTuningManager(); renderLayerSettings(); refreshTabIfOpen();
  });
  head.append(name, del);

  // Edit as MIDI numbers, persist back as the note-name string the store expects.
  const midis = parseTuning(t.notes) || TUNINGS.guitar6.tuning.slice();
  const strings = document.createElement("div");
  strings.className = "tuning-strings";
  // Rule 24: the paragraph that explained this window is gone; what it said
  // belongs to the controls it was about.
  strings.title = "Each open string, highest first.";
  const commit = () => {
    updateCustomTuning(t.id, { notes: tuningToNames(midis) });
    if (S.state) for (const lane of S.state.editLanes)
      if (lane.tuning === t.id) { lane.customTuning = tuningToNames(midis); retuneExactLane(lane); clearLaneShapes(lane); }
    renderLayerSettings(); refreshTabIfOpen();
  };
  const countBtn = (text, title, on, disabled) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tuning-count"; b.textContent = text; b.title = title; b.disabled = disabled;
    b.addEventListener("click", on);
    return b;
  };
  const rebuild = () => {
    strings.replaceChildren();
    midis.forEach((p, i) => {
      const sel = noteSelect(p);
      sel.addEventListener("change", () => { midis[i] = parseInt(sel.value, 10); commit(); });
      strings.append(sel);
    });
    strings.append(
      countBtn("−", "Remove lowest string", () => { midis.pop(); commit(); rebuild(); }, midis.length <= TUNE_MIN_STRINGS),
      // New string defaults a fourth below the current lowest (the usual extended-range step).
      countBtn("+", "Add a lower string", () => { midis.push(clamp(midis[midis.length - 1] - 5, NOTE_MIN, NOTE_MAX)); commit(); rebuild(); }, midis.length >= TUNE_MAX_STRINGS),
    );
  };
  rebuild();

  row.append(head, strings);
  return row;
}

// Reached from an active lane's tuning select — seed the new preset from that
// lane's current tuning and apply it right away, so this reads as "duplicate &
// tweak" rather than a blank form.
function addTuningFromManager() {
  const lane = settingsLane();
  const notes = tuningToNames(lane ? laneTuning(lane) : TUNINGS.guitar6.tuning);
  const t = addCustomTuning(`Custom ${customTunings.length + 1}`, notes);
  if (lane) { lane.tuning = t.id; lane.customTuning = notes; clearLaneShapes(lane); }
  renderTuningManager(); renderLayerSettings(); refreshTabIfOpen();
}

// Inline-SVG icons for the per-layer controls (no icon library; design handoff).
const ICON = Object.fromEntries(["eye", "lock", "unlock", "speaker", "speakerOff", "edit"].map((name) => [name, icon(name, 14)]));
const laneBtn = (cls, icon, title, onClick) => {
  const b = document.createElement("button");
  b.className = cls; b.innerHTML = icon; b.title = title;
  b.type = "button"; b.setAttribute("aria-label", title);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
};

let laneDrag = null;

function clearLaneDropIndicators() {
  lanesEl.querySelectorAll(".lane-row.drop-before, .lane-row.drop-after")
    .forEach((row) => row.classList.remove("drop-before", "drop-after"));
}

function reorderLane(moving, target, before) {
  if (!moving || !target || moving === target) return;
  const lanes = editLanes();
  lanes.splice(lanes.indexOf(moving), 1);
  const targetIndex = lanes.indexOf(target);
  lanes.splice(targetIndex + (before ? 0 : 1), 0, moving);
  rebuildLanes();
  renderLanes();
  draw();
  refreshTabIfOpen();
  refreshSaveState();
}

function wireLaneDrag(row, lane) {
  row.draggable = true;
  row.title = "Drag to reorder note layer";
  row.addEventListener("dragstart", (event) => {
    laneDrag = { lane };
    row.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", lane.id);
    }
  });
  row.addEventListener("dragover", (event) => {
    if (!laneDrag || laneDrag.lane === lane) return;
    event.preventDefault();
    const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    clearLaneDropIndicators();
    row.classList.add(before ? "drop-before" : "drop-after");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    const moving = laneDrag?.lane;
    const before = row.classList.contains("drop-before");
    clearLaneDropIndicators();
    reorderLane(moving, lane, before);
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    clearLaneDropIndicators();
    laneDrag = null;
  });
}

export function renderLanes() {
  const actions = document.getElementById('noteLayerActions');
  lanesEl.innerHTML = "";
  for (const lane of editLanes()) {
    const row = document.createElement("div");
    row.className = "lane-row arriving" + (lane.active ? " active" : "") + (lane.locked ? " locked" : "")
      + (lane.muted ? " muted" : "") + (lane.visible ? "" : " hiddenLane");
    // Clicking the row (anywhere but a control) makes it the active edit target.
    row.addEventListener("click", () => activateLane(lane));


    const dot = document.createElement("span");
    dot.className = "lane-dot"; dot.style.background = lane.color;

    const name = document.createElement("span");
    name.className = "lane-name"; name.textContent = lane.name;
    name.addEventListener("dblclick", (e) => { e.stopPropagation(); beginRename(lane, row, name); });

    const count = document.createElement("span");
    count.className = "count"; count.textContent = `${lane.notes.length.toLocaleString()} note${lane.notes.length === 1 ? '' : 's'}`;
    count.title = `${lane.notes.length} note${lane.notes.length === 1 ? "" : "s"}`;
    lane._count = count;

    // An eye, struck through (via CSS) when the layer is hidden.
    const vis = laneBtn("lane-btn vis-btn" + (lane.visible ? "" : " off"), ICON.eye,
      lane.visible ? "Hide note layer (also mutes it)" : "Show note layer in the editor",
      () => setLaneVisible(lane, !lane.visible));
    vis.setAttribute("aria-pressed", String(lane.visible));

    // Lock = visible but read-only: you can still see (and hear) the layer, but
    // its notes can't be selected, moved, traced, or deleted.
    const lock = laneBtn("lane-btn lock-btn" + (lane.locked ? " on" : ""), lane.locked ? ICON.lock : ICON.unlock,
      lane.locked ? "Locked — click to allow editing" : "Lock note layer (view-only)",
      () => toggleLaneLock(lane));
    lock.setAttribute("aria-pressed", String(lane.locked));

    const mute = laneBtn("lane-btn mute-btn" + (lane.muted ? " on" : ""), lane.muted ? ICON.speakerOff : ICON.speaker,
      lane.muted ? "Unmute note layer" : "Mute note layer",
      () => toggleLaneMute(lane));
    mute.setAttribute("aria-pressed", String(lane.muted));

    // Edit opens this layer's name, color, instrument, tuning, tablature role,
    // and volume panel.
    const edit = laneBtn("lane-btn edit-btn", ICON.edit, "Edit note layer settings",
      () => { activateLane(lane); openLayerSettings(); });

    const ctrls = document.createElement("div");
    ctrls.className = "lane-ctrls";
    // Fixed action column: note counts never change the buttons' position.
    ctrls.append(edit, lock, vis, mute);

    row.append(dot, name, count, ctrls);
    wireLaneDrag(row, lane);
    lanesEl.append(row);
  }

  const add = document.createElement("button");
  add.id = "addLane"; add.className = 'icon-btn icon-btn--compact layer-add';
  add.innerHTML = icon('plus',16); add.title = 'Add note layer';
  add.setAttribute('aria-label', 'Add note layer');
  add.addEventListener("click", addEditLane);
  actions.replaceChildren(add);
  lanesEl.append(actions);

  // A control click rebuilds these rows under an already-hovering pointer, so
  // they arrive with their transitions suppressed and settle two frames later.
  clearArriving(lanesEl);

  renderLayerSettings();   // keep Settings → Layer in sync with the active lane
}

// Make a lane the active edit target (selection / new notes / layer editor land here).
function activateLane(lane) {
  if (lane.active) return;
  S.state.lanes.forEach((l) => (l.active = l === lane));
  renderLanes(); draw();
  refreshTabIfOpen();
  refreshSaveState();
}

// Inline rename: swap the name label for a text field until blur / Enter.
function beginRename(lane, row, nameEl) {
  const input = document.createElement("input");
  input.type = "text"; input.className = "lane-name-input"; input.value = lane.name;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); input.value = lane.name; input.blur(); }
  });
  input.addEventListener("blur", () => {
    lane.name = input.value.trim() || lane.name;
    renderLanes();
    refreshTabIfOpen();
    refreshSaveState();
  });
  row.replaceChild(input, nameEl);
  input.focus(); input.select();
}

// Hiding a layer mutes it too: "get this out of my way" is the common case, and
// needing two clicks for it would be a poor default. The mute is only *implied* —
// `_autoMuted` marks it as ours, so showing the layer undoes only a mute this
// function applied, while one you set yourself (mute button / M) survives any
// number of hide-show cycles. Not persisted: after a reload we can't tell whose
// mute it was, and leaving it alone is the safe default. Hiding also drops the
// layer's notes from the selection — a hidden layer can't be edited directly.
function setLaneVisible(lane, visible) {
  lane.visible = visible;
  if (!visible) {
    lane._autoMuted = !lane.muted;
    lane.muted = true;
    releaseLaneSynth(lane);
  } else if (lane._autoMuted) {
    lane.muted = false;
    lane._autoMuted = false;
  }
  if (!lane.visible && S.selection.size)
    setSelection(new Set([...S.selection].filter((n) => !lane.notes.includes(n))));
  renderLanes(); draw();
  refreshSaveState();
}

function setLaneArrangement(lane, arrangement) {
  const sourceTrack = lane.sourceTrackIndex;
  const targets = sourceTrack == null ? [lane]
    : editLanes().filter((candidate) => candidate.sourceTrackIndex === sourceTrack);
  for (const target of targets) {
    if (arrangement === "auto") delete target.rocksmithArrangement;
    else target.rocksmithArrangement = arrangement;
    target.tablatureEnabled = arrangement !== "none";
  }
  renderLanes();
  refreshTabIfOpen();
  refreshSaveState();
}

// Muting by hand takes the mute away from `setLaneVisible` — after this, showing
// the layer again leaves it exactly as you set it.
// Tone.js teardown is best-effort. A lane's synth may already be disposed — the
// project switched, the lane was deleted, Tone was torn down — and releasing or
// disposing twice throws. A missed release is inaudible; a thrown error here
// takes the whole handler down with it, which is the actual risk.
// Which edit layer owns a note. Lives here rather than in interaction.js — it
// answers a question about layers, and four modules were importing the whole
// mouse-handling module to ask it.
export const laneOf = (note) => editLanes().find((l) => l.notes.includes(note)) || null;

export function applyLaneVolume(lane) {
  if (!lane?._synth?.volume) return;
  try { lane._synth.volume.value = volumeToDb(lane.volume); } catch { /* already disposed */ }
}

export function releaseLaneSynth(lane) {
  if (lane?._synth) try { lane._synth.releaseAll(); } catch { /* already gone */ }
}

export function disposeLaneSynth(lane) {
  if (lane?._synth) try { lane._synth.dispose(); } catch { /* already gone */ }
  if (lane) lane._synth = null;
}

export function toggleLaneMute(lane) {
  lane.muted = !lane.muted;
  lane._autoMuted = false;
  if (lane.muted) releaseLaneSynth(lane);
  renderLanes();
  refreshSaveState();
}

// Lock / unlock a lane (visible but read-only). Locking drops its notes from the
// current selection so a locked note can't be edited via a stale selection.
function toggleLaneLock(lane) {
  lane.locked = !lane.locked;
  if (lane.locked && S.selection.size)
    setSelection(new Set([...S.selection].filter((n) => !lane.notes.includes(n))));
  renderLanes(); draw();
  refreshSaveState();
}

export function refreshCounts() {
  for (const lane of S.state.lanes) if (lane._count) {
    lane._count.textContent = `${lane.notes.length.toLocaleString()} note${lane.notes.length === 1 ? '' : 's'}`;
    lane._count.title = `${lane.notes.length} note${lane.notes.length === 1 ? "" : "s"}`;
  }
}

function addEditLane() {
  if (!S.state || newLaneDraft) return;
  const idx = S.state.editLanes.length;
  const lane = {
    id: "draft", name: "Layer " + (idx + 1), kind: "edit",
    color: EDIT_PALETTE[idx % EDIT_PALETTE.length], visible: true, active: false, locked: false,
    instrument: DEFAULT_INSTRUMENT, tone: INSTRUMENTS[DEFAULT_INSTRUMENT].tone,
    tuning: INSTRUMENTS[DEFAULT_INSTRUMENT].tuning, customTuning: "",
    volume: DEFAULT_LAYER_VOLUME,
    muted: false, tablatureEnabled: true, notes: [], ...emptyLaneFields(),
  };
  newLaneDraft = lane;
  openLayerSettings({
    save: () => { newLaneDraft = null; lane.id = "edit_" + S.uid++; commitNewLane(lane); },
    cancel: () => { disposeLaneSynth(lane); newLaneDraft = null; },
  });
}

function commitNewLane(lane) {
  S.state.editLanes.push(lane);
  rebuildLanes();
  S.state.lanes.forEach((l) => (l.active = l === lane));
  S.undoStack = []; S.redoStack = []; updateUndoButtons(); // topology changed
  renderLanes(); draw();
  refreshTabIfOpen();
  refreshSaveState();
}

function removeLane(lane) {
  if (S.state.editLanes.length <= 1) return;
  disposeLaneSynth(lane);
  S.state.editLanes = S.state.editLanes.filter((l) => l !== lane);
  rebuildLanes();  // re-points state.lanes + re-activates an edit lane if needed
  S.selection = new Set();
  S.undoStack = []; S.redoStack = []; updateUndoButtons();
  renderLanes(); draw();
  refreshTabIfOpen();
  refreshSaveState();
}

export function init_lanes() {
  // A destructive action inside an editor opens a confirmation; it never fires
  // from the editor. The two buttons are one mis-aimed click apart in the footer
  // and only one of them is reversible.
  if (layerDeleteBtn) layerDeleteBtn.addEventListener("click", async () => {
    const lane = activeLane(); if (!lane) return;
    const ok = await confirmAction({
      title: "Delete note layer",
      message: `“${lane.name}” and every note on it are removed. This cannot be undone.`,
      confirmLabel: "Delete note layer", danger: true,
    });
    if (!ok || activeLane() !== lane) return;
    removeLane(lane);
    closeLayerSettings();
  });
  if (layerInstr) {
    if (layerName) {
      layerName.addEventListener("input", () => {
        const lane = settingsLane(); if (!lane) return;
        const next = layerName.value.trim();
        if (!next) return;
        lane.name = next;
        renderLanes(); refreshTabIfOpen();
      });
      layerName.addEventListener("change", () => {
        const lane = settingsLane(); if (!lane) return;
        if (!layerName.value.trim()) layerName.value = lane.name;
        refreshSaveState();
      });
    }
    if (layerColor) layerColor.addEventListener("input", () => {
      const lane = settingsLane(); if (!lane) return;
      lane.color = layerColor.value;
      renderLanes(); draw(); refreshTabIfOpen();
      refreshSaveState();
    });
    layerInstr.addEventListener("change", () => {
      const lane = settingsLane(); if (!lane) return;
      const was = instrKey(lane.instrument);
      lane.instrument = layerInstr.value;
      // The sound moves with the instrument only if it was still that instrument's
      // own. Picking a tone is a choice, and choosing a different neck is not a
      // reason to undo it — but a lane nobody has voiced yet should not sound like
      // an electric because it started as one.
      if (toneKey(lane.tone) === INSTRUMENTS[was].tone) setLaneTone(lane, INSTRUMENTS[lane.instrument].tone);
      lane.tuning = INSTRUMENTS[layerInstr.value].tuning;   // instrument drives the default tuning
      lane.customTuning = tuningToNames(laneTuning(lane));  // materialize for portable GP export
      retuneExactLane(lane);
      clearLaneShapes(lane);
      renderLayerSettings(); draw(); refreshTabIfOpen();   // a new neck to draw
      refreshSaveState();
    });
    layerTone.addEventListener("change", () => {
      const lane = settingsLane(); if (!lane) return;
      setLaneTone(lane, layerTone.value);
      renderLayerSettings();  refreshTabIfOpen();
      refreshSaveState();
    });
    layerTun.addEventListener("change", () => {
      const lane = settingsLane(); if (!lane) return;
      if (layerTun.value === "__manage") { renderLayerSettings(); openTuningManager(); return; }
      lane.tuning = layerTun.value;
      lane.customTuning = tuningToNames(laneTuning(lane));
      retuneExactLane(lane);
      clearLaneShapes(lane);
      renderLayerSettings(); refreshTabIfOpen();
      refreshSaveState();
    });
    if (layerArrangement) layerArrangement.addEventListener("change", () => {
      const lane = settingsLane(); if (!lane) return;
      setLaneArrangement(lane, layerArrangement.value);
    });
    if (layerVolume) layerVolume.addEventListener("input", () => {
      const lane = settingsLane(); if (!lane) return;
      lane.volume = normLayerVolume((parseInt(layerVolume.value, 10) || 0) / 100);
      if (layerVolumeValue) layerVolumeValue.textContent = `${layerVolumePercent(lane)}%`;
      applyLaneVolume(lane);
      refreshSaveState();
    });
  }
  if (tuningAddBtn) tuningAddBtn.addEventListener("click", addTuningFromManager);
}
