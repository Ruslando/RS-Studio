// Edit-lane and stem-view helpers (the global edit lanes shared across stems),
// the lane list panel, and the Settings > Layer pane (instrument/tuning/output role).

import { DEFAULT_INSTRUMENT, DEFAULT_LAYER_VOLUME, EDIT_PALETTE, INSTRUMENTS, TONES, instrKey, toneKey } from "./constants.js";
import { confirmAction } from "./dialog.js";
import { clearArriving, lanesEl } from "./dom.js";
import { draw } from "./repaint.js";
import { icon } from "./icons.js";
import { updateUndoButtons } from "./edit.js";
import { emptyLaneFields } from "./marker-rails.js";
import { ungroupShape } from "./shapes.js";
import { refreshSaveState } from "./project.js";
import { S, setSelection } from "./store.js";
import { TUNINGS, customTunings, isValidTuningKey, laneTuning, parseTuning, refreshTabIfOpen, tuningToNames } from "./tablature.js";
import { closeLayerSettings, layerArrangement, layerCapo, layerColor, layerDeleteBtn, layerInstr, layerName, layerTone, layerTun, layerVolume, layerVolumeValue, openLayerSettings, openTuningManager, spLayerName } from "./ui.js";
import { layerVolumePercent, normLayerVolume, notesLowToHigh, volumeToDb } from "./util.js";
import { withStartTone } from "./tone-marker-core.js";
import { RS_KIND_OPTIONS, assignRsKinds, isTablatureLane, rsKindFits } from "./layer-role.js";
import { moveCapo } from "./voicing-core.js";

// ---- lane / stem helpers ----
// Edit lanes are the only lanes and are GLOBAL (shared across every stem view).
// `state.lanes` mirrors them — kept as a separate array so the rest of the editor
// can iterate one "shown" set — and is rebuilt whenever the lane set changes.
export const editLanes = () => S.state.editLanes;

export const activeLane = () => S.state.lanes.find((l) => l.active);
let newLaneDraft = null;
export const settingsLane = () => newLaneDraft || activeLane();

export function targetLane() {
  return activeLane() || editLanes()[0] || null;
}

// A pitch edit leaves the note's old position behind; it no longer sounds the pitch,
// so it lapses (lockedShape / pinnedPositions) and the note is fingered like any other.
export function setLaneNotePitch(lane, note, desiredPitch) {
  if (desiredPitch !== note.pitch && note.shapeId) ungroupShape(lane.notes, note.shapeId);
  if (Number.isFinite(note.soundingPitch)) note.soundingPitch += desiredPitch - note.pitch;
  note.pitch = desiredPitch;
}

// The highest capo offered: past the 12th the neck left is shorter than a ukulele's.
export const MAX_CAPO = 12;

export function setLaneCapo(lane, capo) {
  if (moveCapo(lane, capo)) S.voicingRevision++;
}

export function clearLaneShapes(lane) {
  for (const shapeId of new Set((lane?.notes || []).map((note) => note.shapeId).filter(Boolean)))
    ungroupShape(lane.notes, shapeId);
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
    for (const t of customTunings) grp.append(new Option(`${t.name} (${notesLowToHigh(parseTuning(t.notes) || [])})`, t.id));
    layerTun.append(grp);
  }
  // Older projects stored an ad-hoc "custom" tuning inline; keep it selectable
  // (read-only here) so a lane created that way still displays correctly.
  if (lane && lane.tuning === "custom") layerTun.append(new Option("Custom (legacy)", "custom"));
  layerTun.append(new Option("Manage tunings…", "__manage"));
}

export function renderLayerSettings() {
  if (!layerInstr || !S.state) return;
  refreshCounts();   // tuning, capo and arrangement all show in the layer rows
  buildLayerOptions();
  const lane = settingsLane();
  if (layerDeleteBtn) layerDeleteBtn.hidden = !!newLaneDraft;
  if (layerDeleteBtn) layerDeleteBtn.disabled = editLanes().length <= 1;
  spLayerName.textContent = lane ? lane.name : "—";
  // The chip carries the layer's own identity dot — the same colour the stage
  // draws it in, so the dialog names the object the way the sidebar does.
  spLayerName.parentElement?.style.setProperty("--chip-dot", lane?.color || "");
  for (const el of [layerName, layerColor, layerInstr, layerTone, layerTun, layerCapo, layerArrangement, layerVolume]) if (el) el.disabled = !lane;
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
  if (layerCapo) {
    // Rebuilt each time so a higher capo from an imported file still shows.
    layerCapo.replaceChildren();
    for (let fret = 0; fret <= Math.max(MAX_CAPO, Number(lane.capo) || 0); fret++)
      layerCapo.append(new Option(fret ? `Fret ${fret}` : "No capo", String(fret)));
    layerCapo.value = String(Number(lane.capo) || 0);
  }
  if (layerArrangement) {
    // An arrangement another layer holds, or this neck cannot play, is not on offer.
    const taken = new Set(arrangedLanes().filter((other) => !samePart(other, lane)).map((other) => other.rocksmithArrangement));
    for (const option of layerArrangement.options)
      option.disabled = option.value !== "none" && (taken.has(option.value) || !rsKindFits(option.value, laneTuning(lane)));
    layerArrangement.value = lane.rocksmithArrangement || "none";
  }
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
    count.className = "count";
    lane._count = count;   // filled by refreshCounts below

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

  refreshCounts();
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
    target.rocksmithArrangement = arrangement;
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

// The row's second line: "Lead · Eb Standard · Capo 2 · 124 notes".
function tuningLabel(lane) {
  if (TUNINGS[lane.tuning]) {
    // The notes are in Settings; the presets' plain "Standard" needs its root back.
    const name = TUNINGS[lane.tuning].label.replace(/\s*\(.*\)$/, "");
    return name === "Standard" ? `${notesLowToHigh(laneTuning(lane)).split(" ")[0]} Standard` : name;
  }
  const custom = customTunings.find((t) => t.id === lane.tuning);
  return custom ? custom.name : notesLowToHigh(laneTuning(lane));
}

// The layers that hold an arrangement: every one in the project, and the one being
// made in the dialog, which is not in the project until it is saved.
const arrangedLanes = () => [...editLanes(), ...(newLaneDraft ? [newLaneDraft] : [])];
const samePart = (a, b) => a === b || (a.sourceTrackIndex != null && a.sourceTrackIndex === b.sourceTrackIndex);

export function refreshCounts() {
  // Here because every change that can leave a layer without a valid arrangement
  // (a project loaded, a layer added or imported, another neck chosen) repaints the rows.
  assignRsKinds(arrangedLanes(), laneTuning);
  for (const lane of editLanes()) {
    if (!lane._count) continue;
    const parts = [
      isTablatureLane(lane) ? RS_KIND_OPTIONS.find(([k]) => k === lane.rocksmithArrangement)[1] : "No export",
      tuningLabel(lane),
      ...(Number(lane.capo) > 0 ? [`Capo ${lane.capo}`] : []),
      `${lane.notes.length.toLocaleString()} note${lane.notes.length === 1 ? "" : "s"}`,
    ];
    lane._count.textContent = lane._count.title = parts.join(" · ");
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
  // Now, not when the draft was made: the instrument is chosen in the dialog.
  lane.toneMarkers = withStartTone(lane.toneMarkers, lane);
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
      if (layerTun.value === "__manage") { renderLayerSettings(); openTuningManager(lane.tuning); return; }
      lane.tuning = layerTun.value;
      lane.customTuning = tuningToNames(laneTuning(lane));
      clearLaneShapes(lane);
      renderLayerSettings(); refreshTabIfOpen();
      refreshSaveState();
    });
    if (layerCapo) layerCapo.addEventListener("change", () => {
      const lane = settingsLane(); if (!lane) return;
      setLaneCapo(lane, Number(layerCapo.value) || 0);
      renderLayerSettings(); draw(); refreshTabIfOpen();
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
}
