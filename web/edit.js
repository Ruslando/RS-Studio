// Note editing: undo/redo across all edit lanes, clipboard (incl. paste-as-reference),
// the per-note effects (bend / harmonic / articulations / slide), the fingering
// override, and the right-click note context menu.

import { wireContextSubmenu } from "./context-submenu.js";
import { MAX_POINTS, bendAt, bendCurve, normalizeCurve } from "./bend.js";
import { openDetectPanel, updateDetectStatus } from "./detect.js";
import { conflictsWith } from "./effects.js";
import { $, inTourCard, offsetInput, pasteAsRefBtn, pasteBackdrop, pasteCancelBtn, pasteCopyBtn, redoMI, scroll, stage, undoMI } from "./dom.js";
import { draw } from "./repaint.js";
import { resetZoom, xOf, yOf } from "./geometry.js";
import { currentGridState, gridOffset, minDur, restoreGridState, snap, snapNote } from "./grid.js";
import { nid, shapeId } from "./ids.js";
import { railMenuItems, railsHidden } from "./marker-rails.js";
import { addMarkerAtTime } from "./markers.js";
import { activeLane, applyLaneVolume, canEditLane, curStemObj, editLanes, laneOf, refreshCounts, releaseLaneSynth, renderLanes, targetLane, toggleLaneMute } from "./lanes.js";
import { FX_KEYS, FX_LABELS, copyEffects } from "./note-effects.js";
import { applyStemGains, ensureTone, isMasterStem, masterStem, playbackTime, togglePlay } from "./playback.js";
import { toast } from "./notify.js";
import { openNewProject } from "./new-project.js";
import { openProject, refreshSaveState, renderStemTabs, saveProject, selectStem } from "./project.js";
import { boxOfNote, deleteRefGroup, deleteRefOccurrence, detachSelection, nextRef, noteBounds, reconcileReferences, refMenuEntry } from "./references.js";
import { chooseShapePositions, cleanupShapeMembership, shapeGroups, ungroupShape } from "./shapes.js";
import { splitNote } from "./slice.js";
import { animateNoteChanges, clearNoteMotion } from "./note-motion.js";
import { songBarStarts } from "./song-bars.js";
import { S, setSelection } from "./store.js";
import { laneTuning, refreshTabIfOpen, setView, tabViewOn } from "./tablature.js";
import { acceptAllMatches, acceptMatch, clearMatches, focusAdjacentMatch, previewFocusedMatch, runFindSimilar } from "./tracing.js";
import { ESC_DEPTH, closeTopmost, registerEscapeLayer } from "./escape-stack.js";
import { matchKey } from "./keymap.js";
import { normLayerVolume } from "./util.js";
import { chordColumns, normalizeOverrideInfluence, overrideInfluence, shapeFault, stepColumnFocus, stepVoiceFocus, voiceNotes, writeColumnOverride } from "./voicing.js";

// ---- undo / redo (all edit lanes) ----
export const MAX_UNDO = 200;

// The song's structure — tempo/meter markers, section markers, the bar list —
// travels in every snapshot alongside the notes. It has to: bar insert and
// removal retime notes, so restoring notes without restoring the bars they were
// timed against silently desyncs the two, and that would be true of *every*
// undo, not just an undo of a structure edit.
//
// `duration` is in here because a bar change rewrites it for score-only
// projects (score-structure.js), which is also why it is restored conditionally
// below — an audio project's duration comes from the file and must not move.
const cloneJson = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function structureSnapshot() {
  if (!S.state) return null;
  return {
    tempoMap: cloneJson(S.state.tempoMap),
    scoreBars: cloneJson(S.state.scoreBars),
    sectionMarkers: cloneJson(S.state.sectionMarkers),
    scoreDuration: S.state.scoreDuration,
    duration: S.state.duration,
  };
}

// Undo replaced the objects the marker popovers and the score-structure rows
// are holding references into, so they have to let go and re-read. A window
// event rather than direct calls: those three modules already import from here
// for their undo brackets, and calling back into them would close the loop.
export const STATE_RESTORED = "cw-state-restored";

// Snapshot both the notes and the reference boxes of every edit lane, so a mirror
// (or a box resize) undoes atomically with the edit that triggered it. The stack
// is global (one edit can span lanes — e.g. moving a selection that straddles two
// lanes), so a snapshot also captures the editor CONTEXT (which lane is active,
// each lane's show/hide, mute, and tablature role, plus the stem backdrop). Restoring that context is
// what keeps undo from appearing to apply another lane's change to the lane you're
// currently looking at.
export function snapshotEdit() {
  const a = activeLane();
  const snap = {
    lanes: {}, boxes: {}, ui: {}, holds: {},
    active: a ? a.id : null,
    stem: S.state ? S.state.curStem : null,
    grid: currentGridState(),
    offset: gridOffset(),   // so undoing an offset-driven note shift also rolls the offset back (no-op for every other edit)
    structure: structureSnapshot(),
  };
  for (const l of editLanes()) {
    snap.lanes[l.id] = l.notes.map((n) => ({ ...n }));
    snap.boxes[l.id] = l.refBoxes ? JSON.parse(JSON.stringify(l.refBoxes)) : {};
    // Where the hand was put. Not a note field, so nothing above captures it, and a
    // hold that undo cannot reach is an edit with no way back.
    snap.holds[l.id] = (l.handHolds || []).map((h) => ({ ...h }));
    snap.ui[l.id] = { visible: l.visible, muted: l.muted, locked: l.locked,
      tablatureEnabled: l.tablatureEnabled !== false, volume: normLayerVolume(l.volume) };
  }
  return snap;
}

// `mirrorSource` is optional and is NOT a flag despite reading like one: it is
// `{ ref, i }` naming the reference box the user actually dragged, so
// reconcileReferences mirrors from that one instead of guessing which box
// changed. Only the refBox drag passes it (interaction.js).
export function commit(prev, mirrorSource, cuts = null) {
  reconcileReferences(prev, mirrorSource);
  animateNoteChanges(prev, S.state, cuts);
  recordUndo(prev);
}

// For edits that retime everything at once — inserting or removing a bar, moving
// a tempo marker. reconcileReferences works by finding the one reference box
// whose contents changed and mirroring it onto the others; when *every* box
// changes it picks the first arbitrarily and overwrites the rest with it. A
// structure edit never changes what is inside a reference, only when it happens,
// so it records undo and skips that pass.
export function commitStructure(prev) {
  recordUndo(prev);
}

function recordUndo(prev) {
  S.voicingRevision++;
  S.undoStack.push(prev);
  if (S.undoStack.length > MAX_UNDO) S.undoStack.shift();
  S.redoStack = [];
  updateUndoButtons();
  refreshSaveState();   // an edit landed — reflect unsaved state in the project tab
}

function restore(snap) {
  clearNoteMotion();
  // Structure first: the grid readout and every note position below are drawn
  // against it, so putting the bars back after the notes would paint one frame
  // of the two disagreeing.
  if (snap.structure && S.state) {
    S.state.tempoMap = cloneJson(snap.structure.tempoMap);
    S.state.scoreBars = cloneJson(snap.structure.scoreBars);
    S.state.sectionMarkers = cloneJson(snap.structure.sectionMarkers);
    S.state.scoreDuration = snap.structure.scoreDuration;
    if (snap.structure.duration != null) S.state.duration = snap.structure.duration;
  }
  // Bring back the stem the edit was made under so the backdrop matches what you
  // edited (edit lanes show across every stem, so this is just the spectrogram).
  if (snap.stem && S.state.curStem !== snap.stem && S.state.stems.some((s) => s.id === snap.stem))
    selectStem(snap.stem);
  if (snap.grid) restoreGridState(snap.grid);
  else if (snap.offset != null) {
    offsetInput.value = (+snap.offset).toFixed(3);
    S.appliedOffset = +snap.offset;
    S.appliedGrid = currentGridState();
  }
  for (const l of editLanes()) {
    if (snap.lanes && snap.lanes[l.id]) l.notes = snap.lanes[l.id].map((n) => ({ ...n }));
    if (snap.boxes) l.refBoxes = JSON.parse(JSON.stringify(snap.boxes[l.id] || {}));
    if (snap.holds) l.handHolds = (snap.holds[l.id] || []).map((h) => ({ ...h }));
    const ui = snap.ui && snap.ui[l.id];
    if (ui) {
      l.visible = ui.visible; l.muted = ui.muted;
      if (ui.locked != null) l.locked = ui.locked;
      if (ui.tablatureEnabled != null) l.tablatureEnabled = ui.tablatureEnabled;
      if (ui.volume != null) { l.volume = normLayerVolume(ui.volume); applyLaneVolume(l); }
      if (l.muted) releaseLaneSynth(l);
    }
  }
  // Re-focus the lane the edit happened on, so the reverted change is shown where
  // it landed rather than silently mutating a lane you've since switched away from.
  if (snap.active && S.state.lanes.some((l) => l.id === snap.active))
    S.state.lanes.forEach((l) => (l.active = l.id === snap.active));
  S.selection = new Set();
  S.voicingRevision++;
  window.dispatchEvent(new CustomEvent(STATE_RESTORED));   // and so were the markers' — see above
  refreshCounts(); renderLanes(); draw(); refreshTabIfOpen();
}

// Walkthrough Back restores a specific step boundary, rather than consuming the
// most recent undo entry (which may belong to another step).
export function restoreEditSnapshot(snap) {
  clearMatches();
  restore(snap);
  updateUndoButtons();
  refreshSaveState();
}

export function undo() {
  if (!S.undoStack.length) return;
  clearMatches();
  S.redoStack.push(snapshotEdit());
  restore(S.undoStack.pop());
  updateUndoButtons();
  refreshSaveState();
}

export function redo() {
  if (!S.redoStack.length) return;
  clearMatches();
  S.undoStack.push(snapshotEdit());
  restore(S.redoStack.pop());
  updateUndoButtons();
  refreshSaveState();
}

export function updateUndoButtons() {
  if (undoMI) undoMI.disabled = !S.undoStack.length;
  if (redoMI) redoMI.disabled = !S.redoStack.length;
}

// Slice an arbitrary set of note/time intersections in one undoable change. A
// diagonal slice can cross several pitches (and layers) at different grid times.
export function sliceNoteCuts(cuts) {
  const entries = [...cuts.entries()].filter(([note, at]) => laneOf(note) && Number.isFinite(at));
  if (!entries.length) return [];
  const prev = snapshotEdit(), split = [];
  const touchedShapeIds = new Map();
  for (const [note, at] of entries) {
    const lane = laneOf(note);
    if (!canEditLane(lane)) continue;
    const parts = splitNote(note, at, minDur(), nid);
    if (!parts) continue;
    if (note.shapeId) {
      if (!touchedShapeIds.has(lane)) touchedShapeIds.set(lane, new Set());
      touchedShapeIds.get(lane).add(note.shapeId);
    }
    const index = lane.notes.indexOf(note);
    lane.notes.splice(index, 1, parts.left, parts.right);
    split.push(parts);
  }
  if (!split.length) return [];
  // Removing all members is safer than silently claiming that the original
  // sustained grip now spans two separate attacks. Positions themselves remain.
  for (const [lane, ids] of touchedShapeIds) for (const id of ids) ungroupShape(lane.notes, id);
  for (const lane of editLanes()) cleanupShapeMembership(lane.notes);
  setSelection(new Set(split.map((parts) => parts.right)));
  commit(prev, undefined, new Set(split.map(parts => parts.right.id)));
  refreshCounts(); refreshTabIfOpen(); draw();
  toast(`Sliced ${split.length} note${split.length === 1 ? "" : "s"}`);
  return split;
}

// ---- clipboard / delete ----
export function doCopy() {
  if (!S.selection.size) return;
  S.clipboardSrc = [...S.selection];
  S.clipboard = S.clipboardSrc.map((n) => copyEffects(n, {
    start: n.start, end: n.end, pitch: n.pitch,
    ...(n.shapeId ? { shapeId: n.shapeId } : {}),
    ...(n.shapeSource ? { shapeSource: n.shapeSource } : {}),
  }));
  // Remember the source occurrence when the whole copy sits inside one reference
  // box — that's when Paste offers the copy-vs-reference choice.
  S.clipboardRef = null;
  if (S.clipboardSrc.length) {
    const b0 = boxOfNote(S.clipboardSrc[0]);
    if (b0 && S.clipboardSrc.every((n) => { const b = boxOfNote(n); return b && b.lane === b0.lane && b.ref === b0.ref && b.i === b0.i; }))
      S.clipboardRef = { lane: b0.lane, ref: b0.ref };
  }
}

// Modal choice when pasting notes copied wholesale from a reference. Resolves
// "copy" | "reference" | null (cancel). Mirrors confirmDetectMerge.
export function confirmPasteMode({ signal } = {}) {
  if (signal?.aborted || !pasteBackdrop.hidden) return Promise.resolve(null);
  return new Promise((resolve) => {
    pasteBackdrop.hidden = false;
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      pasteBackdrop.hidden = true;
      pasteCopyBtn.removeEventListener("click", onCopy);
      pasteAsRefBtn.removeEventListener("click", onRef);
      pasteCancelBtn.removeEventListener("click", onCancel);
      pasteBackdrop.removeEventListener("mousedown", onBackdrop);
      window.removeEventListener("keydown", onKey, true);
      signal?.removeEventListener("abort", onCancel);
      resolve(v);
    };
    const onCopy = () => finish("copy");
    const onRef = () => finish("reference");
    const onCancel = () => finish(null);
    const onBackdrop = (e) => { if (e.target === pasteBackdrop) onCancel(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } };
    pasteCopyBtn.addEventListener("click", onCopy);
    pasteAsRefBtn.addEventListener("click", onRef);
    pasteCancelBtn.addEventListener("click", onCancel);
    pasteBackdrop.addEventListener("mousedown", onBackdrop);
    window.addEventListener("keydown", onKey, true);   // capture so it beats the global Esc handlers
    signal?.addEventListener("abort", onCancel, { once: true });
    pasteAsRefBtn.focus();
  });
}

// mode: "copy" | "reference" forces that result; undefined = auto — when the copy
// came entirely from one reference, ask via confirmPasteMode, otherwise plain copy.
export async function doPaste({ mode } = {}) {
  if (!S.clipboard.length || !S.state) return;
  if (mode == null) {
    if (S.clipboardRef == null) mode = "copy";
    else {
      if (!pasteBackdrop.hidden) return;       // a choice is already open
      mode = await confirmPasteMode();
      if (mode == null) return;                // cancelled
    }
  }
  const asReference = mode === "reference";
  // Reference paste lands in the copied group's own lane (so the new box's notes
  // and the box share a lane); otherwise the active edit lane.
  const lane = (asReference && S.clipboardRef && S.clipboardRef.lane.visible) ? S.clipboardRef.lane : targetLane();
  if (!lane) return;
  if (!lane.visible) { toast(`Layer “${lane.name}” is hidden — show it to edit`); return; }
  if (lane.locked) { toast(`Layer “${lane.name}” is locked — unlock it to edit`); return; }
  const prev = snapshotEdit();
  // Anchor the paste at the current time: shift the whole clipboard so its
  // earliest note starts at the playhead, preserving relative timing + pitch.
  const anchor = Math.min(...S.clipboard.map((c) => c.start));
  const dt = snap(Math.max(0, playbackTime())) - anchor;
  // Preserve copied shapes, but mint new ids so the paste is independent from
  // the original. A partial copy needs at least two members to remain a shape.
  const copiedShapeCounts = new Map();
  for (const c of S.clipboard) if (c.shapeId)
    copiedShapeCounts.set(c.shapeId, (copiedShapeCounts.get(c.shapeId) || 0) + 1);
  const pastedShapeIds = new Map();
  const added = S.clipboard.map((c) => {
    // A reference paste must keep the group's shared shape (its anchor is already
    // snapped), so leave its notes relative; a plain paste pulls each note fully
    // onto the grid so nothing lands off-grid.
    const q = asReference ? { start: c.start + dt, end: c.end + dt } : snapNote(c.start + dt, c.end + dt);
    let shapeId;
    if ((copiedShapeCounts.get(c.shapeId) || 0) >= 2) {
      if (!pastedShapeIds.has(c.shapeId)) pastedShapeIds.set(c.shapeId, shapeId());
      shapeId = pastedShapeIds.get(c.shapeId);
    }
    return copyEffects(c, {
      id: nid(), start: q.start, end: q.end, pitch: c.pitch,
      ...(shapeId ? { shapeId } : {}),
      ...(shapeId && c.shapeSource ? { shapeSource: c.shapeSource } : {}),
    });
  });
  lane.notes.push(...added);
  if (asReference) linkPasteAsReference(added, lane);
  commit(prev);
  setSelection(new Set(added));
  S.state.lanes.forEach((l) => (l.active = l === lane));
  renderLanes(); refreshCounts(); draw();
}

// Drop a new box over the just-pasted notes so they become another occurrence of
// the copied group. If the source wasn't a reference, form a fresh group from the
// still-present source notes + the paste. Returns the group number, or null.
function linkPasteAsReference(added, lane) {
  const anchorNew = noteBounds(added).t0;
  if (S.clipboardRef && S.clipboardRef.lane === lane && lane.refBoxes && lane.refBoxes[S.clipboardRef.ref]) {
    lane.refBoxes[S.clipboardRef.ref].anchors.push(anchorNew);
    return S.clipboardRef.ref;
  }
  const src = S.clipboardSrc.filter((n) => laneOf(n) === lane && !boxOfNote(n));
  if (src.length !== added.length) return null;   // nothing intact to pair the paste with
  const ref = nextRef(), nb = noteBounds(added);
  (lane.refBoxes || (lane.refBoxes = {}))[ref] = {
    rt0: 0, rt1: nb.t1 - nb.t0,
    pLo: nb.pLo, pHi: nb.pHi,
    anchors: [noteBounds(src).t0, anchorNew],
  };
  return ref;
}

export function doDelete() {
  if (!S.state) return;
  clearMatches();
  const prev = snapshotEdit();
  let removed = 0;
  for (const lane of editLanes()) {
    if (!canEditLane(lane)) continue;   // hidden / locked lanes are disabled — never delete their notes
    const before = lane.notes.length;
    lane.notes = lane.notes.filter((n) => !S.selection.has(n));
    cleanupShapeMembership(lane.notes);
    removed += before - lane.notes.length;
  }
  S.selection = new Set();
  if (removed) commit(prev);
  refreshCounts(); draw();
}

// Cut = copy the selection, then delete the deletable part (same lane rules as
// Delete).
export function doCut() {
  if (!S.selection.size) return;
  doCopy();
  doDelete();
}

function isTextField(el) {
  return el && (el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && /^(text|number|search|email|url|tel|password)$/.test(el.type)));
}

// M mutes/unmutes the current edit layer; Shift+M the stem (backing) audio.
function muteActiveLane() {
  const lane = targetLane();
  if (!lane) return;
  toggleLaneMute(lane);   // shared with the mute button, so both take ownership of the mute
  toast(`Layer “${lane.name}” ${lane.muted ? "muted" : "unmuted"}`);
}

// Mute a stem in the mixer. No argument (Shift+M) targets the viewed stem.
export function toggleStemMute(stem) {
  if (!S.state) return;
  stem = stem || curStemObj();
  if (!stem) return;
  const isMaster = isMasterStem(stem);
  if (!isMaster) {
    const fullSong = masterStem();
    if (fullSong) fullSong.muted = true;
  }
  stem.muted = !stem.muted;
  if (isMaster && !stem.muted) {
    for (const other of S.state.stems) {
      if (!isMasterStem(other)) { other.muted = false; other.solo = false; }
    }
  }
  applyStemGains();
  renderStemTabs();
  refreshSaveState();
  toast(`${isMaster ? "Full song" : `“${stem.name}”`} ${stem.muted ? "muted" : "unmuted"}`);
}

// Set (kind) or clear (null) the slide on every selected edit note.
function setSlideOnSelection(kind) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) return;
  const prev = snapshotEdit();
  let cleared = false;
  for (const n of notes) {
    if (kind) { cleared = clearConflicts(n, "slide") || cleared; n.slide = kind; } else delete n.slide;
  }
  commit(prev); draw();
  if (cleared) toast("Cleared conflicting effects");
}

// ---- bend (Tier-2): a [t, semi] curve on note.bendPoints, seeded from a preset ----
// The preset id stays on note.bend as the label; bend.js derives the curve from
// it until a control point is dragged, at which point the note carries explicit
// points and reads as "custom".

// Set (id) or clear (null) the bend on every selected edit note. Picking a preset
// drops any hand-edited curve — that's what makes the presets a reset button.
// "custom" starts a neutral three-point curve, ready to drag without having to
// select a preset first.
function setBendOnSelection(kind) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) return;
  const prev = snapshotEdit();
  let cleared = false;
  for (const n of notes) {
    delete n.bendPoints;
    if (kind) {
      cleared = clearConflicts(n, "bend") || cleared;
      n.bend = kind;
      if (kind === "custom") n.bendPoints = [[0, 0], [0.5, 0], [1, 0]];
    } else delete n.bend;
  }
  commit(prev); draw();
  if (cleared) toast("Cleared conflicting effects");
}

// Replace one note's curve (points are never mutated in place — see bend.js).
export function setBendCurve(n, pts) {
  n.bendPoints = normalizeCurve(pts);
  n.bend = "custom";
}

// Add a control point where the curve already runs at `t`, so the new handle
// starts on the line and only moves when dragged.
export function addBendPoint(n, t) {
  const pts = bendCurve(n);
  if (!pts || pts.length >= MAX_POINTS) return;
  const prev = snapshotEdit();
  setBendCurve(n, [...pts.map((p) => [...p]), [t, bendAt(pts, t)]]);
  commit(prev); draw();
}

// Remove a control point. The first and last pin the curve to the note's edges,
// so they stay — only the ones in between can go.
export function removeBendPoint(n, i) {
  const pts = bendCurve(n);
  if (!pts || pts.length <= 2 || i === 0 || i === pts.length - 1) return;
  const prev = snapshotEdit();
  setBendCurve(n, pts.filter((_, k) => k !== i).map((p) => [...p]));
  commit(prev); draw();
}

// ---- harmonic (Tier-2): single type on note.harmonic, exported as a HarmonicEffect ----
// Set (id) or clear (null) the harmonic on every selected edit note.
function setHarmonicOnSelection(kind) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) return;
  const prev = snapshotEdit();
  let cleared = false;
  for (const n of notes) {
    if (kind) { cleared = clearConflicts(n, "harmonic") || cleared; n.harmonic = kind; } else delete n.harmonic;
  }
  commit(prev); draw();
  if (cleared) toast("Cleared conflicting effects");
}

export { EFFECT_FIELDS, FX_GLYPHS, FX_KEYS, FX_LABELS, HARMONIC_TAG, SLAP_TAG, cloneFx, copyEffects, noteMarks } from "./note-effects.js";

// ---- effect conflicts (mutual exclusion across fx flags + own-field effects) ----
// Switching one technique on strips the ones it physically fights (see effects.js),
// so a note can't be e.g. both a dead/muted "X" and bent. Minimal by design —
// only physically-null combos, not musical taste.
const FX_SET = new Set(FX_KEYS);
const hasEffect = (n, name) => (FX_SET.has(name) ? !!(n.fx && n.fx[name]) : n[name] != null);
function dropEffect(n, name) {
  if (FX_SET.has(name)) {
    if (!n.fx || !n.fx[name]) return;
    const fx = { ...n.fx }; delete fx[name];
    if (Object.keys(fx).length) n.fx = fx; else delete n.fx;
  } else if (n[name] != null) {
    delete n[name];
    if (name === "bend") delete n.bendPoints;   // the curve is meaningless without it
  }
}
// Strip every effect conflicting with the one being turned on; returns whether any
// were removed (so the caller can flag it — silent removals are confusing).
function clearConflicts(n, name) {
  let cleared = false;
  for (const other of conflictsWith(name)) if (hasEffect(n, other)) { dropEffect(n, other); cleared = true; }
  return cleared;
}

// Set/clear one effect flag on every selected edit note. Replaces the fx object
// (never mutates it) so the {...n} undo snapshots taken earlier stay intact.
function setFxOnSelection(key, on) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) return;
  const prev = snapshotEdit();
  let cleared = false;
  for (const n of notes) {
    if (on) cleared = clearConflicts(n, key) || cleared;
    const fx = { ...n.fx };
    if (on) fx[key] = true; else delete fx[key];
    if (Object.keys(fx).length) n.fx = fx; else delete n.fx;
  }
  commit(prev); draw();
  if (cleared) toast("Cleared conflicting effects");
}

// ---- single-choice effects (own field on the note, like slide/bend/harmonic) ----
// grace/trill/tremPick are note effects; slap/stroke/whammy are beat effects.
// Set note[field]=kind (or clear when kind is null) on every selected edit note.
function setChoiceOnSelection(field, kind) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) return;
  const prev = snapshotEdit();
  let cleared = false;
  for (const n of notes) {
    if (kind) { cleared = clearConflicts(n, field) || cleared; n[field] = kind; } else delete n[field];
  }
  commit(prev); draw();
  if (cleared) toast("Cleared conflicting effects");
}

// ---- explicit multi-note fretting shapes ----

function groupSelectionIntoShape() {
  const selected = [...S.selection].filter((note) => laneOf(note));
  const lanes = [...new Set(selected.map(laneOf))];
  if (selected.length < 2) { toast("Select at least two notes to create a shape"); return false; }
  if (lanes.length !== 1) { toast("A shape must stay within one note layer"); return false; }
  const lane = lanes[0];
  if (!canEditLane(lane)) return false;
  const tuning = laneTuning(lane);
  // Preserve a coherent authored/manual grip. Automatic lanes otherwise get one
  // joint voicing; exact GP positions are never silently rewritten.
  const positions = chooseShapePositions(selected, tuning,
    { allowAutomatic: lane.fingeringMode !== "exact" });
  if (!positions) {
    toast(lane.fingeringMode === "exact"
      ? "Those authored positions cannot be held as one shape"
      : "No playable shared shape was found for those notes");
    return false;
  }
  const prev = snapshotEdit(), id = shapeId();
  for (const note of selected) {
    const pos = positions.get(note);
    note.shapeId = id;
    note.shapeSource = "manual";
    note.pos = { string: pos.string, fret: pos.fret, scope: "local" };
    delete note.arrangement;
  }
  cleanupShapeMembership(lane.notes);
  commit(prev); draw(); refreshTabIfOpen();
  toast(`Created shape from ${selected.length} notes`);
  return true;
}

function selectEntireShape() {
  const selected = [...S.selection].filter((note) => laneOf(note));
  const ids = [...new Set(selected.map((note) => note.shapeId).filter(Boolean))];
  if (ids.length !== 1) return false;
  const member = selected.find((note) => note.shapeId === ids[0]);
  const lane = member && laneOf(member);
  const members = lane ? shapeGroups(lane.notes).get(ids[0]) : null;
  if (!members?.length) return false;
  setSelection(new Set(members)); draw();
  return true;
}

function ungroupSelectedShapes() {
  const touched = new Map();
  for (const note of S.selection) {
    const lane = laneOf(note);
    if (lane && note.shapeId) {
      if (!touched.has(lane)) touched.set(lane, new Set());
      touched.get(lane).add(note.shapeId);
    }
  }
  if (!touched.size) return false;
  const prev = snapshotEdit();
  for (const [lane, ids] of touched)
    for (const note of lane.notes) if (ids.has(note.shapeId)) {
      delete note.shapeId; delete note.shapeSource;
    }
  commit(prev); draw(); refreshTabIfOpen();
  toast("Shape removed");
  return true;
}

// ---- fingering / position override (manual pin over the auto voicing) ----
// The voicing engine picks the "best" string/fret per onset-column; sometimes a
// worse-scoring position is the one you want (e.g. a fretted note so a slide is
// playable). Rather than free placement, you cycle the column through its ranked
// playable shapes, pinning the chosen one on each note's `pos`. Single notes are
// just a column of one; whole chords move as a shape (no two notes per string).

// The onset-column (same grouping the engine + export use) that `note` sits in,
// with its edit lane and tuning. null for notes not in an edit lane.
export function columnOf(note) {
  const lane = laneOf(note);
  if (!lane) return null;
  const col = chordColumns(lane.notes).find((c) => c.notes.includes(note));
  return col ? { lane, tuning: laneTuning(lane), col } : null;
}

// One-line description of a shape for the menu/toast: "A string · fret 7",
// "open", or a chord's per-string frets + lowest position.
// Pin the column to `shape` (Map note -> {string, fret}) or, when null, clear the
// pin so the column voices automatically again. Directional influence rides on
// each note's pos so the override's reach survives copy/paste and save.
function applyColumnPos(colNotes, shape, scope = "local", influence = null) {
  const flow = normalizeOverrideInfluence(influence);
  const want = (n) => (shape && shape.has(n) ? shape.get(n) : null);
  const same = (a, b) => (!a && !b) ||
    // A pin with no stored scope is a "local" pin: every writer stamps "local",
    // and reference-core defaults to it. Only old projects store an explicit
    // "forward" (voicing-core's legacyForward anchor), and those are untouched
    // here. Defaulting to "forward" made an unchanged column compare as changed,
    // so re-applying the same shape rewrote it and cost an undo step.
    (a && b && a.string === b.string && a.fret === b.fret && (a.scope || "local") === scope &&
      a.influencePrevious === flow.previous && a.influenceNext === flow.next);
  if (colNotes.every((n) => same(n.pos || null, want(n)))) return;
  const prev = snapshotEdit();
  for (const id of new Set(colNotes.map((n) => n.shapeId).filter(Boolean))) {
    const lane = laneOf(colNotes.find((n) => n.shapeId === id));
    if (lane) ungroupShape(lane.notes, id);
  }
  for (const n of colNotes) {
    const p = want(n);
    if (p) n.pos = {
      string: p.string, fret: p.fret, scope,
      influencePrevious: flow.previous, influenceNext: flow.next,
    };
    else delete n.pos;
  }
  commit(prev); draw();
  refreshTabIfOpen();
}

// Turn one side of an override's reach on or off, in place on the pin that carries
// it. Nothing else about the override changes, so this is not a re-application: the
// shape stays exactly as chosen and only its blast radius moves.
//
// Written as a new object rather than mutated, because the undo snapshot shares the
// note's own `pos` reference and editing it in place would rewrite history too.
export function setColumnInfluence(colNotes, direction, on) {
  const key = direction === "previous" ? "influencePrevious" : "influenceNext";
  const prev = snapshotEdit();
  let touched = false;
  for (const n of colNotes) for (const field of ["pos", "arrangement"]) {
    if (!n[field] || n[field][key] === on) continue;
    n[field] = { ...n[field], [key]: on };
    touched = true;
  }
  if (!touched) return;
  commit(prev); draw(); refreshTabIfOpen();
}

// Unified shape chooser used by the fretboard's offer. Choosing an alternative
// rewrites the column to what that shape plays — pins for the notes it keeps,
// deletions for the ones it drops, real new notes for the ones it adds — so the
// spectrogram afterwards is what the neck showed. null returns the column to
// automatic (pins only; a deleted note comes back through undo).
export function applyColumnAlternative(colNotes, choice, influence = null) {
  const prev = snapshotEdit();
  if (writeAlternative(colNotes, choice, influence)) { commit(prev); draw(); refreshTabIfOpen(); }
}

// The write itself, with no snapshot of its own, so a caller undoing two things at
// once can put both inside one step (see clearOverrideAt).
function writeAlternative(colNotes, choice, influence) {
  const lane = laneOf(colNotes?.[0]);
  if (!lane) return false;
  const flow = normalizeOverrideInfluence(influence || overrideInfluence(colNotes));
  for (const id of new Set(colNotes.map((n) => n.shapeId).filter(Boolean))) ungroupShape(lane.notes, id);
  const { notes, column } = writeColumnOverride(lane.notes, colNotes, choice, flow, nid);
  const rewritten = notes !== lane.notes;
  lane.notes = notes;
  // Notes came or went, so the selection still points at objects that have left
  // the lane. Reselect the column as it now stands.
  if (rewritten) setSelection(new Set(column));
  return true;
}

// WHERE THE FRETTING HAND STANDS, put there by hand. `{ t, fret }` on the lane and
// deliberately not a pin on a note: a hold says "the hand is on this fret from this
// beat", which is a fact about the player and not about any one note, and the voicer
// already charges to leave a register — so one hold re-fingers a whole phrase without
// locking a single column. That is the difference from applyColumnAlternative, which
// decides one column exactly and says nothing about the hand around it.
//
// Placing the fret already held there clears it, so the gesture that makes a hold is
// the gesture that takes it back and the neck needs no second control for undoing
// what a click on it did.
//
// It reaches BACKWARDS as well as forwards, and that is not a bug: the register solve
// is a Viterbi, so a hand held at fret 12 changes how the phrase arrives there too. A
// player does not teleport into a position.
// THE HAND GOES WHERE YOU POINT, AND NOWHERE ELSE. This used to second-guess: a fret
// already inside the hand's four-fret reach was read as "play the note there" rather
// than "shift", so the grip stayed put and only the pull moved. The reasoning was
// sound and the behaviour was wrong, for a reason the neck makes obvious at the nut —
// a hand at fret 1 reaches 1 to 4, so near the nut almost every fret you could point
// at is "already in reach" and the hand becomes unmovable. Worse, the seat it tested
// against is read BACK off the notes (the lowest fretted fret in the block), so a bar
// of open strings reports a hand at 1 that nobody put there and that nothing can move.
//
// The guess also no longer has a job. It existed because pointing at a fret was the
// only way to ask for a note somewhere else; the neck now offers every position of a
// note as a ring you click (setNotePosition), which moves the note and never touches
// the hand. So the two edits are two gestures, and neither has to infer the other.
export function setHandHold(lane, t, fret) {
  if (!lane || !Number.isFinite(t) || !Number.isFinite(fret) || fret < 0) return;
  const near = (h) => Math.abs(Number(h.t) - t) <= 1e-6;
  const had = (lane.handHolds || []).find(near);
  const rest = (lane.handHolds || []).filter((h) => !near(h));
  const prev = snapshotEdit();
  const same = had && Number(had.fret) === fret;
  lane.handHolds = (same ? rest : [...rest, { t, fret }]).sort((a, b) => a.t - b.t);
  commit(prev); draw(); refreshTabIfOpen();
}

// A WHOLE CHORD, PLACED BY HAND. The neck's candidates are the shapes the engine can
// build and rank, and a player who wants one it never offered has to be able to state
// it outright — a string and a fret per note, and nothing else.
//
// Checked before it is written, because this is the one path where the shape did not
// come out of the enumerator and so nothing upstream has vouched for it. The three
// things that make a shape real are the three lockedShape asks of a stored pin, and a
// pin that fails them lapses silently: every note placed, no two notes on one string,
// and each placement actually sounding its note. Playability is deliberately NOT
// among them — "a shape that isn't there" is the whole point, and a hand that can hold
// it is the player's problem to judge, not the engine's to veto.
//
// Returns null when it wrote, or the sentence saying what is wrong.
export function setColumnShape(colNotes, shape) {
  const lane = laneOf(colNotes?.[0]);
  if (!lane) return "These notes are not in an editable note layer";
  const wrong = shapeFault(colNotes, laneTuning(lane), shape);
  if (wrong) return wrong;
  applyColumnPos(colNotes, shape, "local", overrideInfluence(colNotes));
  return null;
}

// ONE NOTE, PUT WHERE THE PLAYER WANTS IT. The neck's candidate boxes offer whole
// grips the engine ranked; this is the other grain of the same question — a shape
// nobody ranked, built a note at a time.
//
// The rest of the column is written out with it, and that is not the edit widening
// itself: lockedShape is all-or-nothing (a column with one pin and three free notes
// voices as if nothing were pinned), so "this note here" can only be said by stating
// the whole column. The others keep exactly the places they already had, so the
// change on screen is the one note that moved.
export function setNotePosition(note, string, fret) {
  const ctx = columnOf(note);
  if (!ctx) return;
  // The same solve the tab was voiced under, so "where the others already are" is
  // what is on screen and not a second engine's answer.
  const voiced = voiceNotes(ctx.lane.notes, ctx.tuning, Infinity,
    { bars: songBarStarts(), instrument: ctx.lane.instrument, holds: ctx.lane.handHolds });
  const shape = new Map();
  for (const n of ctx.col.notes) {
    const p = n === note ? { string, fret } : voiced.get(n);
    if (!p) return;                       // a column the voicer could not place
    shape.set(n, { string: p.string, fret: p.fret });
  }
  applyColumnPos(ctx.col.notes, shape, "local", overrideInfluence(ctx.col.notes));
}

// THE WAY BACK OFF EVERYTHING THE NECK CAN PUT ON ONE BEAT: the shape pinned there
// and the hand standing under it. One entry and one undo step, because they were one
// decision — "this bit is mine" — and taking half of it back leaves the neck showing
// an override the button just said was gone.
//
// It replaced a second button that cleared every hold in the lane at once. A hand plan
// is not read as a whole: you fix the one bar that came out wrong, and wiping the other
// twenty is a bigger act than anything else on the panel offers.
export function clearOverrideAt(lane, colNotes, t) {
  const prev = snapshotEdit();
  let touched = false;
  if (lane?.handHolds?.length && Number.isFinite(t)) {
    const rest = lane.handHolds.filter((h) => Math.abs(Number(h.t) - t) > 1e-6);
    if (rest.length !== lane.handHolds.length) { lane.handHolds = rest; touched = true; }
  }
  if (colNotes?.some((n) => n.pos || n.arrangement || n.written))
    touched = writeAlternative(colNotes, null, null) || touched;
  if (!touched) return;
  commit(prev); draw(); refreshTabIfOpen();
}

// What the right-click menu offers, as data. Grouped by what an effect DOES to
// the note rather than by how it is stored, so a boolean toggle (vibrato) and a
// variant picker (bend) can sit in the same family — the filter box searches
// labels and `kw` synonyms, so guessing the wrong family is not a dead end.
//
//   toggle    a boolean flag in note.fx; renders as a checkable item
//   field+set a variant on note[field]; renders as a radio submenu, `variants`
//             being [value, label] pairs with null meaning "clear"
//   only      "chord" or "single" — entries that make sense for only one
//
// Adding an effect is an entry here plus its setter; openNoteMenu below does not
// need to know it exists.
const EFFECT_MENU = [
  { label: "Bends & slides", kw: "pitch expression", items: [
    { toggle: "vibrato", kw: "wobble" },
    // Presets seed the curve; drag its points on the spectrogram to fit the audio.
    { field: "bend", label: "Bend", kw: "pitch curve", set: setBendOnSelection, variants: [
      [null, "None"], ["quarter", "¼ bend"], ["half", "½ bend"], ["full", "Full bend"],
      ["onehalf", "1½ bend"], ["twostep", "2-step bend"],
      ["release", "Bend & release"], ["bendReleaseBend", "Bend, release, bend"],
      ["prebend", "Prebend"], ["prebendRelease", "Prebend & release"],
      ["custom", "Custom curve"],
    ] },
    { field: "slide", label: "Slide", kw: "glide glissando", set: setSlideOnSelection, variants: [
      [null, "None"], ["shift", "Shift → next"], ["legato", "Legato → next"],
      ["inBelow", "In from below ↗"], ["inAbove", "In from above ↘"],
      ["outDown", "Out downward ↓"], ["outUp", "Out upward ↑"],
    ] },
    { field: "whammy", label: "Whammy bar", kw: "tremolo arm dive bar", set: (v) => setChoiceOnSelection("whammy", v), variants: [
      [null, "None"], ["dip", "Dip"], ["dive", "Dive"],
    ] },
    { only: "single", field: "trill", label: "Trill", kw: "ornament", set: (v) => setChoiceOnSelection("trill", v), variants: [
      [null, "None"], ["half", "½-step"], ["whole", "Whole-step"],
    ] },
    { only: "single", field: "grace", label: "Grace note", kw: "ornament acciaccatura lead-in", set: (v) => setChoiceOnSelection("grace", v), variants: [
      [null, "None"], ["half", "½-step below"], ["whole", "Whole-step below"],
    ] },
  ] },
  { label: "Muting & dynamics", kw: "attack volume", items: [
    { toggle: "accent", kw: "loud emphasis" },
    { toggle: "ghost", kw: "quiet" },
    { toggle: "dead", kw: "x mute muted choke" },
    { toggle: "staccato", kw: "short detached" },
    { toggle: "palmMute", kw: "pm damp" },
    { toggle: "letRing", kw: "lr sustain ring" },
  ] },
  { label: "Picking & tapping", kw: "technique hand", items: [
    { toggle: "hammer", kw: "ho po legato pull-off" },
    { field: "harmonic", label: "Harmonic", kw: "chime", set: setHarmonicOnSelection, variants: [
      [null, "None"], ["natural", "Natural ◇"], ["pinch", "Pinch (P.H.)"],
    ] },
    { field: "tremPick", label: "Tremolo pick", kw: "repick", set: (v) => setChoiceOnSelection("tremPick", v), variants: [
      [null, "None"], ["8", "8th"], ["16", "16th"], ["32", "32nd"],
    ] },
    { field: "slap", label: "Slap / pop", kw: "thumb bass tapping", set: (v) => setChoiceOnSelection("slap", v), variants: [
      [null, "None"], ["tap", "Tapping"], ["slap", "Slapping"], ["pop", "Popping"],
    ] },
    { only: "chord", field: "stroke", label: "Strum", kw: "brush rake chord", set: (v) => setChoiceOnSelection("stroke", v), variants: [
      [null, "None"], ["up", "Strum up ⤴"], ["down", "Strum down ⤵"],
    ] },
  ] },
];

// ---- note context menu (right-click): note effects + delete ----
export let noteMenuEl = null;
let walkthroughMenuAction = null;
let menuOpenCount = 0;
export const walkthroughMenuOpenCount = () => menuOpenCount;

export function restrictContextMenuTo(action = null) {
  walkthroughMenuAction = action;
  hideNoteMenu();
}

export function hideNoteMenu() { if (noteMenuEl) noteMenuEl.hidden = true; }

// Lazily create the shared context-menu element (reused by the note menu and the
// empty-canvas menu) and wire its outside-click dismissal once.
function ensureCtxMenu() {
  if (!noteMenuEl) {
    noteMenuEl = document.createElement("div");
    noteMenuEl.className = "ctxmenu";
    document.body.appendChild(noteMenuEl);
    document.addEventListener("mousedown", (ev) => {
      if (inTourCard(ev.target)) return;
      if (noteMenuEl && !noteMenuEl.hidden && !noteMenuEl.contains(ev.target)) hideNoteMenu();
    });
  }
  return noteMenuEl;
}

function placeCtxMenu(m, clientX, clientY) {
  m.hidden = false;
  // Open submenus to the left when the menu sits in the right half of the view.
  m.classList.toggle("ctxmenu-left", clientX > window.innerWidth / 2);
  placeFloating(m, clientX, clientY, 0);
}

// Keyboard invocation has no pointer location. Anchor its menu beside the
// selected notes instead, flipping to their left when the right edge is full.
function placeNoteMenuBySelection(m, fallbackX, fallbackY) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) { placeCtxMenu(m, fallbackX, fallbackY); return; }
  const { t0, t1, pHi } = noteBounds(notes);
  const r = stage.getBoundingClientRect(), margin = 10;
  const leftX = xOf(t0) - scroll.scrollLeft + r.left;
  const rightX = xOf(t1) - scroll.scrollLeft + r.left;
  const topY = yOf(pHi) - scroll.scrollTop + r.top;
  let x = rightX + margin;
  if (x + m.offsetWidth > window.innerWidth - 6) x = leftX - m.offsetWidth - margin;
  placeCtxMenu(m, x, topY);
}

// Empty-spectrogram right-click: detection + paste live here (not in the sidebar).
// atTime = the song time under the cursor, so "Add marker" drops it right there.
export function openCanvasMenu(clientX, clientY, atTime) {
  const m = ensureCtxMenu(); m.innerHTML = "";
  // Nothing offers to add a marker while the marker layer is off: it would land
  // on a strip nobody can see. Turn the lanes back on from View first.
  const addMarker = railsHidden() ? [] : [
    { label: "Add tempo / meter marker", fn: () => addMarkerAtTime(atTime, clientX, clientY) },
    ...railMenuItems(atTime, clientX, clientY),   // sections, phrases, tones
  ];
  const entries = [
    { label: "Detect notes…", fn: () => openDetectPanel(clientX, clientY) },
    ...addMarker,
    { sep: true },
    { label: "Paste", fn: () => doPaste() },
  ];
  buildMenu(m, entries);
  markWalkthroughMenu(m);
  menuOpenCount++;
  placeCtxMenu(m, clientX, clientY);
}

// Right-clicking a reference badge: a minimal, reference-only menu — no note
// effects and no filter box (those don't apply to a reference). Acts on the
// occurrence the badge identifies (so it works even for an empty box); Detach
// operates on the current selection, which the caller set to the box's notes.
export function openRefMenu(clientX, clientY, occ) {
  const m = ensureCtxMenu(); m.innerHTML = "";
  // Copy reads the current selection (the box's notes, set by the caller) and
  // remembers the source reference, so Paste can re-link it as a new occurrence.
  // Cut copies, then removes the whole occurrence (box + notes) — not just the
  // notes, which would leave an empty box behind.
  buildMenu(m, [
    { label: `Reference #${occ.ref}`, header: true },
    { label: "Copy", fn: () => doCopy() },
    { label: "Cut", fn: () => { doCopy(); deleteRefOccurrence(occ); } },
    { sep: true },
    { label: "Delete this occurrence", fn: () => deleteRefOccurrence(occ) },
    { label: "Delete entire reference", fn: () => deleteRefGroup(occ.lane, occ.ref) },
    { sep: true },
    { label: "Detach (unlink, keep notes)", fn: () => detachSelection() },
  ]);
  markWalkthroughMenu(m);
  menuOpenCount++;
  placeCtxMenu(m, clientX, clientY);
}

// Human-readable names for the single-choice effects (used by the quick-remove
// strip; fx flags use FX_LABELS, bend/slide/harmonic are named inline below).
const CHOICE_NAME = { whammy: "Whammy bar", trill: "Trill", grace: "Grace note", tremPick: "Tremolo pick", slap: "Slap / pop", stroke: "Strum" };

// Effects present on ANY selected note, each with a clear() that strips it from
// the whole selection — powers the right-click quick-remove strip.
function appliedEffects(sel) {
  const any = (f) => sel.some(f), out = [];
  for (const k of FX_KEYS) if (any((n) => n.fx && n.fx[k]))
    out.push({ label: FX_LABELS[k], clear: () => setFxOnSelection(k, false) });
  if (any((n) => n.bend)) out.push({ label: "Bend", clear: () => setBendOnSelection(null) });
  if (any((n) => n.slide)) out.push({ label: "Slide", clear: () => setSlideOnSelection(null) });
  if (any((n) => n.harmonic)) out.push({ label: "Harmonic", clear: () => setHarmonicOnSelection(null) });
  for (const f of ["whammy", "trill", "grace", "tremPick", "slap", "stroke"])
    if (any((n) => n[f])) out.push({ label: CHOICE_NAME[f], clear: () => setChoiceOnSelection(f, null) });
  return out;
}

// The fretboard, reached from the notes you just right-clicked. Both entries go
// through the View menu's own item rather than importing fretboard.js — which
// imports from this file — and pressing that item is the one path that cannot end
// up disagreeing with its check mark. Idempotent: "show" means show, so a panel
// already open is left alone rather than toggled shut, and an entry that would do
// nothing is not offered at all.
const fretboardShown = () => !$("menuFretboardCheck").hidden;
const showFretboard = () => { if (!fretboardShown()) $("menuFretboard").click(); };

function fretboardEntries() {
  return [
    ...(fretboardShown() ? [] : [{
      label: "Show on fretboard", kw: "neck guitar grip hand fingering diagram",
      fn: showFretboard,
    }]),
  ];
}

// Find similar and its passage navigation. These were four toolbar buttons that
// appeared whenever anything was selected, three of them greyed out until a search
// was running; they act on the selection, so they belong on it. The nav entries
// keep the menu open, which the strip could not beat: stepping through hits is a
// repeated action, and closing the menu after each step would cost more clicks
// than the buttons ever did.
function similarEntries() {
  return [
    { label: "Find similar passage", kw: "search match repeat copies duplicate", fn: runFindSimilar },
    ...(S.matches.length ? [
      { label: "Previous similar passage", kw: "search match back", keepOpen: true,
        fn: () => focusAdjacentMatch(-1, { preview: true }) },
      { label: "Preview similar passage", kw: "search match listen audition", keepOpen: true,
        fn: previewFocusedMatch },
      { label: "Next similar passage", kw: "search match forward", keepOpen: true,
        fn: () => focusAdjacentMatch(1, { preview: true }) },
    ] : []),
    { sep: true },
  ];
}

export function openNoteMenu(clientX, clientY, { nearSelection = false } = {}) {
  if (![...S.selection].some((n) => laneOf(n))) return;   // nothing actionable
  const m = ensureCtxMenu();
  m.innerHTML = "";
  const place = () => nearSelection
    ? placeNoteMenuBySelection(m, clientX, clientY)
    : placeCtxMenu(m, clientX, clientY);
  const sel = [...S.selection].filter((n) => laneOf(n));
  // 2+ selected notes = a chord: chord-level Strum becomes available and the
  // single-pitch ornaments (Grace, Trill) drop out; one note is the reverse.
  // (Gates on selection size — a strum across a non-simultaneous run is possible
  // but uncommon, so we don't try to detect onset columns here.)
  const isChord = sel.length > 1;
  // One on/off note flag as a menu toggle. ✓ when every selected note already
  // carries it; clicking toggles them all off. `kw` adds search-only synonyms.
  const fxItem = (key, kw) => {
    const on = sel.every((n) => n.fx && n.fx[key]);
    return { label: (on ? "✓ " : "") + FX_LABELS[key], kw, fn: () => setFxOnSelection(key, !on) };
  };
  // The variant every selected note shares for `field` (null if they differ / none).
  const common = (field) => {
    const v = sel[0][field] ?? null;
    return sel.every((n) => (n[field] ?? null) === v) ? v : null;
  };
  // A variant-picker submenu with ✓ on the active choice (radio-style, so "None"
  // is ticked when nothing is set) and on the parent when any variant is applied.
  // opts = [[value, label], …]; value null is the clear item.
  const pick = (field, label, kw, set, opts) => {
    const cur = common(field);
    return { label: (cur ? "✓ " : "") + label, kw,
      children: opts.map(([v, l]) => ({ label: (cur === v ? "✓ " : "") + l, fn: () => set(v) })) };
  };
  const families = EFFECT_MENU
    .filter((family) => !family.only || family.only === (isChord ? "chord" : "single"))
    .map((family) => ({
      family: true, label: family.label, kw: family.kw,
      children: family.items
        .filter((item) => !item.only || item.only === (isChord ? "chord" : "single"))
        .map((item) => (item.toggle
          ? fxItem(item.toggle, item.kw)
          : pick(item.field, item.label, item.kw, item.set, item.variants))),
    }));

  // Declarative menu: { label, fn } = action, { label, children } = hover submenu,
  // { keepOpen: true } = an action you repeat, so the menu survives the click.
  // { sep:true } = divider, { family:true } = a top-level grouping (transparent to
  // search, so results read "Bend · full", not "Bends & slides · Bend · full").
  // The reference entry only for an un-referenced selection; notes already inside a
  // reference return null here (managed via the badge → openRefMenu). Drop the entry
  // and its divider entirely when it doesn't apply.
  const refEntry = refMenuEntry(sel);
  const selectedShapeIds = [...new Set(sel.map((n) => n.shapeId).filter(Boolean))];
  const oneLane = new Set(sel.map(laneOf)).size === 1;
  const shapeActions = [
    ...(sel.length >= 2 && oneLane ? [{ label: "Group selection into shape", fn: groupSelectionIntoShape }] : []),
    ...(selectedShapeIds.length === 1 ? [{ label: "Select entire shape", fn: selectEntireShape }] : []),
    ...(selectedShapeIds.length ? [{ label: "Ungroup shape", fn: ungroupSelectedShapes }] : []),
  ];
  // "Return to automatic" is the one thing the deleted Tab preview sidebar owned
  // that the neck does not: a way back off an override. It shows only on a column
  // that has one, so the menu on plain notes is unchanged — and it names the state
  // it restores, not the act of undoing. It is also available on the fretboard.
  const pinnedNote = sel.find((n) => n.pos || n.arrangement || n.written);
  const pinnedCol = pinnedNote ? columnOf(pinnedNote)?.col : null;
  // HOW FAR AN OVERRIDE REACHES IS ON THE NECK NOW, not here. Both halves of that
  // question are about grips the fretboard is drawing — how far this one re-fingers
  // its neighbours is exactly what onion skin ghosts either side of it — so two rows
  // of text describing something a few pixels away was the wrong home for it.
  //
  // The way BACK off an override stays in both places, and the split is not a
  // compromise: reach only means anything while you can see the neighbours it moves,
  // where "return this column to automatic" is about one column and is wanted
  // wherever you are.
  const columnActions = [
    ...fretboardEntries(),
    ...(pinnedCol
      ? [{ label: "Return to automatic", kw: "reset unpin fingering position voicing",
        fn: () => applyColumnAlternative(pinnedCol.notes, null) }]
      : []),
    ...(shapeActions.length === 1
      ? [{ ...shapeActions[0], kw: "shape group arpeggio fingering" }]
      : shapeActions.length > 1
        ? [{ label: "Shape", kw: "group arpeggio fingering", children: shapeActions }]
        : []),
  ];
  const tree = [
    // Grouping a selection leads the menu. It sat under the whole effect tree,
    // which is where you put something nobody reaches for — and while charting a
    // song built on repeats it is the first thing you do to a selection, not the
    // last. Every entry above a divider is conditional, so the divider is too: a
    // menu that opens on a rule is the same accident as an inset one.
    ...(refEntry ? [refEntry, { sep: true }] : []),
    ...(columnActions.length ? [...columnActions, { sep: true }] : []),
    ...similarEntries(),
    ...families,
    { sep: true },
    { label: "Delete", kw: "remove erase", fn: () => doDelete() },
  ];
  // Quick-remove strip pinned above the effect tree: one click strips an applied
  // effect, no submenu diving. keepOpen re-renders the menu in place so several
  // can be cleared in a row. Browse-only — kept out of the flat search list.
  const applied = appliedEffects(sel).map((a) => ({
    label: "✕ " + a.label, keepOpen: true,
    fn: () => { a.clear(); openNoteMenu(clientX, clientY, { nearSelection }); },
  }));
  const appliedSection = applied.length
    ? [{ label: "Applied — click to remove", header: true }, ...applied, { sep: true }]
    : [];

  // Pinned filter box over two stacked views: the grouped browse menu (when the
  // box is empty) and a flat results list (while filtering). Search is the fast
  // path; the families are the browse fallback.
  const search = document.createElement("input");
  search.className = "ctxmenu-search"; search.type = "text";
  search.placeholder = "Search effects…"; search.spellcheck = false;
  const browse = document.createElement("div");
  const results = document.createElement("div"); results.className = "ctxmenu-results"; results.hidden = true;
  buildMenu(browse, [...appliedSection, ...tree]);
  m.append(search, browse, results);
  markWalkthroughMenu(m);
  menuOpenCount++;

  // The input is explicitly an effects search: contextual actions such as Tab
  // preview, shaping, references, and Delete remain browse-only.
  const flat = flattenActions(families);
  let matches = [], hi = 0;
  const paint = () => [...results.children].forEach((c, i) => c.classList.toggle("ctxmenu-hi", i === hi));
  const renderResults = () => {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    results.innerHTML = ""; hi = 0;
    if (!terms.length) { browse.hidden = false; results.hidden = true; matches = []; place(); return; }
    browse.hidden = true; results.hidden = false;
    matches = flat.filter((a) => terms.every((t) => a.search.includes(t))).slice(0, 12);
    if (!matches.length) {
      const none = document.createElement("div"); none.className = "ctxmenu-empty"; none.textContent = "No matching effect";
      results.append(none);
    } else matches.forEach((a, i) => {
      const b = document.createElement("button"); b.className = "ctxmenu-item"; b.textContent = a.display;
      b.onclick = () => { a.fn(); hideNoteMenu(); };
      b.addEventListener("mousemove", () => { if (hi !== i) { hi = i; paint(); } });
      results.append(b);
    });
    markWalkthroughMenu(m);
    paint(); place();
  };
  search.addEventListener("input", renderResults);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!matches.length) return;
      hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      paint(); results.children[hi].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault(); if (matches[hi]) { matches[hi].fn(); hideNoteMenu(); }
    }
  });

  place();
  search.focus({ preventScroll: true });
}

// Opens the selected-note effects menu without needing a mouse position. Returns
// whether there was an editable selected note, so Tab can retain its usual focus
// behaviour when the current selection is not actionable.
function openSelectedNoteMenu() {
  if (![...S.selection].some((n) => laneOf(n))) return false;
  openNoteMenu(0, 0, { nearSelection: true });
  return true;
}

// Flatten a menu tree to a searchable list of leaf actions for the filter box.
// Family groupings are transparent (their label is dropped); a non-family parent
// (Bend, Harmonic, Reference #2) prefixes its children so a hit reads "Bend ·
// full". `kw` rides along as hidden synonyms — matched, but never shown.
function flattenActions(entries, crumb = "", crumbKw = "") {
  const out = [];
  for (const e of entries) {
    if (e.sep) continue;
    if (e.children) {
      if (e.family) out.push(...flattenActions(e.children));
      else out.push(...flattenActions(e.children, e.label.replace(/^✓ /, ""), e.kw || ""));
    } else if (e.fn) {
      const display = crumb ? `${crumb} · ${e.label}` : e.label;
      out.push({ display, search: `${crumb} ${e.label} ${crumbKw} ${e.kw || ""}`.toLowerCase(), fn: e.fn });
    }
  }
  return out;
}

// Render menu entries into `parent`, recursing for hover submenus.
function buildMenu(parent, entries) {
  for (const e of entries) {
    if (e.sep) {
      const d = document.createElement("div"); d.className = "ctxmenu-sep"; parent.append(d);
    } else if (e.header) {
      const d = document.createElement("div"); d.className = "ctxmenu-label"; d.textContent = e.label; parent.append(d);
    } else if (e.children) {
      const wrap = document.createElement("div"); wrap.className = "ctxmenu-sub";
      if (e.family) wrap.classList.add("ctxmenu-family");
      const row = document.createElement("button"); row.type = "button"; row.className = "ctxmenu-item ctxmenu-parent"; row.textContent = e.label;
      const child = document.createElement("div"); child.className = "ctxmenu ctxmenu-child";
      buildMenu(child, e.children);
      wrap.append(row, child); parent.append(wrap);
      wireContextSubmenu(wrap, row, child);
    } else {
      const b = document.createElement("button"); b.className = "ctxmenu-item"; b.textContent = e.label;
      b.onclick = () => { e.fn(); if (!e.keepOpen) hideNoteMenu(); };
      parent.append(b);
    }
  }
}

function markWalkthroughMenu(menu) {
  const action = walkthroughMenuAction;
  if (!action) return;
  for (const button of menu.querySelectorAll("button.ctxmenu-item")) {
    const label = button.textContent.replace(/^[✓✕]\s*/, "");
    const wanted = action === "noteEffects"
      ? !!button.closest(".ctxmenu-family, .ctxmenu-results") || button.textContent.startsWith("✕ ")
      : label.startsWith(action);
    button.disabled = !wanted;
    button.classList.toggle("tour-menu-target", wanted);
  }
  for (const row of menu.querySelectorAll(".ctxmenu-family > .ctxmenu-parent"))
    row.classList.toggle("tour-menu-target", action === "noteEffects");
  const search = menu.querySelector(".ctxmenu-search");
  if (search) search.disabled = action !== "noteEffects";
}

export function init_edit() {
  registerEscapeLayer(ESC_DEPTH.popover, () => {
    if (!noteMenuEl || noteMenuEl.hidden) return false;
    hideNoteMenu(); return true;
  });
  // The New Project modal and the stem settings panel each register their own
  // modal-depth layer, in new-project.js and stem-settings.js.
  registerEscapeLayer(ESC_DEPTH.view, () => {
    if (!tabViewOn()) return false;
    setView("spec"); return true;
  });
  // Copy / Cut / Paste / Delete are driven by the Edit menu and keyboard shortcuts
  // (their toolbar buttons were removed in the menu-bar refactor).
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Space = play/pause from anywhere (suppress button clicks / page scroll),
    // except while typing in a text field where a space is a real character.
    if (matchKey(e, "playPause")) {
      if (!isTextField(e.target)) { e.preventDefault(); ensureTone().then(togglePlay); }
      return;
    }
    if (mod && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (S.state) saveProject({ saveAs: e.shiftKey });
      return;
    }
    if (mod && (e.key === "n" || e.key === "N")) { e.preventDefault(); openNewProject(); return; }
    if (mod && (e.key === "o" || e.key === "O")) { e.preventDefault(); openProject(); return; }
    // Overlays register themselves; see escape-stack.js for the depth order.
    if (e.key === "Escape" && closeTopmost()) { e.preventDefault(); return; }
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
    if (!mod && !e.altKey && e.key === "Tab" && openSelectedNoteMenu()) {
      e.preventDefault();
      return;
    }
    if (matchKey(e, "resetZoom")) { e.preventDefault(); resetZoom(); return; }
    // Similar-passage search: F finds; arrows jump+preview; Enter places focus.
    if (e.key === "Escape" && S.matches.length) { e.preventDefault(); clearMatches(); draw(); return; }
    if (!mod && S.matches.length && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault(); focusAdjacentMatch(e.key === "ArrowRight" ? 1 : -1, { preview: true }); return;
    }
    // ← → walk the song a chord at a time, from the playhead, and ↑ ↓ pick between
    // the columns sounding at once where a held note and a moving line are not one
    // chord. Both used to belong to the tab preview, which made reading a piece a
    // property of a window being open — they are the app's, and the fretboard and
    // the spectrogram follow the selection they move. After the match arrows, which
    // are a mode with its own reading of the same keys.
    if (!mod && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault(); stepColumnFocus(e.key === "ArrowRight" ? 1 : -1); return;
    }
    if (!mod && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault(); stepVoiceFocus(e.key === "ArrowUp" ? 1 : -1); return;
    }
    if (!mod && !e.altKey && S.matches.length && (e.key === "p" || e.key === "P")) { e.preventDefault(); previewFocusedMatch(); return; }
    if (!mod && S.matches.length && e.key === "Enter") {
      e.preventDefault();
      acceptMatch(S.matchFocus >= 0 ? S.matchFocus : 0);
      return;
    }
    if (!mod && !e.altKey && (e.key === "a" || e.key === "A") && S.matches.length) { e.preventDefault(); acceptAllMatches(); return; }
    if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); }
    else if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); doCopy(); }
    else if (mod && (e.key === "x" || e.key === "X")) { e.preventDefault(); doCut(); }
    else if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); doPaste({ mode: e.shiftKey ? "reference" : undefined }); }
    else if (matchKey(e, "delete")) { e.preventDefault(); doDelete(); }
    else if (e.key === "Escape" && (S.selection.size || S.detectRegion)) {
      if (S.selection.size) setSelection(new Set());            // clear the selection
      if (S.detectRegion) { S.detectRegion = null; updateDetectStatus(); }
      draw();
    }
    else if (matchKey(e, "muteLayer")) { e.preventDefault(); e.shiftKey ? toggleStemMute() : muteActiveLane(); }
    // The two panels, through their own menu items rather than their modules: the
    // View menu already owns the toggle, the check and the label, and pressing the
    // item is the one path that cannot end up disagreeing with them. It also keeps
    // the fretboard out of this file's imports, which it imports from already.
    else if (matchKey(e, "fretboard")) { e.preventDefault(); $("menuFretboard").click(); }
    else if (matchKey(e, "markerLanes")) { e.preventDefault(); $("menuMarkerLanes").click(); }
  });
}
import { placeFloating } from "./floating-position.js";
