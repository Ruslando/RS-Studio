// Undo transactions shared by editing features. Dependencies are supplied by
// edit.js so this module never imports feature/UI modules back into the graph.
// Bindings are read when an operation runs, after the application has initialized.
let services;
export function configureEditHistory(dependencies) {
  services = dependencies;
}

// ---- undo / redo (all edit lanes) ----
const MAX_UNDO = 200;

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
  const { S } = services;
  if (!S.state) return null;
  return {
    tempoMap: cloneJson(S.state.tempoMap),
    scoreBars: cloneJson(S.state.scoreBars),
    sectionMarkers: cloneJson(S.state.sectionMarkers),
    comments: cloneJson(S.state.comments || []),
    scoreDuration: S.state.scoreDuration,
    duration: S.state.duration,
    projectStart: S.state.projectStart,
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
  const { S, activeLane, editLanes, currentGridState, gridOffset, timingSnapshot, lockedReferenceSnapshot, normLayerVolume } = services;
  const a = activeLane();
  const snap = {
    ignoredDiagnostics: cloneJson(S.state?.metadata?.rocksmith || {}),
    lockedReferences: lockedReferenceSnapshot(),
    lanes: {}, boxes: {}, repeats: {}, ui: {}, holds: {}, capo: {}, marks: {},
    active: a ? a.id : null,
    stem: S.state ? S.state.curStem : null,
    grid: currentGridState(),
    offset: gridOffset(),   // so undoing an offset-driven note shift also rolls the offset back (no-op for every other edit)
    structure: structureSnapshot(),
    timing: S.state ? timingSnapshot() : null,   // which layer follows which timing, and the timings not live
  };
  for (const l of editLanes()) {
    snap.lanes[l.id] = snap.lockedReferences.some(r => r.lane === l.id)
      ? cloneJson(l.notes) : l.notes.map((n) => ({ ...n }));
    snap.boxes[l.id] = l.refBoxes ? JSON.parse(JSON.stringify(l.refBoxes)) : {};
    snap.repeats[l.id] = cloneJson(l.repeatGroups || []);
    // Where the hand was put. Not a note field, so nothing above captures it, and a
    // hold that undo cannot reach is an edit with no way back.
    snap.holds[l.id] = (l.handHolds || []).map((h) => ({ ...h }));
    // The capo too: moving it rewrites every fret, and those frets are undone above.
    snap.capo[l.id] = Number(l.capo) || 0;
    // Tone and phrase markers: a tempo change re-times them along with the notes.
    snap.marks[l.id] = { tone: cloneJson(l.toneMarkers), phrase: cloneJson(l.phraseBoundaries), crowd: cloneJson(l.crowdEvents || []) };
    snap.ui[l.id] = { visible: l.visible, muted: l.muted, locked: l.locked,
      tablatureEnabled: l.tablatureEnabled !== false, volume: normLayerVolume(l.volume) };
  }
  return snap;
}

// `mirrorSource` is optional and is NOT a flag despite reading like one: it is
// `{ ref, i }` naming the reference box the user actually dragged, so
// reconcileReferences mirrors from that one instead of guessing which box
// changed. Only the refBox drag passes it (interaction.js).
export function commit(prev, mirrorSource, cuts = null, { preserveTiming = false } = {}) {
  const { S, reconcileReferences, animateNoteChanges } = services;
  if (rejectLockedEdit(prev)) return false;
  reconcileReferences(prev, mirrorSource);
  animateNoteChanges(prev, S.state, cuts);
  recordUndo(prev, null, preserveTiming);
}

// For edits that retime everything at once — inserting or removing a bar, moving
// a tempo marker. reconcileReferences works by finding the one reference box
// whose contents changed and mirroring it onto the others; when *every* box
// changes it picks the first arbitrarily and overwrites the rest with it. A
// structure edit never changes what is inside a reference, only when it happens,
// so it records undo and skips that pass.
export function commitStructure(prev, { translation = null, preserveTiming = false } = {}) {
  recordUndo(prev, translation, preserveTiming);
}

function rejectLockedEdit(prev, translation = 0) {
  const { lockedReferenceFault, toast } = services;
  const ref = lockedReferenceFault(prev.lockedReferences, translation);
  if (ref == null) return false;
  restore(prev);
  toast(`Reference #${ref} is locked. Unlock it before editing.`, 2500);
  return true;
}

export function commitDiagnostics(prev) {
  recordUndo(prev, null, true, false);
}

function recordUndo(prev, translation = null, preserveTiming = false, invalidateVoicing = true) {
  const { S, editLanes, eachTiming, snapStrayNotes, refreshSaveState, draw } = services;
  if (rejectLockedEdit(prev, translation || 0)) return;
  // A whole-project translation preserves imported/off-grid rhythm exactly.
  // Its locked references may move, but their shapes and contents must match.
  if (S.state && translation == null && !preserveTiming)
    eachTiming(editLanes(), lanes => snapStrayNotes(lanes, prev.lanes));
  if (rejectLockedEdit(prev, translation || 0)) return;
  if (invalidateVoicing) S.voicingRevision++;
  S.undoStack.push(prev);
  if (S.undoStack.length > MAX_UNDO) S.undoStack.shift();
  S.redoStack = [];
  updateUndoButtons();
  refreshSaveState();   // an edit landed — reflect unsaved state in the project tab
  draw();              // editor and artifact references render the same committed state
}

function restore(snap) {
  const { S, editLanes, currentGridState, normLayerVolume, draw, clearNoteMotion, restoreTimingSnapshot, restoreGridState, offsetInput, selectStem, applyLaneVolume, releaseLaneSynth, refreshCounts, renderLanes, refreshTabIfOpen } = services;
  if (S.state && snap.ignoredDiagnostics) {
    const rs = (S.state.metadata ||= {}).rocksmith ||= {};
    for (const key of ['ignoredIssues', 'ignoredInstances', 'restoredInstances']) {
      if (snap.ignoredDiagnostics[key]) rs[key] = [...snap.ignoredDiagnostics[key]];
      else delete rs[key];
    }
  }
  clearNoteMotion();
  // Structure first: the grid readout and every note position below are drawn
  // against it, so putting the bars back after the notes would paint one frame
  // of the two disagreeing.
  if (S.state) restoreTimingSnapshot(snap.timing);   // first: the fields below are its live timing
  if (snap.structure && S.state) {
    S.state.tempoMap = cloneJson(snap.structure.tempoMap);
    S.state.scoreBars = cloneJson(snap.structure.scoreBars);
    S.state.sectionMarkers = cloneJson(snap.structure.sectionMarkers);
    if (snap.structure.comments) S.state.comments = cloneJson(snap.structure.comments);
    S.state.scoreDuration = snap.structure.scoreDuration;
    S.state.projectStart = snap.structure.projectStart;
    if (snap.structure.duration != null) S.state.duration = snap.structure.duration;
  }
  // The grid before the stem: switching stems rebuilds the lanes, which may swap
  // timings, and that must not catch the live timing half restored.
  if (snap.grid) restoreGridState(snap.grid);
  else if (snap.offset != null) {
    offsetInput.value = (+snap.offset).toFixed(3);
    S.appliedOffset = +snap.offset;
    S.appliedGrid = currentGridState();
  }
  // Bring back the stem the edit was made under so the backdrop matches what you
  // edited (edit lanes show across every stem, so this is just the spectrogram).
  if (snap.stem && S.state.curStem !== snap.stem && S.state.stems.some((s) => s.id === snap.stem))
    selectStem(snap.stem);
  for (const l of editLanes()) {
    if (snap.lanes && snap.lanes[l.id]) l.notes = snap.lanes[l.id].map((n) => ({ ...n }));
    if (snap.boxes) l.refBoxes = JSON.parse(JSON.stringify(snap.boxes[l.id] || {}));
    if (snap.repeats) l.repeatGroups = cloneJson(snap.repeats[l.id] || []);
    if (snap.holds) l.handHolds = (snap.holds[l.id] || []).map((h) => ({ ...h }));
    if (snap.capo && snap.capo[l.id] != null) l.capo = snap.capo[l.id];
    if (snap.marks && snap.marks[l.id]) {
      l.toneMarkers = cloneJson(snap.marks[l.id].tone);
      l.phraseBoundaries = cloneJson(snap.marks[l.id].phrase);
      l.crowdEvents = cloneJson(snap.marks[l.id].crowd || []);
    }
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
  const { refreshSaveState, clearMatches } = services;
  clearMatches();
  restore(snap);
  updateUndoButtons();
  refreshSaveState();
}

export function undo() {
  const { S, refreshSaveState, clearMatches } = services;
  if (!S.undoStack.length) return;
  clearMatches();
  S.redoStack.push(snapshotEdit());
  restore(S.undoStack.pop());
  updateUndoButtons();
  refreshSaveState();
}

export function redo() {
  const { S, refreshSaveState, clearMatches } = services;
  if (!S.redoStack.length) return;
  clearMatches();
  S.undoStack.push(snapshotEdit());
  restore(S.redoStack.pop());
  updateUndoButtons();
  refreshSaveState();
}

export function updateUndoButtons() {
  const { S, undoMI, redoMI } = services;
  if (undoMI) undoMI.disabled = !S.undoStack.length;
  if (redoMI) redoMI.disabled = !S.redoStack.length;
}

