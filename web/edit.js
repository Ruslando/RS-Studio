import { noteMenuEl, hideNoteMenu, ensureCtxMenu, placeCtxMenu, labelItem, buildMenu, markWalkthroughMenu, recordMenuOpen } from "./editor-menu.js";
import { clipOf, placeClip } from "./note-clipboard.js";
export { clipOf, placeClip };
import { columnOf } from "./column-context.js";
export { columnOf };

import { configureEditHistory, snapshotEdit, commit, commitStructure, undo, redo, updateUndoButtons } from "./edit-history.js";
import { applySharedPositionPlan, mapPositionShape, positionSelection, resetSharedPositions, sharedPositionPlan } from "./position-selection.js";
import { isTablatureLane } from "./layer-role.js";
// Note editing: undo/redo across all edit lanes, clipboard (incl. paste-as-reference),
// the per-note effects (bend / harmonic / articulations / slide), the fingering
// override, and the right-click note context menu.

import { hoveredStageNote } from "./stage-hit-test.js";
import { whammyCurve, whammyKind } from "./whammy.js";
import { MAX_POINTS, SLIDE_END_MIN, SLIDE_IN, SLIDE_OUT, SLIDES_TO_NEXT, SLIDE_START_MAX, bendAt, slideReach, bendCurve, normalizeCurve, slideInOf, vibratoStartOf, vibratoEndOf } from "./bend.js";
import { openDetectPanel, updateDetectStatus } from "./detect.js";
import { conflictsWith } from "./effects.js";

import { $, offsetInput, pasteAsRefBtn, pasteBackdrop, pasteCancelBtn, pasteCopyBtn, redoMI, scroll, stage, undoMI } from "./dom.js";
import { draw } from "./repaint.js";
import { resetZoom, xOf, yOf } from "./geometry.js";
import { currentGridState, gridOffset, restoreGridState } from "./grid-controls.js";
import { minDur, snapStrayNotes } from "./grid-read.js";
import { nid, motifId, shapeId } from "./ids.js";
import { eachTiming, restoreTimingSnapshot, timingSnapshot } from "./timing.js";
import { railMenuItems, railsHidden } from "./marker-rails.js";
import { addCommentAt } from "./comments.js";
import { addMarkerAtTime } from "./markers.js";
import { activeLane, applyLaneVolume, canEditLane, confirmRemoveLane, editLanes, laneOf, refreshCounts, releaseLaneSynth, renderLanes, setLaneCapo, setLaneNotePitch, targetLane, toggleLaneMute } from "./lanes.js";
import { FX_KEYS, FX_LABELS, copyEffects, fxOn, fxValue } from "./note-effects.js";
import { ensureTone, isMasterStem, playbackTime, previewNotes, togglePlay } from "./playback.js";
import { toast } from "./notify.js";
import { openNewProject } from "./new-project.js";
import { confirmStemRemoval } from "./stem-settings.js";
import { openProject, saveProject, selectStem, toggleStemMute } from "./project.js";
import { refreshSaveState } from "./save-state.js";
import { overlapsRefBox, spanAt, boxOfNote, lockedReferenceSnapshot, lockedReferenceFault, toggleRefEditLock, deleteRefGroup, deleteRefOccurrence, detachRefGroup, detachSelection, nextRef, noteBounds, occurrenceNotes, reconcileReferences, dropFingering, refMenuEntry, refName, setBeatShape, setRefPitchLock, wholeBoxOf } from "./references.js";
import { laneClock } from "./reference-clock.js";
import { markMotif, motifGroups, motifName, motifToExtend, unmarkMotif } from "./motifs.js";
import { SHAPE_KINDS, markShape, remintShapes, shapeGroups, unmarkShape } from "./shapes.js";
import { beginArtifactRename } from "./artifact-names.js";
import { beginChordRename } from "./chord-rename.js";
import { chordOfNote } from "./chord-names.js";
import { splitNote } from "./slice.js";
import { animateNoteChanges, clearNoteMotion } from "./note-motion.js";
import { songBarStarts } from "./song-bars.js";
import { S, setSelection } from "./store.js";

import { laneFretCount, laneFretTuning } from "./lane-tuning.js";
import { refreshTabIfOpen, setView, tabViewOn } from "./tablature.js";
import { runFindRepeats } from "./repeats.js";
import { hammerPositionGroup, hammerPositionPlan } from './hammer-positions.js';
import { pasteHandAnchors } from './clipboard-fingering.js';
import { acceptAllMatches, acceptMatch, clearMatches, focusAdjacentMatch, previewFocusedMatch, runFindSimilar } from "./tracing.js";
import { ESC_DEPTH, closeTopmost, registerEscapeLayer } from "./escape-stack.js";
import { modalOpen } from "./modal-focus.js";
import { matchKey } from "./keymap.js";
import { createEditorShortcutRunner } from "./editor-shortcuts.js";
import { navigateMarker } from "./marker-artifacts.js";
import { clearMarkerSelection, copyMarkers, cutMarkers, deleteMarkers, forgetMarkerClip, hasMarkerClip, hasMarkerSelection, pasteMarkers } from "./marker-clipboard.js";
import { normLayerVolume } from "./util.js";
import { slideFingerGroup, chordColumns, normalizeOverrideInfluence, overrideFlow, shapeFault, stepColumnFocus, stepVoiceFocus, voiceNotes, voiceNotesFingered, writeColumnOverride } from "./voicing.js";

// Preserve the editor API for existing integrations. Features use edit-history directly.
export { snapshotEdit, commit, commitStructure, commitDiagnostics, restoreEditSnapshot, undo, redo, updateUndoButtons } from "./edit-history.js";

configureEditHistory({
  get S() { return S; },
  activeLane: (...args) => activeLane(...args),
  editLanes: (...args) => editLanes(...args),
  currentGridState: (...args) => currentGridState(...args),
  gridOffset: (...args) => gridOffset(...args),
  timingSnapshot: (...args) => timingSnapshot(...args),
  lockedReferenceSnapshot: (...args) => lockedReferenceSnapshot(...args),
  normLayerVolume: (...args) => normLayerVolume(...args),
  lockedReferenceFault: (...args) => lockedReferenceFault(...args),
  reconcileReferences: (...args) => reconcileReferences(...args),
  animateNoteChanges: (...args) => animateNoteChanges(...args),
  eachTiming: (...args) => eachTiming(...args),
  snapStrayNotes: (...args) => snapStrayNotes(...args),
  refreshSaveState: (...args) => refreshSaveState(...args),
  draw: (...args) => draw(...args),
  toast: (...args) => toast(...args),
  clearNoteMotion: (...args) => clearNoteMotion(...args),
  restoreTimingSnapshot: (...args) => restoreTimingSnapshot(...args),
  restoreGridState: (...args) => restoreGridState(...args),
  get offsetInput() { return offsetInput; },
  selectStem: (...args) => selectStem(...args),
  applyLaneVolume: (...args) => applyLaneVolume(...args),
  releaseLaneSynth: (...args) => releaseLaneSynth(...args),
  refreshCounts: (...args) => refreshCounts(...args),
  renderLanes: (...args) => renderLanes(...args),
  refreshTabIfOpen: (...args) => refreshTabIfOpen(...args),
  clearMatches: (...args) => clearMatches(...args),
  get undoMI() { return undoMI; },
  get redoMI() { return redoMI; },
});

// Ctrl+↑/↓: the selection jumps an octave, as a whole or not at all.
function shiftSelectionOctave(delta) {
  const lane = activeLane();
  if (!canEditLane(lane)) return;
  const notes = lane.notes.filter((n) => S.selection.has(n));
  const { midi_low, midi_high } = S.state.spec;
  if (!notes.length || notes.some((n) => n.pitch + delta < midi_low || n.pitch + delta > midi_high)) return;
  const prev = snapshotEdit();
  for (const n of notes) setLaneNotePitch(lane, n, n.pitch + delta);
  commit(prev);
  previewNotes(notes, lane);
  draw();
}

// Slice an arbitrary set of note/time intersections in one undoable change. A
// diagonal slice can cross several pitches (and layers) at different grid times.
export function sliceNoteCuts(cuts) {
  const entries = [...cuts.entries()].filter(([note, at]) => laneOf(note) && Number.isFinite(at));
  if (!entries.length) return [];
  const prev = snapshotEdit(), split = [];
  for (const [note, at] of entries) {
    const lane = laneOf(note);
    if (!canEditLane(lane)) continue;
    const parts = splitNote(note, at, minDur(), nid);
    if (!parts) continue;
    const index = lane.notes.indexOf(note);
    lane.notes.splice(index, 1, parts.left, parts.right);
    split.push(parts);
  }
  if (!split.length) return [];
  setSelection(new Set(split.map((parts) => parts.right)));
  commit(prev, undefined, new Set(split.map(parts => parts.right.id)));
  refreshCounts(); refreshTabIfOpen(); draw();
  toast(`Sliced ${split.length} note${split.length === 1 ? "" : "s"}`);
  return split;
}

// ---- clipboard / delete ----
export function doCopy() {
  if (hasMarkerSelection()) { copyMarkers(); return; }
  if (!S.selection.size) return;
  forgetMarkerClip();
  S.clipboardSrc = [...S.selection];
  S.clipboard = clipOf(S.clipboardSrc);
  // Remember the source occurrence when the copy is one whole reference box —
  // that's when Paste offers the copy-vs-reference choice.
  const b = wholeBoxOf(S.clipboardSrc);
  S.clipboardRef = b ? { lane: b.lane, ref: b.ref } : null;
}

// Modal choice when pasting notes copied wholesale from a reference. Resolves
// "copy" | "reference" | null (cancel). Mirrors confirmDetectMerge.
function confirmPasteMode({ signal } = {}) {
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
      window.removeEventListener("keydown", onKey, true);
      signal?.removeEventListener("abort", onCancel);
      resolve(v);
    };
    const onCopy = () => finish("copy");
    const onRef = () => finish("reference");
    const onCancel = () => finish(null);
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } };
    pasteCopyBtn.addEventListener("click", onCopy);
    pasteAsRefBtn.addEventListener("click", onRef);
    pasteCancelBtn.addEventListener("click", onCancel);
    window.addEventListener("keydown", onKey, true);   // capture so it beats the global Esc handlers
    signal?.addEventListener("abort", onCancel, { once: true });
    pasteAsRefBtn.focus();
  });
}

function pasteHitsReference(lane, at, shift, asReference = false, refShift = 0) {
  if (!lane || !Object.keys(lane.refBoxes || {}).length) return false;
  const placed = placeClip(S.clipboard, lane, at);
  let bounds = noteBounds(placed.map((times, i) => ({ ...times, pitch: S.clipboard[i].pitch + shift })));
  const source = S.clipboardRef;
  const group = asReference && source?.lane === lane && lane.refBoxes[source.ref];
  if (group) {
    bounds = { ...spanAt(group, bounds.t0, laneClock(lane)), pLo: group.pLo + refShift, pHi: group.pHi + refShift };
  }
  return overlapsRefBox(lane, bounds);
}

// mode: "copy" | "reference" forces that result; undefined = auto — when the copy
// came entirely from one reference, ask via confirmPasteMode, otherwise plain copy.
export async function doPaste({ mode, at, shift = 0, refShift = 0 } = {}) {
  if (hasMarkerClip() && pasteMarkers(at ?? playbackTime())) return;
  if (!S.clipboard.length || !S.state) return;
  const pasteAt = at ?? playbackTime();
  // The source box may have changed since the copy; only a still-whole box pastes as it.
  const whole = S.clipboardRef && wholeBoxOf(S.clipboardSrc.filter((n) => laneOf(n)?.notes.includes(n)));
  if (!whole || whole.lane !== S.clipboardRef.lane || whole.ref !== S.clipboardRef.ref) S.clipboardRef = null;
  if (mode == null) {
    // Pasted notes become part of the destination reference. A nested reference
    // is not an available choice, so there is nothing to ask here.
    if (S.clipboardRef == null || pasteHitsReference(targetLane(), pasteAt, shift)) mode = "copy";
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
  if (asReference && pasteHitsReference(lane, pasteAt, shift, true, refShift)) {
    toast('References cannot overlap another reference; paste as a copy instead');
    return;
  }
  const prev = snapshotEdit();
  // Anchor the paste at the current time: the clipboard's earliest note starts at
  // the playhead, the rest at their beat distance from it (see placeClip).
  const placed = placeClip(S.clipboard, lane, pasteAt);
  // Preserve copied motifs, but mint new ids so the paste is independent from
  // the original. A partial copy keeps its annotation, including a single note.
  const pastedMotifIds = new Map();
  const added = S.clipboard.map((c, k) => {
    const q = placed[k];
    let pastedMotifId;
    if (c.motifId) {
      if (!pastedMotifIds.has(c.motifId)) pastedMotifIds.set(c.motifId, motifId());
      pastedMotifId = pastedMotifIds.get(c.motifId);
    }
    const note = copyEffects(c, {
      id: nid(), start: q.start, end: q.end, pitch: c.pitch + shift,
      ...(c.finger != null ? { finger: c.finger } : {}),
      ...(pastedMotifId ? { motifId: pastedMotifId } : {}),
    });
    // A transposed copy cannot keep its string and fret; fingering places it anew.
    if (shift) dropFingering(note);
    return note;
  });
  remintShapes(S.clipboard.map((c, k) => [c, added[k]]), shapeId);
  lane.notes.push(...added);
  if (!shift && S.clipboard.some(c => c.handAnchor != null)) pasteHandAnchors(lane, S.clipboard, placed, nid);
  if (asReference) linkPasteAsReference(added, lane, refShift);
  commit(prev);
  setSelection(new Set(added));
  S.state.lanes.forEach((l) => (l.active = l === lane));
  renderLanes(); refreshCounts(); draw();
}

// Drop a new box over the just-pasted notes so they become another occurrence of
// the copied group. If the source wasn't a reference, form a fresh group from the
// still-present source notes + the paste. Returns the group number, or null.
function linkPasteAsReference(added, lane, refShift = 0) {
  const anchorNew = noteBounds(added).t0;
  if (S.clipboardRef && S.clipboardRef.lane === lane && lane.refBoxes && lane.refBoxes[S.clipboardRef.ref]) {
    const group = lane.refBoxes[S.clipboardRef.ref];
    group.anchors.push(anchorNew);
    if (refShift) (group.shifts || (group.shifts = []))[group.anchors.length - 1] = refShift;
    return S.clipboardRef.ref;
  }
  const src = S.clipboardSrc.filter((n) => laneOf(n) === lane && !boxOfNote(n));
  if (src.length !== added.length) return null;   // nothing intact to pair the paste with
  const ref = nextRef(), nb = noteBounds(added), clock = laneClock(lane);
  const group = (lane.refBoxes || (lane.refBoxes = {}))[ref] = {
    rt0: 0, rt1: nb.t1 - nb.t0,
    pLo: nb.pLo, pHi: nb.pHi,
    anchors: [noteBounds(src).t0, anchorNew],
  };
  setBeatShape(group, 0, clock.beatAt(nb.t1) - clock.beatAt(nb.t0), clock);
  return ref;
}

export function doDelete({ hovered = false } = {}) {
  if (!S.state || S.drag) return;
  if (deleteMarkers()) return;
  const hoverTarget = hovered && !tabViewOn() && !S.selection.size ? hoveredStageNote() : null;
  const targets = S.selection.size ? S.selection : new Set(hoverTarget ? [hoverTarget] : []);
  if (!targets.size) return;
  clearMatches();
  const prev = snapshotEdit();
  let removed = 0;
  for (const lane of editLanes()) {
    if (!canEditLane(lane)) continue;   // hidden / locked lanes are disabled — never delete their notes
    const before = lane.notes.length;
    lane.notes = lane.notes.filter((n) => !targets.has(n));
    removed += before - lane.notes.length;
  }
  S.selection = new Set();
  if (targets.has(S.hoverNote)) S.hoverNote = null;
  if (removed) commit(prev);
  refreshCounts(); draw();
}

// Copy or move the selection into another layer at the same time and pitch.
// Copies retain their playing instructions, as clipboard paste does.
export function sendSelectionToLane(target, { move = false } = {}) {
  if (!canEditLane(target)) return;
  const picked = [...S.selection].map((note) => [note, laneOf(note)])
    .filter(([, lane]) => lane && lane !== target && (!move || canEditLane(lane)));
  if (!picked.length) return;
  const prev = snapshotEdit(), motifs = new Map();
  const clip = move ? null : clipOf(picked.map(([n]) => n));
  const added = picked.map(([n, lane], index) => {
    if (move) { lane.notes.splice(lane.notes.indexOf(n), 1); dropFingering(n); return n; }
    const note = copyEffects(clip[index], { id: nid(), start: n.start, end: n.end, pitch: n.pitch,
      ...(clip[index].finger != null ? { finger: clip[index].finger } : {}) });
    if (n.motifId) {
      if (!motifs.has(n.motifId)) motifs.set(n.motifId, motifId());
      note.motifId = motifs.get(n.motifId);
    }
    return note;
  });
  remintShapes(picked.map(([n], k) => [n, added[k]]), shapeId);
  target.notes.push(...added);
  if (clip?.some(c => c.handAnchor != null)) pasteHandAnchors(target, clip, added, nid);
  commit(prev);
  setSelection(new Set(added));
  S.state.lanes.forEach((l) => (l.active = l === target));
  renderLanes(); refreshCounts(); refreshTabIfOpen(); draw();
  toast(`${move ? "Moved" : "Copied"} ${added.length} note${added.length === 1 ? "" : "s"} to “${target.name}”`);
}

// Cut = copy the selection, then delete the deletable part (same lane rules as
// Delete).
export function doCut() {
  if (cutMarkers()) return;
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

// Set (kind) or clear (null) the slide on every selected edit note.
function setSlideOnSelection(kind) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) return;
  const prev = snapshotEdit();
  let cleared = false;
  for (const n of notes) {
    if (!kind) { for (const k of ["slide", "slideIn", "slideStart", "slideEnd", "slideFrets"]) delete n[k]; continue; }
    cleared = clearConflicts(n, "slide") || cleared;
    // A slide in and a slide out or on can share a note (bend.js slideInOf): picking
    // one kind keeps the other. Timing and reach belong to one kind; a new kind
    // starts from its defaults.
    const into = SLIDE_IN.has(kind), had = slideInOf(n);
    if (into && n.slide && !SLIDE_IN.has(n.slide)) {
      if (n.slideIn !== kind) delete n.slideEnd;
      n.slideIn = kind;
      continue;
    }
    if (!into && had) {
      if (n.slide === had) delete n.slideFrets;   // the in-slide's reach
      n.slideIn = had;
    }
    // Shift and legato are the same slide onto the next note, picked or not: it keeps its shape.
    const sameShape = SLIDES_TO_NEXT.has(n.slide) && SLIDES_TO_NEXT.has(kind);
    if (n.slide !== kind && !sameShape) { delete n.slideStart; delete n.slideFrets; if (into) delete n.slideEnd; }
    n.slide = kind;
    if (into) delete n.slideIn;
  }
  commit(prev); draw();
  if (cleared) toast("Cleared conflicting effects");
}

// Where a slide onto the next note leaves its fret, as a fraction of the note. The pick (0) is the default and is stored as no field at
// all. For a slide into the note, where it lands; 0 puts back the default (bend.js).
function setSlideStart(n, fraction) {
  if (SLIDE_IN.has(n.slide)) {
    if (fraction > 1e-3) n.slideEnd = Math.max(SLIDE_END_MIN, Math.min(SLIDE_START_MAX, fraction));
    else delete n.slideEnd;
    return;
  }
  const s = Math.max(0, Math.min(SLIDE_START_MAX, fraction));
  if (s > 1e-3) n.slideStart = s; else delete n.slideStart;
}

// How many frets a slide into or out of the note spans: at least one, at most
// what Rocksmith reaches from the note's `fret` (bend.js slideReach).
export function setSlideFrets(n, frets, fret) {
  if (!(SLIDE_IN.has(n.slide) || SLIDE_OUT.has(n.slide))) return;
  n.slideFrets = Math.max(1, Math.min(Math.round(frets), slideReach(n.slide, fret)));
}

// The same for where vibrato sets in.
function setVibratoStart(n, fraction) {
  const s = Math.max(0, Math.min(vibratoEndOf(n) - (1 - SLIDE_START_MAX), fraction));
  if (s > 1e-3) n.vibratoStart = s; else delete n.vibratoStart;
}
function setVibratoEnd(n, fraction) {
  const end = Math.max(vibratoStartOf(n) + (1 - SLIDE_START_MAX), Math.min(1, fraction));
  if (end < 1 - 1e-3) n.vibratoEnd = end; else delete n.vibratoEnd;
}
export const EFFECT_START_SETTERS = { slide: setSlideStart, vibrato: setVibratoStart, vibratoEnd: setVibratoEnd };

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

// Start with a dip on every selected note, or clear the whammy (null).
function setWhammyOnSelection(on) {
  const notes = [...S.selection].filter((n) => laneOf(n));
  if (!notes.length) return;
  const prev = snapshotEdit();
  let cleared = false;
  for (const n of notes) {
    delete n.whammyPoints;
    if (!on) { delete n.whammy; continue; }
    cleared = clearConflicts(n, "whammy") || cleared;
    n.whammy = "dip";
  }
  commit(prev); draw();
  if (cleared) toast("Cleared conflicting effects");
}

// Replace one note's curve (points are never mutated in place — see bend.js).
// `kind` "whammy" is the whammy bar's curve: a preset (dip, dive) is where it starts,
// and once a point is dragged the note carries its own curve, named by its shape.
// A bend only raises the string's pitch, so its curve stays at or above the
// fretted note; lower is a whammy or a slide, picked from the note menu.
export function setBendCurve(n, pts, kind = "bend") {
  pts = normalizeCurve(pts);
  if (kind === "whammy") { n.whammyPoints = pts; n.whammy = whammyKind(pts) || "custom"; return; }
  n.bendPoints = pts.map(([t, v]) => [t, Math.max(0, v)]);
  n.bend = "custom";
}
export const curveOf = (n, kind = "bend") => kind === "whammy" ? whammyCurve(n) : bendCurve(n);

// Add a control point where the curve already runs at `t`, so the new handle
// starts on the line and only moves when dragged.
export function addBendPoint(n, t, kind = "bend") {
  const pts = curveOf(n, kind);
  if (!pts || pts.length >= MAX_POINTS) return;
  const prev = snapshotEdit();
  setBendCurve(n, [...pts.map((p) => [...p]), [t, bendAt(pts, t)]], kind);
  commit(prev); draw();
}

// Remove a control point. The first and last pin the curve to the note's edges,
// so they stay — only the ones in between can go.
export function removeBendPoint(n, i, kind = "bend") {
  const pts = curveOf(n, kind);
  if (!pts || pts.length <= 2 || i === 0 || i === pts.length - 1) return;
  const prev = snapshotEdit();
  setBendCurve(n, pts.filter((_, k) => k !== i).map((p) => [...p]), kind);
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



// ---- effect conflicts (mutual exclusion across fx flags + own-field effects) ----
// Switching one technique on strips the ones it physically fights (see effects.js),
// so a note can't be e.g. both a dead/muted "X" and bent. Minimal by design —
// only physically-null combos, not musical taste.
const FX_SET = new Set(FX_KEYS);
const hasEffect = (n, name) => (FX_SET.has(name) ? fxOn(n, name) : n[name] != null);
function dropEffect(n, name) {
  if (FX_SET.has(name)) {
    if (!fxOn(n, name)) return;
    const fx = { ...n.fx }, value = fxValue(n, name, false);
    if (value) fx[name] = value; else delete fx[name];
    if (Object.keys(fx).length) n.fx = fx; else delete n.fx;
    if (name === "vibrato") { delete n.vibratoStart; delete n.vibratoEnd; }
  } else if (n[name] != null) {
    delete n[name];
    if (name === "bend") delete n.bendPoints;   // the curve is meaningless without it
    if (name === "whammy") delete n.whammyPoints;
    if (name === "slide") { delete n.slideStart; delete n.slideEnd; delete n.slideFrets; }
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
    const fx = { ...n.fx }, value = fxValue(n, key, on);
    if (value) fx[key] = value; else delete fx[key];
    if (Object.keys(fx).length) n.fx = fx; else delete n.fx;
    if (!n.fx?.vibrato) { delete n.vibratoStart; delete n.vibratoEnd; }
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

// ---- annotation-only motifs ----
export function markSelectionAsMotif() {
  const selected = [...S.selection].filter(note => laneOf(note));
  const lanes = [...new Set(selected.map(laneOf))];
  if (!selected.length || lanes.length !== 1 || !canEditLane(lanes[0])) return false;
  const previous = snapshotEdit();
  markMotif(selected, motifToExtend(lanes[0].notes, selected) ?? motifId());
  commit(previous); draw();
  return true;
}

function selectEntireMotif() {
  const member = [...S.selection].find(note => note.motifId && laneOf(note));
  if (!member) return;
  setSelection(new Set(motifGroups(laneOf(member).notes).get(member.motifId) || [])); draw();
}

function unmarkSelectedMotifs() {
  const previous = snapshotEdit();
  for (const note of S.selection) {
    const lane = laneOf(note);
    if (lane && canEditLane(lane) && note.motifId) unmarkMotif(lane.notes, note.motifId);
  }
  commit(previous); draw();
}

// ---- grip shapes: Rocksmith arpeggio and handshape frames (shapes.js) ----
function markSelectionAsShape(kind) {
  const selected = [...S.selection].filter(note => laneOf(note));
  const lanes = [...new Set(selected.map(laneOf))];
  if (lanes.length !== 1 || !canEditLane(lanes[0])) return false;
  if (selected.length < 2) { toast(`Select at least two notes for ${SHAPE_KINDS[kind].toLowerCase()}`); return false; }
  const previous = snapshotEdit();
  markShape(selected, shapeId(), kind);
  commit(previous); draw();
  return true;
}

// `kind` (arpeggio / handshape) limits these to shapes of that kind; null takes any.
function selectEntireShape(kind = null) {
  const member = [...S.selection].find(note => note.shapeId && laneOf(note) && (!kind || note.shapeKind === kind));
  const notes = member && shapeGroups(laneOf(member).notes).get(member.shapeId);
  if (!notes) return;
  setSelection(new Set(notes)); draw();
}

function unmarkSelectedShapes(kind = null) {
  const previous = snapshotEdit();
  let changed = false;
  for (const note of S.selection) {
    const lane = laneOf(note);
    if (lane && canEditLane(lane) && note.shapeId && (!kind || note.shapeKind === kind)) { unmarkShape(lane.notes, note.shapeId); changed = true; }
  }
  if (!changed) return;
  commit(previous); draw();
}

// ---- fingering / position override (manual pin over the auto voicing) ----
// The voicing engine picks the "best" string/fret per onset-column; sometimes a
// worse-scoring position is the one you want (e.g. a fretted note so a slide is
// playable). Rather than free placement, you cycle the column through its ranked
// playable shapes, pinning the chosen one on each note's `pos`. Single notes are
// just a column of one; whole chords move as a shape (no two notes per string).

// A multi-selection is one local grip edit, validated in full before one undo
// snapshot is committed. Existing reach/adaptation flags are intentionally reset.
function applySelectedPosition(colNotes, shape) {
  const lane = laneOf(colNotes?.[0]);
  const group = positionSelection(lane, S.selection);
  if (!group.multiple) return { handled: false };
  if (group.error) return { handled: true, error: group.error };
  if (!canEditLane(lane)) return { handled: true, error: null };
  const tuning = laneFretTuning(lane);
  const voiced = voiceNotes(lane.notes, tuning, Infinity,
    { bars: songBarStarts(), instrument: lane.instrument, capo: lane.capo, holds: lane.handHolds });
  const plan = sharedPositionPlan(lane, S.selection, colNotes, shape, tuning,
    note => voiced.get(note), laneFretCount(lane));
  // Offers are prevalidated for the full selection. A stale offer must be
  // discarded, not presented as an invalid action the user could have avoided.
  if (plan.error) { draw(); return { handled: true, error: null }; }
  const prev = snapshotEdit();
  if (applySharedPositionPlan(plan)) { commit(prev); draw(); refreshTabIfOpen(); }
  return { handled: true, error: null };
}

// One-line description of a shape for the menu/toast: "A string · fret 7",
// "open", or a chord's per-string frets + lowest position.
// Pin the column to `shape` (Map note -> {string, fret}) or, when null, clear the
// pin so the column voices automatically again. Directional influence rides on
// each note's pos so the override's reach survives copy/paste and save.
function applyColumnPos(colNotes, shape, scope = "local", influence = null, follow = null) {
  const flow = normalizeOverrideInfluence(influence);
  const want = (n) => (shape && shape.has(n) ? shape.get(n) : null);
  const same = (a, b) => (!a && !b) ||
    // A pin with no stored scope is a "local" pin: every writer stamps "local",
    // and reference-core defaults to it. Only old projects store an explicit
    // "forward" (voicing-core's legacyForward anchor), and those are untouched
    // here. Defaulting to "forward" made an unchanged column compare as changed,
    // so re-applying the same shape rewrote it and cost an undo step.
    (a && b && a.string === b.string && a.fret === b.fret && (a.scope || "local") === scope &&
      normalizeOverrideInfluence(a).follow === flow.follow);
  if (colNotes.every((n) => same(n.pos || null, want(n)))) return;
  const prev = snapshotEdit();
  for (const n of colNotes) {
    const p = want(n);
    if (p) n.pos = { string: p.string, fret: p.fret, scope, follow: flow.follow };
    else delete n.pos;
  }
  follow?.();
  commit(prev); draw();
  refreshTabIfOpen();
}

// Unified shape chooser used by the fretboard's offer. Choosing an alternative
// rewrites the column to what that shape plays — pins for the notes it keeps,
// deletions for the ones it drops, real new notes for the ones it adds — so the
// spectrogram afterwards is what the neck showed. null returns the column to
// automatic (pins only; a deleted note comes back through undo).
export function applyColumnAlternative(colNotes, choice, influence = null) {
  const group = positionSelection(laneOf(colNotes?.[0]), S.selection);
  if (group.multiple) {
    if (group.error) { toast(group.error); return; }
    const shape = choice && mapPositionShape(choice.notes, choice.shape, colNotes);
    if (!shape) { draw(); return; }
    const result = applySelectedPosition(colNotes, shape);
    if (result.error) toast(result.error);
    return;
  }
  const prev = snapshotEdit();
  if (writeAlternative(colNotes, choice, influence)) {
    commit(prev); draw(); refreshTabIfOpen();
  }
}

// THE PLAYER'S OWN FINGER: 0 the thumb, 1-4 index to pinky, null back to
// the engine's. Taken as typed — the board and the exports show it even where no hand
// could hold it, which is the player's call. Fretted slide chains share the edit
// in either direction. Moves no note; a chosen index anchors the hand at its fret.
//
// Typed as a draft: shown at once, one undo step when it is kept, gone when it is not.
// `original` is the draft's memory, Map(note -> finger before it).
const putFinger = (note, finger) => { if (finger == null) delete note.finger; else note.finger = finger; };

export function draftNoteFinger(original, note, finger, positions = null) {
  const lane = laneOf(note);
  if (!canEditLane(lane)) return;
  const group = slideFingerGroup(lane.notes, note, n => positions ? positions.get(n) : n.pos);
  let changed = false;
  for (const member of group) {
    if ((member.finger ?? null) === finger) continue;
    if (!original.has(member)) original.set(member, member.finger ?? null);
    putFinger(member, finger);
    changed = true;
  }
  if (!changed) return;
  // The fingers and their index anchor are laid over the voicing, not solved into it:
  // the lane is not voiced again for them (see laneFingering).
  S.fingerRevision = (S.fingerRevision || 0) + 1; draw();
}

export function settleFingerDraft(original, keep) {
  const typed = new Map([...original.keys()].map((n) => [n, n.finger ?? null]));
  for (const [n, f] of original) putFinger(n, f);
  if (keep && [...typed].some(([n, f]) => f !== original.get(n))) {
    const prev = snapshotEdit();   // taken with the draft undone, so undo returns there
    for (const [n, f] of typed) putFinger(n, f);
    commit(prev); refreshTabIfOpen();
  } else if (original.size) S.fingerRevision = (S.fingerRevision || 0) + 1;
  original.clear();
  draw();
}

// Forget the selection's positions, so the next solve places it again around
// everything else, which stays put (keepVoicing). One undo step.
function revoiceSelection() {
  const lanes = [...new Set([...S.selection].map(laneOf))].filter((l) => l && canEditLane(l) && isTablatureLane(l));
  if (!lanes.length) return;
  const prev = snapshotEdit();
  const picked = new Set(S.selection);
  for (const lane of lanes) {
    // A column rewritten to other notes comes back as it was written, as new note
    // objects, so the selection swaps them in.
    for (const col of chordColumns(lane.notes)) {
      if (!col.notes.some((n) => picked.has(n)) || !col.notes.some((n) => n.pos || n.arrangement || n.written)) continue;
      writeAlternative(col.notes, null, null);   // a rewrite selects the new column
      const now = new Set(lane.notes);
      if (col.notes.every((n) => now.has(n))) continue;
      col.notes.forEach((n) => picked.delete(n));
      S.selection.forEach((n) => picked.add(n));
    }
  }
  setSelection(picked);
  commit(prev); draw(); refreshTabIfOpen();
}

// The write itself, with no snapshot of its own, so a caller undoing two things at
// once can put both inside one step (see clearOverrideAt).
function writeAlternative(colNotes, choice, influence) {
  const lane = laneOf(colNotes?.[0]);
  if (!lane) return false;
  const flow = normalizeOverrideInfluence(influence || overrideFlow(colNotes));
  const markings = new Map(lane.notes.map(note => [note.id, note.motifId]));
  const names = new Map(lane.notes.map(note => [note.id, note.motifName]));
  const { notes, column } = writeColumnOverride(lane.notes, colNotes, choice, flow, nid);
  for (const note of notes) if (markings.has(note.id)) {
    if (markings.get(note.id)) note.motifId = markings.get(note.id);
    else delete note.motifId;
    if (names.get(note.id)) note.motifName = names.get(note.id);
    else delete note.motifName;
  }
  const rewritten = notes !== lane.notes;
  lane.notes = notes;
  // Notes came or went, so the selection still points at objects that have left
  // the lane. Reselect the column as it now stands.
  if (rewritten) setSelection(new Set(column));
  return true;
}

// WHERE THE FRETTING HAND STANDS ON ONE NOTE OR CHORD, put there by hand: `{ t, fret }`
// on the lane, belonging to the first note or chord at or after `t`. It fixes that
// column's hand and nothing else: no note moves for it, and the hand after it is
// planned on from there. The fretboard only offers hands that can play the column
// (handChoices); one that no longer can (its notes changed) lapses.
// Choose Auto (null) to clear it.
export function setHandAnchor(lane, t, fret) {
  if (!canEditLane(lane) || !Number.isFinite(t) || (fret !== null && (!Number.isFinite(fret) || fret < 1))) return;
  // Every hold after the previous column, up to this one, belongs to this column,
  // and the engine obeys the earliest of them (holdsByColumn). A hold left at a
  // moved note's old time would otherwise shadow the new one for good, so the new
  // hand replaces them all, and Auto clears them all.
  const columns = chordColumns(lane.notes), at = columns.findIndex((c) => c.t0 >= t - 1e-6);
  const after = at > 0 ? columns[at - 1].t0 : -Infinity, until = at >= 0 ? columns[at].t0 : t;
  const owned = (h) => Number(h.t) > after + 1e-6 && Number(h.t) <= until + 1e-6;
  const own = (lane.handHolds || []).filter(owned).sort((a, b) => a.t - b.t), had = own[0];
  const rest = (lane.handHolds || []).filter((h) => !owned(h));
  // A hand chosen by hand replaces a fingering chosen for the same notes: the engine
  // fingers them for the new hand. Picking the hand that is already held still
  // does that, for fingers that came after it (or with an import).
  const column = fret === null || at < 0 ? [] : columns[at].notes;
  const fingered = column.some((n) => n.pos?.finger != null
    || slideFingerGroup(lane.notes, n, (m) => m.pos).some((m) => m.finger != null));
  if ((!had && fret === null) || (own.length === 1 && Number(had.fret) === fret && !fingered)) return;
  const prev = snapshotEdit();
  lane.handHolds = (fret === null ? rest : [...rest, { id: had?.id || `anchor_${nid()}`, t, fret }]).sort((a, b) => a.t - b.t);
  dropChosenFingers(lane, column);
  commit(prev); draw(); refreshTabIfOpen();
}

// Both kinds: a fingering picked on the board (pos.finger) and a finger typed or
// imported onto the note (note.finger, whose index finger would set the hand
// again). A typed finger is shared along a fretted slide, so it goes there too.
function dropChosenFingers(lane, notes) {
  for (const n of notes) {
    if (n.pos?.finger != null) {
      const { finger, ...pos } = n.pos;
      n.pos = pos;
    }
    for (const member of slideFingerGroup(lane.notes, n, (m) => m.pos)) delete member.finger;
  }
}

// A FINGERING CHOSEN FOR ONE NOTE OR CHORD: `placed` is the column as the fretboard
// shows it ({ note, string, fret } each), `fingers` the choice (fingeringChoices).
// Written onto each note's position override, so it carries on like the position
// does (guided), and the hand follows from it: a hand anchor on
// these notes would contradict it and goes.
function setColumnFingers(lane, placed, fingers) {
  if (!canEditLane(lane) || !placed.length || placed.some(({ note }) => !lane.notes.includes(note))) return;
  const prev = snapshotEdit();
  const { follow } = overrideFlow(placed.map(({ note }) => note));
  for (const { note, string, fret } of placed) {
    const finger = fret > 0 ? fingers.get(note) : null;
    // Number.isInteger: an open string's finger is null, and null >= 0 is true.
    note.pos = { string, fret, scope: "local", follow, ...(Number.isInteger(finger) && finger >= 0 ? { finger } : {}) };
  }
  const columns = chordColumns(lane.notes), t0 = Math.min(...placed.map(({ note }) => note.start));
  const i = columns.findIndex((c) => Math.abs(c.t0 - t0) < 1e-6);
  const from = i > 0 ? columns[i - 1].t0 : -Infinity;
  lane.handHolds = (lane.handHolds || []).filter((h) => !(Number(h.t) > from + 1e-6 && Number(h.t) <= t0 + 1e-6));
  commit(prev); draw(); refreshTabIfOpen();
}

// The fingering back to the engine's: a chosen finger is dropped, the position stays.
// One undo step.
function clearColumnFingers(lane, notes) {
  const chosen = (n) => n.pos && (n.pos.fingerOnly || "finger" in n.pos);
  if (!canEditLane(lane) || !notes.some(chosen)) return;
  const prev = snapshotEdit();
  for (const n of notes) {
    if (!chosen(n)) continue;
    const { finger, fingerOnly, ...pos } = n.pos; n.pos = pos;
  }
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
// it is the player's problem to judge, not the engine's to veto. What a note's own
// technique rules out is (`limits`, from placementLimits): a slide on an open string
// is not a hard shape, it is not a shape.
//
// Returns null when it wrote, or the sentence saying what is wrong.
export function setColumnShape(colNotes, shape, limits = null, maxFret = undefined) {
  const shared = applySelectedPosition(colNotes, shape);
  if (shared.handled) return shared.error;
  const lane = laneOf(colNotes?.[0]);
  if (!lane) return "These notes are not in an editable note layer";
  if (colNotes.some(n => hammerPositionGroup(lane.notes, n).length > 1)) {
    const before = handsBefore(lane);
    const linked = applyHammerPosition(lane, shape, n => before.voiced.get(n), maxFret);
    if (linked.handled) return linked.error;
  }
  const wrong = shapeFault(colNotes, laneFretTuning(lane), shape, limits, maxFret);
  if (wrong) return wrong;
  applyColumnPos(colNotes, shape, "local", overrideFlow(colNotes));
  return null;
}

// ONE NOTE, PUT WHERE THE PLAYER WANTS IT. The neck's candidate boxes offer whole
// grips the engine ranked; this is the other grain of the same question — a shape
// nobody ranked, built a note at a time.
//
// The rest of the column is written out with it, so the whole column is one override
// with one set of reach switches. The others keep exactly the places they already
// had, so the change on screen is the one note that moved.
// The fretboard's capo drag: one undo step, like every other edit made on the neck.
function moveLaneCapo(lane, capo) {
  if (!canEditLane(lane) || (Number(lane.capo) || 0) === capo) return;
  const prev = snapshotEdit();
  setLaneCapo(lane, capo);
  commit(prev); draw(); refreshTabIfOpen();
}

export function setNotePosition(note, string, fret) {
  const ctx = columnOf(note);
  if (!ctx) return;
  // The same solve the tab was voiced under, so "where the others already are" is
  // what is on screen and not a second engine's answer.
  const before = handsBefore(ctx.lane);
  const shape = new Map();
  for (const n of ctx.col.notes) {
    const p = n === note ? { string, fret } : before.voiced.get(n);
    if (!p) return;                       // a column the voicer could not place
    shape.set(n, { string: p.string, fret: p.fret });
  }
  const shared = applySelectedPosition(ctx.col.notes, shape);
  if (shared.handled) { if (shared.error) toast(shared.error); return; }
  const linked = applyHammerPosition(ctx.lane, shape, n => before.voiced.get(n));
  if (linked.handled) return;
  applyColumnPos(ctx.col.notes, shape, "local", overrideFlow(ctx.col.notes));
}
function applyHammerPosition(lane, shape, positionOf, maxFret = laneFretCount(lane)) {
  const linked = hammerPositionPlan(lane, shape, laneFretTuning(lane), positionOf, maxFret);
  if (linked.linked) {
    const error = linked.error || (!canEditLane(lane) || linked.changes.some(c => boxOfNote(c.note)?.group.locked)
      ? 'The connected notes are locked' : null);
    if (error) return { handled: true, error };
    if (linked.changes.every(({ note, pos }) => !note.arrangement && note.pos &&
      Object.keys(pos).every(key => note.pos[key] === pos[key]))) return { handled: true, error: null };
    const prev = snapshotEdit();
    for (const { note: member, pos } of linked.changes) { member.pos = { ...pos }; delete member.arrangement; }
    commit(prev, undefined, null, { preserveTiming: true }); draw(); refreshTabIfOpen();
    return { handled: true, error: null };
  }
  return { handled: false, error: null };
}

// Pin a column where the board shows it, with `note` at (string, fret). Notes the
// voicer could not place stay automatic.
function pinColumnAt(note, string, fret, before) {
  const col = columnOf(note)?.col.notes || [note];
  const follow = normalizeOverrideInfluence(overrideFlow(col)).follow;
  for (const n of col) {
    const p = n === note ? { string, fret } : before.voiced.get(n);
    if (p) n.pos = { string: p.string, fret: p.fret, scope: "local", follow };
  }
}

// A note dragged on the fretboard to another string and fret: its pitch follows the
// place, so the spectrogram moves it too. One undo step.
export function moveNoteOnBoard(note, string, fret) {
  const lane = laneOf(note);
  if (!lane || !canEditLane(lane)) return;
  const pitch = laneFretTuning(lane)[string] + fret;
  const before = handsBefore(lane);
  if (columnOf(note)?.col.notes.some((n) => n !== note && before.voiced.get(n)?.string === string)) {
    toast("Another note of this chord is on that string"); return;
  }
  const prev = snapshotEdit();
  if (pitch !== note.pitch) { note.pitch = pitch; dropFingering(note); }
  pinColumnAt(note, string, fret, before);
  commit(prev); draw();
  refreshTabIfOpen();
}

// A note added on the fretboard at (string, fret), sounding from start to end.
export function addNoteOnBoard(lane, string, fret, start, end) {
  // The caller snaps the span; a cell ending at a tempo marker can be short.
  if (!lane || !canEditLane(lane) || !(end > start)) return null;
  const before = handsBefore(lane);
  const note = { id: nid(), start, end, pitch: laneFretTuning(lane)[string] + fret, confidence: 1 };
  const prev = snapshotEdit();
  lane.notes.push(note);
  pinColumnAt(note, string, fret, before);
  commit(prev);
  setSelection(new Set([note]));
  refreshCounts(); draw();
  refreshTabIfOpen();
  return note;
}

// Resolve current positions before explicitly changing a note on the fretboard.
function handsBefore(lane) {
  const found = voiceNotesFingered(lane.notes, laneFretTuning(lane), Infinity,
    { bars: songBarStarts(), instrument: lane.instrument, capo: lane.capo, holds: lane.handHolds });
  const byId = new Map();
  for (const n of lane.notes) {
    const pos = found.voiced.get(n);
    if (pos) byId.set(n.id, { ...pos, seat: found.seats.get(n) });
  }
  return { voiced: found.voiced, byId };
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
  const group = positionSelection(lane, S.selection);
  if (group.multiple) {
    if (group.error) { toast(group.error); return; }
    if (!canEditLane(lane)) return;
    const result = resetSharedPositions(lane, S.selection);
    if (!result.changed) return;
    const prev = snapshotEdit();
    lane.notes = result.notes;
    setSelection(result.selection);
    commit(prev); draw(); refreshTabIfOpen();
    return;
  }
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
//   rs        "absent" when Rocksmith does not have it
//             (on an item, or as a variant's third element). Native says nothing.
//
// Adding an effect is an entry here plus its setter; openNoteMenu below does not
// need to know it exists.
// What the Rocksmith chart makes of an effect it has no field for (rocksmith/chart.py).
const RS_NOTE = { ignore: "Shown but not scored in Rocksmith", pinch: "As pinch harmonic in Rocksmith", absent: "Not in Rocksmith", whammy: "As vibrato or a short note in Rocksmith",
  hammers: "As hammer-ons in Rocksmith", grace: "As a hammer-on in Rocksmith" };
// [short note in the row, tooltip] for an effect greyed out by another one.
const NO_BEND_ON_NATURAL = ["Not on a natural harmonic",
  "A natural harmonic is only touched, so its string cannot be bent.\nUse a pinch harmonic to bend it."];
const NO_NATURAL_WITH_BEND = ["Not with a bend",
  "A natural harmonic is only touched, so its string cannot be bent.\nRemove the bend, or use a pinch harmonic."];
const EFFECT_MENU = [
  { label: "Bends & slides", kw: "pitch expression", items: [
    { toggle: "vibrato", kw: "wobble" },
    // On/off: a full-step bend, shaped by dragging its points on the spectrogram.
    { field: "bend", on: "full", label: "Bend", kw: "pitch curve", set: setBendOnSelection },
    { field: "slide", label: "Slide", kw: "glide glissando", set: setSlideOnSelection, variants: [
      [null, "None"], ["shift", "Shift → next"], ["legato", "Legato → next"],
      ["inBelow", "In from below ↗"], ["inAbove", "In from above ↘"],
      ["outDown", "Out downward ↓"], ["outUp", "Out upward ↑"],
      ["pickDown", "Pick slide down"], ["pickUp", "Pick slide up"],
    ] },
    // On/off: a dip, shaped by dragging its points on the spectrogram.
    { field: "whammy", on: true, rs: "whammy", label: "Whammy bar", kw: "tremolo arm dive bar dip", set: setWhammyOnSelection },
    { only: "single", field: "trill", rs: "hammers", label: "Trill", kw: "ornament", set: (v) => setChoiceOnSelection("trill", v), variants: [
      [null, "None"], ["half", "½-step"], ["whole", "Whole-step"],
    ] },
    { only: "single", field: "grace", rs: "grace", label: "Grace note", kw: "ornament acciaccatura lead-in", set: (v) => setChoiceOnSelection("grace", v), variants: [
      [null, "None"], ["half", "½-step below"], ["whole", "Whole-step below"],
    ] },
  ] },
  { label: "Muting & dynamics", kw: "attack volume", items: [
    { toggle: "accent", kw: "loud emphasis" },
    { toggle: "ghost", rs: "ignore", kw: "quiet" },
    { toggle: "dead", kw: "x mute muted choke" },
    { toggle: "staccato", rs: "absent", kw: "short detached" },
    { toggle: "palmMute", kw: "pm damp" },
    { toggle: "letRing", rs: "absent", kw: "lr sustain ring" },
  ] },
  { label: "Picking & tapping", kw: "technique hand", items: [
    { toggle: "hammer", kw: "ho po legato pull-off" },
    { field: "harmonic", label: "Harmonic", kw: "chime", set: setHarmonicOnSelection, variants: [
      [null, "None"], ["natural", "Natural ◇"], ["pinch", "Pinch (P.H.)"], ["artificial", "Artificial", "pinch"],
    ] },
    { field: "tremPick", label: "Tremolo pick", kw: "repick", set: (v) => setChoiceOnSelection("tremPick", v), variants: [
      [null, "None"], ["8", "8th"], ["16", "16th"], ["32", "32nd"],
    ] },
    { field: "slap", label: "Slap / pop", kw: "thumb bass tapping", set: (v) => setChoiceOnSelection("slap", v), variants: [
      [null, "None"], ["tap", "Tapping"], ["slap", "Slapping"], ["pop", "Popping"],
    ] },
    { only: "single", field: "ornament", rs: "hammers", label: "Ornament", kw: "turn mordent", set: (v) => setChoiceOnSelection("ornament", v), variants: [
      [null, "None"], ["upperMordent", "Upper mordent"], ["lowerMordent", "Lower mordent"],
      ["turn", "Turn"], ["invertedTurn", "Inverted turn"],
    ] },
  ] },
];

// ---- note context menu (right-click): note effects + delete ----
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
    ...(S.detectRegion ? [{ label: "Find similar to range", kw: "search match repeat", fn: runFindSimilar }] : []),
    ...addMarker,
    { label: "Find repeats in this layer", kw: "search match similar passage fingering same", fn: () => runFindRepeats(targetLane()) },
    { label: "Add comment", kw: "note annotation", fn: () => addCommentAt(clientX, clientY) },
    { sep: true },
    { label: "Paste", fn: () => doPaste() },
  ];
  buildMenu(m, entries);
  markWalkthroughMenu(m);
  recordMenuOpen();
  placeCtxMenu(m, clientX, clientY);
}

// What can be done to one reference occurrence: on its badge and in the note menu.
function refActions(occ, clientX, clientY) {
  const { lane, ref, group } = occ, locked = !!group.locked;
  return {
    manage: [
      { label: locked ? "Unlock reference" : "Lock reference", fn: () => toggleRefEditLock(lane, ref) },
      { label: "Rename", disabled: locked, fn: () => beginArtifactRename("reference", lane, ref, { left: clientX, top: clientY, width: 0, height: 0 }) },
      group.transposable
        ? { label: "Use the same pitch", disabled: locked, fn: () => setRefPitchLock(lane, ref, true) }
        : { label: "Allow transposition", disabled: locked, fn: () => setRefPitchLock(lane, ref, false) },
    ],
    remove: [
      { label: "Delete this occurrence", disabled: locked, fn: () => deleteRefOccurrence(occ) },
      { label: "Delete entire reference", disabled: locked, fn: () => deleteRefGroup(lane, ref) },
      { sep: true },
      { label: "Detach this occurrence (keep notes)", disabled: locked, fn: () => detachSelection() },
      { label: "Detach entire reference (keep notes)", disabled: locked, fn: () => detachRefGroup(lane, ref) },
    ],
  };
}

// Right-clicking a reference badge: a minimal, reference-only menu — no note
// effects and no filter box (those don't apply to a reference). Acts on the
// occurrence the badge identifies (so it works even for an empty box); Detach
// operates on the current selection, which the caller set to the box's notes.
export function openRefMenu(clientX, clientY, occ, { origin = "editor" } = {}) {
  const m = ensureCtxMenu(); m.innerHTML = "";
  m.dataset.origin = origin;
  // Copy reads the current selection (the box's notes, set by the caller) and
  // remembers the source reference, so Paste can re-link it as a new occurrence.
  // Cut copies, then removes the whole occurrence (box + notes) — not just the
  // notes, which would leave an empty box behind.
  const { manage, remove } = refActions(occ, clientX, clientY);
  buildMenu(m, [
    { label: refName(occ.group, occ.ref), header: true },
    ...manage,
    { sep: true },
    { label: "Copy", fn: () => doCopy() },
    { label: "Cut", disabled: !!occ.group.locked, fn: () => { doCopy(); deleteRefOccurrence(occ); } },
    { sep: true },
    ...remove,
  ]);
  markWalkthroughMenu(m);
  recordMenuOpen();
  placeCtxMenu(m, clientX, clientY);
}

export function openMotifMenu(clientX, clientY, id, lane) {
  const menu = ensureCtxMenu(); menu.innerHTML = "";
  menu.dataset.origin = "artifact";
  buildMenu(menu, [
    {label: motifName(lane.notes, id), header: true},
    {label: "Rename", fn: () => beginArtifactRename("motif", lane, id, { left: clientX, top: clientY, width: 0, height: 0 })},
    {sep: true},
    {label: "Copy", fn: doCopy},
    {label: "Cut", fn: () => { doCopy(); doDelete(); }},
    {sep: true},
    {label: "Delete marked notes", fn: doDelete},
    {label: "Unmark motif (keep notes)", fn: unmarkSelectedMotifs},
  ]);
  recordMenuOpen();
  placeCtxMenu(menu, clientX, clientY);
}

// Human-readable names for the single-choice effects (used by the quick-remove
// strip; fx flags use FX_LABELS, bend/slide/harmonic are named inline below).

// Effects present on ANY selected note, each with a clear() that strips it from
// the whole selection — powers the right-click quick-remove strip.
function appliedEffects(sel) {
  const any = (f) => sel.some(f), out = [];
  for (const k of FX_KEYS) if (any((n) => fxOn(n, k)))
    out.push({ label: FX_LABELS[k], clear: () => setFxOnSelection(k, false) });
  // Variant pickers name the variant set, as their submenu does: "Slide: Shift → next".
  for (const item of EFFECT_MENU.flatMap((g) => g.items)) {
    if (!item.field) continue;
    const kinds = [...new Set(sel.flatMap((n) => [n[item.field], item.field === "slide" ? n.slideIn : null]).filter(Boolean))];
    if (!kinds.length) continue;
    if (item.on) { out.push({ label: item.label, clear: () => item.set(null) }); continue; }
    const name = (k) => item.variants.find(([v]) => v != null && String(v) === String(k))?.[1] ?? k;
    out.push({ label: `${item.label}: ${kinds.map(name).join(", ")}`, clear: () => item.set(null) });
  }
  return out;
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
    { label: "Find repeats in this layer", kw: "search match similar passage fingering same", fn: () => runFindRepeats(laneOf([...S.selection][0]) || targetLane()) },
    ...(S.matches.length ? [
      { label: "Previous similar passage", kw: "search match back", keepOpen: true,
        fn: () => focusAdjacentMatch(-1, { preview: true }) },
      { label: "Preview similar passage", kw: "search match listen audition", keepOpen: true,
        fn: previewFocusedMatch },
      { label: "Next similar passage", kw: "search match forward", keepOpen: true,
        fn: () => focusAdjacentMatch(1, { preview: true }) },
    ] : []),
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
  const fxItem = (key, kw, rs) => {
    const on = sel.every((n) => fxOn(n, key));
    return { label: (on ? "✓ " : "") + FX_LABELS[key], kw, note: RS_NOTE[rs], fn: () => setFxOnSelection(key, !on) };
  };
  // The variant every selected note shares for `field` (null if they differ / none).
  const common = (field) => {
    const v = sel[0][field] ?? null;
    return sel.every((n) => (n[field] ?? null) === v) ? v : null;
  };
  // A variant-picker submenu with ✓ on the active choice (radio-style, so "None"
  // is ticked when nothing is set) and on the parent when any variant is applied.
  // opts = [[value, label], …]; value null is the clear item.
  const pick = (field, label, kw, set, opts, rs) => {
    const cur = common(field);
    const parentBlock = blocked(field, "any");
    return { label: (cur ? "✓ " : "") + label, kw, note: parentBlock?.[0] || RS_NOTE[rs], tip: parentBlock?.[1],
      children: opts.map(([v, l, vrs]) => {
        const block = v == null ? null : blocked(field, v);
        return { label: (cur === v ? "✓ " : "") + l, note: block?.[0] || RS_NOTE[vrs], tip: block?.[1],
          disabled: !!block, fn: () => set(v) };
      }) };
  };
  // An effect that is just on or off (a bend: its shape is dragged on the stage).
  const onOff = (item) => {
    const on = sel.every((n) => n[item.field]), block = on ? null : blocked(item.field, item.on);
    return { label: (on ? "✓ " : "") + item.label, kw: item.kw, note: block?.[0] || RS_NOTE[item.rs], tip: block?.[1],
      disabled: !!block, fn: () => item.set(on ? null : item.on) };
  };
  // A natural harmonic is only touched, never pressed, so its string cannot be
  // bent; the two exclude each other. A pinch harmonic can be bent.
  const natural = sel.some((n) => n.harmonic === "natural"), bent = sel.some((n) => n.bend);
  function blocked(field, value) {
    if (field === "bend" && natural) return NO_BEND_ON_NATURAL;
    if (field === "harmonic" && value === "natural" && bent) return NO_NATURAL_WITH_BEND;
    return null;
  }
  const families = EFFECT_MENU
    .filter((family) => !family.only || family.only === (isChord ? "chord" : "single"))
    .map((family) => ({
      family: true, label: family.label, kw: family.kw,
      children: family.items
        .filter((item) => !item.only || item.only === (isChord ? "chord" : "single"))
        .map((item) => (item.toggle ? fxItem(item.toggle, item.kw, item.rs)
          : item.on ? onOff(item)
          : pick(item.field, item.label, item.kw, item.set, item.variants, item.rs))),
    }));

  // Declarative menu: { label, fn } = action, { label, children } = hover submenu,
  // { keepOpen: true } = an action you repeat, so the menu survives the click.
  // { sep:true } = divider, { family:true } = a top-level grouping (transparent to
  // search, so results read "Bend · full", not "Bends & slides · Bend · full").
  // Grouping: reference, motif, arpeggio and handshape each get a submenu of the
  // same shape: make one from the selection, or act on the one it is in.
  const rect = { left: clientX, top: clientY, width: 0, height: 0 };
  const oneLane = new Set(sel.map(laneOf)).size === 1;
  const refEntry = refMenuEntry(sel);
  const occ = refEntry ? null : sel.map(boxOfNote).find(Boolean);
  const refActs = occ && refActions(occ, clientX, clientY);
  const refItems = refEntry ? [refEntry] : occ ? [
    { label: "Select entire reference", fn: () => { setSelection(new Set(occurrenceNotes(occ))); draw(); } },
    ...refActs.manage, { sep: true }, ...refActs.remove,
  ] : [];
  const selectedMotifIds = [...new Set(sel.map((n) => n.motifId).filter(Boolean))];
  const motifActions = [
    ...(sel.length >= 1 && oneLane ? [{ label: "Mark as motif", fn: markSelectionAsMotif }] : []),
    ...(selectedMotifIds.length === 1 ? [
      { label: "Select entire motif", fn: selectEntireMotif },
      { label: "Rename", fn: () => beginArtifactRename("motif", laneOf(sel[0]), selectedMotifIds[0], rect) },
    ] : []),
    ...(selectedMotifIds.length ? [{ label: "Unmark motif (keep notes)", fn: unmarkSelectedMotifs }] : []),
  ];
  // Only shapes that still frame two notes or more (shapes.js shapeGroups).
  const liveShapes = oneLane ? shapeGroups(laneOf(sel[0]).notes) : new Map();
  const selectedShapeIds = [...new Set(sel.map((n) => n.shapeId).filter((id) => liveShapes.has(id)))];
  const shapeMenu = (kind, kw) => {
    const name = SHAPE_KINDS[kind], low = name.toLowerCase();
    const ids = selectedShapeIds.filter((id) => liveShapes.get(id)[0].shapeKind === kind);
    const children = [
      ...(sel.length >= 2 && oneLane ? [{ label: `Mark as ${low}`, fn: () => markSelectionAsShape(kind) }] : []),
      ...(ids.length === 1 ? [{ label: `Select entire ${low}`, fn: () => selectEntireShape(kind) }] : []),
      ...(ids.length ? [{ label: `Remove ${low} (keep notes)`, fn: () => unmarkSelectedShapes(kind) }] : []),
    ];
    return children.length ? [{ label: name, kw, children }] : [];
  };
  // Rocksmith-only settings of the selected notes. The export decides how chords
  // are drawn by itself, as EOF does; these override it, and keep EOF's names in
  // brackets for those who know them.
  const selLane = oneLane ? laneOf(sel[0]) : null;
  // Only on a layer the Rocksmith export plays: a melody or vocal layer has no frets.
  const editable = selLane && canEditLane(selLane) && isTablatureLane(selLane);
  const sameOnset = (a, b) => Math.abs(a.start - b.start) < 0.002;
  // A grip-only note is not played, so it makes no chord with the note beside it.
  const inChord = (n) => !n.gripOnly && selLane.notes.some((m) => m !== n && !m.gripOnly && sameOnset(m, n));
  const chordNotes = editable ? sel.filter(inChord) : [];
  // A chord setting goes on the whole chord, not only its selected notes: the export reads any.
  const wholeChords = () => selLane.notes.filter((n) => !n.gripOnly && chordNotes.some((c) => sameOnset(c, n)));
  const setField = (notes, key, value) => {
    const prev = snapshotEdit();
    for (const n of notes) { if (value) n[key] = value; else delete n[key]; }
    commitStructure(prev);
  };
  const tick = (on, label) => `${on ? "✓ " : ""}${label}`;
  const displayNow = new Set(chordNotes.map((n) => n.chordDisplay || ""));
  const displayItem = (value, label, tip) => ({
    label: tick(displayNow.size === 1 && displayNow.has(value), label), tip,
    fn: () => setField(wholeChords(), "chordDisplay", value),
  });
  const allIgnored = editable && sel.every((n) => n.ignore);
  // Fingerless is about a grip: a chord's, or an arpeggio's or handshape's.
  const gripNotes = () => [...new Set([...wholeChords(),
    ...selLane.notes.filter((n) => selectedShapeIds.includes(n.shapeId))])];
  const hasGrip = chordNotes.length > 0 || (editable && selectedShapeIds.length > 0);
  const allFingerless = hasGrip && gripNotes().every((n) => n.fingerless);
  const rocksmithActions = editable ? [{
    label: "Rocksmith", kw: "rocksmith ignore score fingerless fingers high density crazy chord display",
    children: [
      { label: tick(allIgnored, "Not scored (Ignore)"), kw: "ignore score",
        tip: "Rocksmith shows the note but does not score it: for a note the game cannot hear well. "
          + "In a chord, the whole chord is not scored. Notes on frets 23 and 24 are never scored anyway.",
        fn: () => setField(sel, "ignore", !allIgnored) },
      ...(selectedShapeIds.length ? [
        { label: tick(sel.every((n) => n.gripOnly), "Grip only (Ghost gem)"), kw: "ghost gem grip only shape",
          tip: "The note is part of the arpeggio's or handshape's grip that Rocksmith shows, but it is not played: "
            + "not heard, not scored, not in Guitar Pro. For a full chord shape where only some strings are picked.",
          fn: () => { const on = !sel.every((n) => n.gripOnly);
            setField(sel.filter((n) => !on || selectedShapeIds.includes(n.shapeId)), "gripOnly", on); } },
      ] : []),
      ...(hasGrip ? [
        { label: tick(allFingerless, "No finger numbers (Fingerless)"), kw: "fingerless fingers",
          tip: "Rocksmith shows the chord, arpeggio or handshape without finger numbers, on purpose: for a grip "
            + "any fingering plays. The fretboard keeps its fingers.",
          fn: () => setField(gripNotes(), "fingerless", !allFingerless) },
      ] : []),
      ...(chordNotes.length ? [
        { label: "Chord display", kw: "high density crazy repeat full chord",
          tip: "How Rocksmith draws these chords: in full, or as a short repeat of the chord before.",
          children: [
            displayItem("", "Automatic", "A chord is drawn in full when it is new, starts a phrase, changes its mute "
              + "or plays a technique of its own. A chord repeated right after itself is drawn as a repeat (a frame "
              + "without frets), as in EOF."),
            displayItem("full", "Always in full (Crazy)", "Draw this chord with all its frets and fingers even when it "
              + "repeats the chord before, e.g. after a pause. EOF calls this Crazy."),
            displayItem("repeat", "Always as repeat (High density)", "Draw this chord as a repeat frame without frets "
              + "even where it would be drawn in full. Techniques on it are kept. EOF calls this High Density."),
          ] },
      ] : []),
    ],
  }] : [];
  // The selection is (part of) one chord: it can be renamed from here too, which
  // is the way to name one the stage shows no name for.
  const selChord = oneLane ? chordOfNote(laneOf(sel[0]), sel[0]) : null;
  const chordEntry = selChord && sel.every((n) => selChord.notes.includes(n)) && canEditLane(laneOf(sel[0]))
    ? [{ label: "Rename chord…", kw: "chord name symbol", fn: () => beginChordRename(selChord, { left: clientX, top: clientY, width: 0, height: 0 }) }]
    : [];
  // Recalculate positions: one way back to the engine's answer for any selected tab
  // note, whoever set its position.
  const columnActions = [
    ...chordEntry,
    ...(sel.some((n) => canEditLane(laneOf(n)) && isTablatureLane(laneOf(n)))
      ? [{ label: "Recalculate positions", kw: "revoice refinger reset unpin return automatic fingering position voicing hand",
        fn: revoiceSelection }]
      : []),
  ];
  const grouping = [
    ...(refItems.length ? [{ label: "Reference", kw: "repeat copies linked duplicate group", children: refItems }] : []),
    ...(motifActions.length ? [{ label: "Motif", kw: "group phrase label", children: motifActions }] : []),
    ...shapeMenu("arpeggio", "arp broken chord grip frame rocksmith group"),
    ...shapeMenu("handshape", "grip frame hold chord shape rocksmith group"),
    ...similarEntries(),
  ];
  // Other layers to copy or move the selection into; hidden/locked ones are shown
  // but disabled, so the list does not change shape with layer state.
  const others = editLanes().filter((l) => !(oneLane && l === laneOf(sel[0])));
  const laneItems = (move) => others.map((l) => ({
    label: l.name, disabled: !canEditLane(l),
    tip: canEditLane(l) ? undefined : `Layer is ${l.visible ? "locked" : "hidden"}`,
    fn: () => sendSelectionToLane(l, { move }),
  }));
  const laneTargets = others.length ? [{ label: "Send to layer", kw: "layer lane", children: [
    { label: "Copy to", header: true }, ...laneItems(false),
    { label: "Move to", header: true }, ...laneItems(true),
  ] }] : [];
  const edit = [
    { label: "Copy", kw: "clipboard duplicate", fn: () => doCopy() },
    { label: "Cut", kw: "clipboard", fn: () => doCut() },
    { label: "Delete", kw: "remove erase", fn: () => doDelete() },
    ...laneTargets,
  ];
  // Effects (with how Rocksmith shows the notes), chord & fingering, grouping, edit.
  // Any group can be empty, and an empty one takes its divider with it.
  const tree = [[...families, ...rocksmithActions], columnActions, grouping, edit]
    .filter((group) => group.length)
    .flatMap((group, i) => (i ? [{ sep: true }, ...group] : group));
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
  search.placeholder = "Search…"; search.spellcheck = false;
  const browse = document.createElement("div");
  const results = document.createElement("div"); results.className = "ctxmenu-results"; results.hidden = true;
  buildMenu(browse, [...appliedSection, ...tree]);
  m.append(search, browse, results);
  markWalkthroughMenu(m);
  recordMenuOpen();

  // Search finds every action in the menu; only the applied strip is browse-only.
  const flat = flattenActions(tree);
  let matches = [], hi = 0;
  const paint = () => [...results.children].forEach((c, i) => c.classList.toggle("ctxmenu-hi", i === hi));
  const renderResults = () => {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    results.innerHTML = ""; hi = 0;
    if (!terms.length) { browse.hidden = false; results.hidden = true; matches = []; place(); return; }
    browse.hidden = true; results.hidden = false;
    matches = flat.filter((a) => terms.every((t) => a.search.includes(t))).slice(0, 12);
    if (!matches.length) {
      const none = document.createElement("div"); none.className = "ctxmenu-empty"; none.textContent = "No matching action";
      results.append(none);
    } else matches.forEach((a, i) => {
      const b = document.createElement("button"); b.className = "ctxmenu-item"; labelItem(b, a.display, a.note);
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
function flattenActions(entries, crumb = "", crumbKw = "", crumbNote = undefined) {
  const out = [];
  let head = "";   // a header ("Copy to") names the items after it
  for (const e of entries) {
    if (e.header) { head = e.label; continue; }
    if (e.sep) continue;
    if (e.children) {
      if (e.family) out.push(...flattenActions(e.children));
      else out.push(...flattenActions(e.children, e.label.replace(/^✓ /, ""), e.kw || "", e.note));
    } else if (e.fn && !e.disabled) {
      const label = head ? `${head} ${e.label}` : e.label;
      const display = crumb ? `${crumb} · ${label}` : label;
      out.push({ display, note: e.note || crumbNote, search: `${crumb} ${label} ${crumbKw} ${e.kw || ""}`.toLowerCase(), fn: e.fn });
    }
  }
  return out;
}

// Keyboard routing keeps project commands, focus rules and note navigation
// in their existing priority order. Each handler owns one set of actions.
function handleProjectShortcut(e, mod) {
  if (mod && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    if (S.state) saveProject({ saveAs: e.shiftKey });
    return true;
  }
  if (mod && (e.key === "n" || e.key === "N")) { e.preventDefault(); openNewProject(); return true; }
  if (mod && (e.key === "o" || e.key === "O")) { e.preventDefault(); openProject(); return true; }
  return false;
}

function handleNavigationShortcut(e, mod, runEditorShortcut) {
  if (!/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && !e.target.isContentEditable && !modalOpen()) {
    if (mod && !e.altKey && !e.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault(); navigateMarker(e.key === 'ArrowLeft' ? -1 : 1); return true;
    }
    if (mod && !e.altKey && !e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault(); shiftSelectionOctave(e.key === 'ArrowUp' ? 12 : -12); return true;
    }
    if (runEditorShortcut(e)) { e.preventDefault(); return true; }
  }
  return false;
}

function handleNoteNavigation(e, mod) {
  if (e.key === "Escape" && S.matches.length) { e.preventDefault(); clearMatches(); draw(); return true; }
  if (!mod && S.matches.length && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault(); focusAdjacentMatch(e.key === "ArrowRight" ? 1 : -1, { preview: true }); return true;
  }
  // ← → walk the song a chord at a time, from the playhead, and ↑ ↓ pick between
  // the columns sounding at once where a held note and a moving line are not one
  // chord. Both used to belong to the tab preview, which made reading a piece a
  // property of a window being open — they are the app's, and the fretboard and
  // the spectrogram follow the selection they move. After the match arrows, which
  // are a mode with its own reading of the same keys.
  if (!mod && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault(); stepColumnFocus(e.key === "ArrowRight" ? 1 : -1); return true;
  }
  if (!mod && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault(); stepVoiceFocus(e.key === "ArrowUp" ? 1 : -1); return true;
  }
  if (!mod && !e.altKey && S.matches.length && (e.key === "p" || e.key === "P")) { e.preventDefault(); previewFocusedMatch(); return true; }
  if (!mod && S.matches.length && e.key === "Enter") {
    e.preventDefault();
    acceptMatch(S.matchFocus >= 0 ? S.matchFocus : 0, e.shiftKey ? "reference" : "copy");
    return true;
  }
  if (!mod && !e.altKey && (e.key === "a" || e.key === "A") && S.matches.length) { e.preventDefault(); acceptAllMatches(e.shiftKey ? "reference" : "copy"); return true; }
  return false;
}

function handleEditShortcut(e, mod) {
  if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); }
  else if (mod && !e.altKey && !e.shiftKey && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    const lane = activeLane();
    if (lane && canEditLane(lane)) { setSelection(new Set(lane.notes)); draw(); }
  }
  else if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); doCopy(); }
  else if (mod && (e.key === "x" || e.key === "X")) { e.preventDefault(); doCut(); }
  else if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); doPaste({ mode: e.shiftKey ? "reference" : undefined }); }
  else if (matchKey(e, "delete")) {
    e.preventDefault();
    // Over a layer row it deletes that layer, through the same confirmation as its button.
    const laneRow = document.querySelector("#lanes .lane-row:hover");
    const stemRow = document.querySelector("#stemTabs .stem-row:hover");
    const lane = laneRow && editLanes().find((l) => String(l.id) === laneRow.dataset.lane);
    const stem = stemRow && S.state.stems.find((s) => String(s.id) === stemRow.dataset.stem);
    if (lane) confirmRemoveLane(lane);
    else if (stem) { if (!isMasterStem(stem)) confirmStemRemoval(stem); }
    else doDelete({ hovered: true });
  }
  else if (e.key === "Escape" && clearMarkerSelection()) e.preventDefault();
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
  else if (matchKey(e, "splitView")) { e.preventDefault(); $("splitViewToggle").click(); }
}

export function init_edit({ openSettingsModal }) {
  const runEditorShortcut = createEditorShortcutRunner({ openSettingsModal, markSelectionAsMotif, markSelectionAsShape, selectEntireMotif, unmarkSelectedMotifs, unmarkSelectedShapes, setFxOnSelection });
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
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    // Each dialog handles its own keys (Space in the Rocksmith export plays the
    // preview clip). Escape still closes the topmost layer, which some dialogs
    // rely on; save/new/open only lose the browser's own meaning. A full view
    // marked data-editor-keys (the tablature) keeps playback and navigation.
    if (modalOpen('[aria-modal="true"]:not([data-editor-keys])')) {
      if (e.key === "Escape" && closeTopmost()) e.preventDefault();
      else if (mod && ["s", "n", "o"].includes(e.key.toLowerCase())) e.preventDefault();
      return;
    }
    // Space = play/pause from anywhere (suppress button clicks / page scroll),
    // except while typing in a text field where a space is a real character.
    if (matchKey(e, "playPause")) {
      if (!isTextField(e.target) || e.target.matches?.('#markerPop input[type="number"]')) {
        e.preventDefault(); ensureTone().then(togglePlay);
      }
      return;
    }
    // No Tab walk through the editor's controls; Tab alone still opens the note menu below.
    // Popovers (role=dialog) keep Tab, so a typed value is applied when leaving its field.
    if (e.key === "Tab" && !modalOpen() && !e.target.closest?.('[role="dialog"]')) e.preventDefault();
    if (handleProjectShortcut(e, mod)) return;
    // Overlays register themselves; see escape-stack.js for the depth order.
    if (e.key === "Escape" && closeTopmost()) { e.preventDefault(); return; }
    if (handleNavigationShortcut(e, mod, runEditorShortcut)) return;
    // A button has no undo of its own, and one keeps the focus after every menu
    // command — so undo/redo reach the editor from there; text fields keep theirs.
    if (mod && !e.altKey && e.target.tagName === "BUTTON" && ["z", "y"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      if (e.key.toLowerCase() === "y" || e.shiftKey) redo(); else undo();
      return;
    }
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
    if (!mod && !e.altKey && e.key === "Tab" && openSelectedNoteMenu()) {
      e.preventDefault();
      return;
    }
    if (matchKey(e, "resetZoom")) { e.preventDefault(); resetZoom(); return; }
    // Similar-passage search: F finds; arrows jump+preview; Enter places focus.
    if (handleNoteNavigation(e, mod)) return;
    handleEditShortcut(e, mod);
  });
}
