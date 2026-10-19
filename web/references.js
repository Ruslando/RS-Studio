// Linked repeated-note groups ("references"): creating a reference from a selection
// and the per-occurrence operations (move, resize, or edit a single instance).

import { stageUi } from "./constants.js";
import { scroll, sctx } from "./dom.js";
import { confirmChoice } from "./dialog.js";
import { draw } from "./repaint.js";
import { stageIcon } from "./icons.js";
import { commit, commitStructure, snapshotEdit } from "./edit.js";
import { pitchAt, timeAt, xOf, yOf } from "./geometry.js";
import { gridAt, minDur, segStep, snap } from "./grid.js";
import { nid } from "./ids.js";
import { editLanes, laneOf, refreshCounts } from "./lanes.js";
import { EFFECT_FIELDS, copyEffects } from "./note-effects.js";
import { toast } from "./notify.js";
import { beatShape, effectSig, inRefBox, occurrenceBox, shiftOf, spanAt } from "./reference-core.js";
export { occurrenceBox, shiftOf, spanAt } from "./reference-core.js";
import { beatClock } from "./bars.js";
import { timingSegments } from "./grid.js";
import { timingData, timingIdOf } from "./timing.js";
import { PAINT, WASH, halo } from "./stage-paint.js";
import { S } from "./store.js";
import { projectStart } from "./project-position-core.js";
import { clamp, hexA } from "./util.js";

// ---- references (linked repeated note groups) ----
// A reference group is a numbered set of capture BOXES placed over identical
// repeats of a passage. The box is the source of truth: whatever notes sit inside
// a box are mirrored (relative to the box) into every other box of the group — so
// drawing, moving in/out, editing or deleting a note inside a box keeps all the
// repeats in sync, however the change was made. Boxes live on their owning lane so
// they round-trip through save + undo; notes carry no tags — membership is purely
// geometric.
//   lane.refBoxes[ref] = { rt0, rt1, pLo, pHi, anchors:[t, …] }
// Box i spans [rb0, rb1] beats from anchors[i] on its layer's grid (so one shape
// mirrors to every box, and a box under a faster tempo is shorter in seconds; the
// notes mirror in beats too; rt0/rt1 hold the same shape in seconds at the first
// box, for older readers) and [pLo, pHi] in pitch — shared by every
// occurrence unless the group is `transposable`, when occurrence i sits
// `shifts[i]` semitones off it. Pitches mirror relative to each box's shift;
// effects mirror unchanged, and a shifted copy is fingered anew.
export const REF_TIME_TOL = 0.03;   // s — timing slack when matching repeats

export const refName = (group, ref) => group?.name || `Reference #${ref}`;
export const REF_ACCENT = PAINT.ref;  // one hue for all refs; the number disambiguates

export const REF_BOX_EDGE_TOL = 5;   // px from a box edge that grabs it for resizing

export const noteOrder = (a, b) => (a.start - b.start) || (a.pitch - b.pitch);

// Tight time+pitch bounds of a set of notes.
export function noteBounds(notes) {
  let t0 = Infinity, t1 = -Infinity, pLo = Infinity, pHi = -Infinity;
  for (const n of notes) {
    t0 = Math.min(t0, n.start); t1 = Math.max(t1, n.end);
    pLo = Math.min(pLo, n.pitch); pHi = Math.max(pHi, n.pitch);
  }
  return { t0, t1, pLo, pHi };
}

// Absolute rect of occurrence i's box, clamped to the song / pitch range.
function boxRect(group, i, clock) {
  const o = occurrenceBox(group, i, clock);
  return {
    t0: Math.max(0, o.t0), t1: Math.min(S.state.duration, o.t1),
    pLo: Math.max(S.state.spec.midi_low, o.pLo), pHi: Math.min(S.state.spec.midi_high, o.pHi),
  };
}

// The beat clock of a layer's own timing (the song's, or its own tempo map).
export const laneClock = (lane) => beatClock(timingSegments(timingData(timingIdOf(lane))));

// Set a group's shape in beats, and its seconds at the first box for older readers.
export function setBeatShape(group, r0, r1, clock) {
  group.rb0 = r0; group.rb1 = r1;
  const a = group.anchors[0], { t0, t1 } = spanAt(group, a, clock);
  group.rt0 = t0 - a; group.rt1 = t1 - a;
}

// Pin a group's shape in beats before its first box changes: a group saved before
// beats were stored reads its shape at that first box, so it has to be written
// down while the first box is still the one it was measured at.
function freezeShape(lane, group) {
  if (Number.isFinite(group.rb0)) return;
  const clock = laneClock(lane), [r0, r1] = beatShape(group, clock);
  group.rb0 = r0; group.rb1 = r1;
}

// Whether `box` would overlap any reference box in `lane` other than occurrence
// `except` ({ ref, i }). A reference is never placed inside another one, nor a
// dropped motif inside a reference: notes join a reference one at a time, drawn
// or pasted by hand.
export function overlapsRefBox(lane, box, except = null) {
  const clock = laneClock(lane);
  for (const [key, group] of Object.entries(lane.refBoxes || {})) {
    if (!group?.anchors?.length) continue;
    for (let i = 0; i < group.anchors.length; i++) {
      if (except && +key === except.ref && i === except.i) continue;
      const b = occurrenceBox(group, i, clock);
      if (box.t0 < b.t1 - 1e-6 && box.t1 > b.t0 + 1e-6 && box.pLo <= b.pHi && box.pHi >= b.pLo) return true;
    }
  }
  return false;
}

// A note moved to another pitch cannot keep its string, fret or written chord.
export function dropFingering(note) { delete note.pos; delete note.arrangement; }

// Notes from `arr` that sit inside `box`: pitch within range, and at least one
// full cell (the smallest a note may be) of the note lies inside the box's time
// span — a note merely grazing the edge has to be pushed a cell deep to join.
// The cell is the one in force where the box starts: under a faster tempo the
// notes are shorter, and the base tempo's cell would leave them all outside.
export const boxMinIn = (t) => Math.min(minDur(), segStep(gridAt(t)) || minDur());
export function notesInBox(box, arr) {
  const minIn = boxMinIn(box.t0);
  return arr.filter((n) => inRefBox(n, box, minIn));
}

// Visit every (well-formed) reference group: cb(lane, ref, group).
export function eachRefGroup(cb) {
  for (const l of editLanes()) {
    if (!l.refBoxes) continue;
    for (const ref of Object.keys(l.refBoxes)) {
      const g = l.refBoxes[ref];
      if (g && Array.isArray(g.anchors) && g.anchors.length && typeof g.rt0 === "number") cb(l, +ref, g);
    }
  }
}

// Next free group number = 1 + the current max across every lane.
// Capture protected content before an edit. JSON strings also protect nested
// effects, which otherwise share objects with the ordinary undo snapshot.
const lockShape = ({ locked, ...shape }) => JSON.stringify(shape);
const lockNotes = notes => JSON.stringify([...notes].sort((a, b) => String(a.id).localeCompare(String(b.id))));
export function lockedReferenceSnapshot() {
  const protectedRefs = [];
  eachRefGroup((lane, ref, group) => {
    if (!group.locked) return;
    const clock = laneClock(lane);
    const boxes = group.anchors.map((_, i) => boxRect(group, i, clock));
    protectedRefs.push({ lane: lane.id, ref, shape: lockShape(group), boxes,
      notes: boxes.map(box => lockNotes(notesInBox(box, lane.notes))) });
  });
  return protectedRefs;
}

export function lockedReferenceFault(previous, translation = 0) {
  const same = translation
    ? (a, b) => JSON.stringify(a, (_, value) => typeof value === 'number' ? Math.round(value * 1e8) / 1e8 : value)
      === JSON.stringify(b, (_, value) => typeof value === 'number' ? Math.round(value * 1e8) / 1e8 : value)
    : (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const protectedRef of previous || []) {
    const lane = editLanes().find(l => l.id === protectedRef.lane);
    const group = lane?.refBoxes?.[protectedRef.ref];
    const shape = JSON.parse(protectedRef.shape);
    if (translation) shape.anchors = shape.anchors.map(anchor => anchor + translation);
    if (!group || !same(JSON.parse(lockShape(group)), shape)) return protectedRef.ref;
    const clock = laneClock(lane);
    for (let i = 0; i < group.anchors.length; i++) {
      const box = boxRect(group, i, clock);
      const expectedBox = { ...protectedRef.boxes[i] };
      const expectedNotes = JSON.parse(protectedRef.notes[i]);
      if (translation) {
        expectedBox.t0 += translation; expectedBox.t1 += translation;
        for (const note of expectedNotes) { note.start += translation; note.end += translation; }
      }
      if (!same(box, expectedBox) || !same(JSON.parse(lockNotes(notesInBox(box, lane.notes))), expectedNotes)) return protectedRef.ref;
    }
  }
  return null;
}

export function toggleRefEditLock(lane, ref) {
  const group = lane.refBoxes?.[ref];
  if (!group) return;
  const prev = snapshotEdit();
  if (group.locked) delete group.locked; else group.locked = true;
  commitStructure(prev);
}

export function nextRef() {
  let m = 0;
  eachRefGroup((l, ref) => { m = Math.max(m, ref); });
  return m + 1;
}

// Which box a note sits in: { lane, ref, group, i } or null.
export function boxOfNote(note) {
  let hit = null;
  eachRefGroup((l, ref, group) => {
    if (hit || !l.notes.includes(note)) return;
    const clock = laneClock(l);
    for (let i = 0; i < group.anchors.length; i++)
      if (notesInBox(boxRect(group, i, clock), [note]).length) { hit = { lane: l, ref, group, i }; return; }
  });
  return hit;
}

// Canonical signature of a note's written notation/fingering metadata.
export { effectSig } from "./reference-core.js";

// Pattern of a set of notes: anchor t0 + per-slot relative timing/pitch/notation.
function patternOf(notes) {
  const sorted = [...notes].sort(noteOrder);
  const t0 = sorted.length ? sorted[0].start : 0;
  const slots = sorted.map((n) => ({
    relStart: n.start - t0, dur: n.end - n.start, pitch: n.pitch, sig: effectSig(n), src: n,
  }));
  return { t0, slots };
}

// Contents of a box as a pattern relative to an anchor, so it can be replayed into
// a sibling box at that box's anchor: sorted [{ dt, dur, pitch, src }].
function relPattern(notes, anchor, shift, clock) {
  const b = clock.beatAt(anchor);
  return [...notes].sort(noteOrder).map((n) => {
    const s = clock.beatAt(n.start);
    return { dt: s - b, dur: clock.beatAt(n.end) - s, pitch: n.pitch - shift, src: n };
  });
}

// Position-independent fingerprint of a box's contents (anchored), for spotting
// which box the user just changed.
// Fingering is compared only between boxes at the same pitch: a shifted copy has
// its own.
function boxSig(notes, anchor, shift, includePos, clock) {
  return relPattern(notes, anchor, shift, clock)
    .map((p) => `${p.dt.toFixed(3)}|${p.dur.toFixed(3)}|${p.pitch}|${effectSig(p.src, { includePos })}`).join("~");
}

// Find every occurrence of `selNotes`' pattern within one edit lane: exact pitches,
// same relative timing (within REF_TIME_TOL), identical notations. Returns a list
// of slot-ordered note[] occurrences. Each note belongs to at most one occurrence.
function findRepeats(selNotes, lane) {
  const pat = patternOf(selNotes);
  if (!pat.slots.length) return [];
  const s0 = pat.slots[0];
  const byPitch = new Map();
  for (const n of lane.notes) {
    if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []);
    byPitch.get(n.pitch).push(n);
  }
  // Candidate anchors: notes that could be slot 0 (same pitch + notations).
  const anchors = (byPitch.get(s0.pitch) || []).filter((n) => effectSig(n) === s0.sig);
  const occ = [];   // { notes:[], t0 }
  for (const a of anchors) {
    const base = a.start - s0.relStart;   // the t0 this candidate implies
    const picked = [], usedHere = new Set();
    let ok = true;
    for (const slot of pat.slots) {
      const want = base + slot.relStart;
      const cand = (byPitch.get(slot.pitch) || []).find((n) =>
        !usedHere.has(n) &&
        Math.abs(n.start - want) <= REF_TIME_TOL &&
        Math.abs((n.end - n.start) - slot.dur) <= REF_TIME_TOL &&
        effectSig(n) === slot.sig);
      if (!cand) { ok = false; break; }
      picked.push(cand); usedHere.add(cand);
    }
    if (ok) occ.push({ notes: picked, t0: base });
  }
  // Greedy: earliest first, drop any occurrence that reuses an already-claimed note
  // (overlapping/duplicate hits) so each note lands in at most one occurrence.
  occ.sort((p, q) => p.t0 - q.t0);
  const claimed = new Set(), result = [];
  for (const o of occ) {
    if (o.notes.some((n) => claimed.has(n))) continue;
    o.notes.forEach((n) => claimed.add(n));
    result.push(o.notes);
  }
  return result;
}

// Group the selection into a reference: find its repeats in the lane and, if the
// user agrees, drop a capture box over each. The boxes (not the notes) hold the
// link — so linking a repeat by surprise means a later edit lands where nobody
// looked. Repeats are therefore offered, never applied silently.
async function markSelectionAsReference() {
  const sel = [...S.selection].filter((n) => laneOf(n));
  if (!sel.length) { toast("Select notes in an edit lane to group into a reference"); return; }
  const lane = laneOf(sel[0]);
  const selNotes = sel.filter((n) => laneOf(n) === lane);
  if (selNotes.some((n) => boxOfNote(n))) { toast("Selection is already inside a reference"); return; }
  let occ = findRepeats(selNotes, lane);
  if (!occ.length) return;
  const ref = nextRef();
  if (occ.length > 1) {
    const choice = await confirmChoice({
      title: "Link repeats?",
      message: `${occ.length - 1} other place${occ.length === 2 ? "" : "s"} in "${lane.name}" ha${occ.length === 2 ? "s" : "ve"} exactly the same notes. `
        + `Link ${occ.length === 2 ? "it" : "them"} into reference #${ref} too? Editing one copy will then change all of them.`,
      confirmLabel: `Link all ${occ.length}`,
      alternativeLabel: "Only the selection",
    });
    if (choice === "cancel") return;
    if (choice === "alternative") occ = [selNotes];
  }
  const prev = snapshotEdit();
  const nb = noteBounds(selNotes), clock = laneClock(lane);
  const group = (lane.refBoxes || (lane.refBoxes = {}))[ref] = {
    rt0: 0, rt1: nb.t1 - nb.t0,
    pLo: nb.pLo, pHi: nb.pHi,
    anchors: occ.map((notes) => noteBounds(notes).t0),
  };
  setBeatShape(group, 0, clock.beatAt(nb.t1) - clock.beatAt(nb.t0), clock);
  commit(prev);
  refreshCounts(); draw();
  toast(occ.length > 1 ? `Reference #${ref}: ${occ.length} boxes` : `Reference #${ref}: 1 box`);
}

// Detach the selected occurrence(s): drop their box from the group (the notes stay,
// now unlinked). The remaining boxes stay linked — a single-box reference is fine
// (it can be extended later via paste-as-reference). The group is removed only when
// the last box is detached.
export function detachSelection() {
  const targets = new Map();   // group -> { lane, ref, idx:Set }
  for (const n of S.selection) {
    const b = boxOfNote(n);
    if (!b) continue;
    if (!targets.has(b.group)) targets.set(b.group, { lane: b.lane, ref: b.ref, idx: new Set() });
    targets.get(b.group).idx.add(b.i);
  }
  if (!targets.size) { toast("No referenced notes selected"); return; }
  const prev = snapshotEdit();
  let n = 0;
  for (const [group, t] of targets) {
    freezeShape(t.lane, group);
    group.anchors = group.anchors.filter((_, i) => !t.idx.has(i));
    if (group.shifts) group.shifts = group.shifts.filter((_, i) => !t.idx.has(i));
    n += t.idx.size;
    if (!group.anchors.length) delete t.lane.refBoxes[t.ref];   // only drop the group when no boxes remain
  }
  commit(prev); draw();
  toast(`Detached ${n} occurrence(s)`);
}

// Detach a whole reference: every box goes, every note stays (now unlinked).
export function detachRefGroup(lane, ref) {
  const group = lane.refBoxes && lane.refBoxes[ref];
  if (!group || group.locked) return;
  const prev = snapshotEdit();
  delete lane.refBoxes[ref];
  commit(prev); draw();
  toast(`Reference #${ref} detached (${group.anchors.length} occurrence${group.anchors.length === 1 ? "" : "s"})`);
}

// ---- reference-level (occurrence) operations ----
// These treat a reference occurrence as a first-class object: the box and the notes
// inside it move / copy / delete together, instead of routing through note edits
// (which would mirror to siblings or pull notes out of the box).

// Relocate one occurrence (box + its notes) during a label drag. Because the box
// and its notes move together, the box's contents relative to its anchor (and
// shift) are unchanged — so no mirror fires and the siblings stay put. It moves in
// pitch only when the reference allows it; a moved copy loses its fingering, and
// gets it back if it returns to where it was. Snapshot + commit are handled by
// the mousedown/mouseup that bracket the drag.
export function moveRefOccurrence(drag, x, y) {
  const group = drag.lane.refBoxes[drag.ref];
  if (!group || group.locked) return;
  freezeShape(drag.lane, group);
  const clock = laneClock(drag.lane);
  let dt = snap(drag.a0 + (timeAt(x) - drag.grabT)) - drag.a0;
  dt = clamp(dt, projectStart(S.state) - (drag.a0 + group.rt0), S.state.duration - (drag.a0 + group.rt1));   // keep the box in-song
  let dp = 0;
  if (group.transposable) {
    const spec = S.state.spec;
    dp = clamp(Math.round(pitchAt(y) - drag.grabP), spec.midi_low - (group.pLo + drag.s0), spec.midi_high - (group.pHi + drag.s0));
  }
  // Never into another reference: the occurrence waits at its last free spot.
  const s = drag.s0 + dp, a = drag.a0 + dt;
  const box = { ...spanAt(group, a, clock), pLo: group.pLo + s, pHi: group.pHi + s };
  if (box.t0 < projectStart(S.state) - 1e-9) return;
  if (overlapsRefBox(drag.lane, box, { ref: drag.ref, i: drag.i })) return;
  group.anchors[drag.i] = a;
  if (group.transposable) (group.shifts || (group.shifts = []))[drag.i] = s;
  // In beats from the anchor: moved under another tempo, the passage keeps its rhythm.
  const b0 = clock.beatAt(drag.a0), b = clock.beatAt(a);
  for (const o of drag.notes) {
    o.n.start = clock.timeAt(b + clock.beatAt(o.s) - b0); o.n.end = clock.timeAt(b + clock.beatAt(o.e) - b0);
    o.n.pitch = o.p + dp;
    if (dp) dropFingering(o.n);
    else { if (o.pos) o.n.pos = o.pos; if (o.arrangement) o.n.arrangement = o.arrangement; }
  }
  draw();
}

// Lock or free a reference's pitch. Locking while some occurrences sit elsewhere
// asks first: move them back to the earliest occurrence's pitch, or detach them
// (their notes stay where they are). One undo step either way.
export async function setRefPitchLock(lane, ref, lock) {
  const group = lane.refBoxes?.[ref];
  if (!group || group.locked) return;
  const order = group.anchors.map((a, i) => i).sort((p, q) => group.anchors[p] - group.anchors[q]);
  const target = shiftOf(group, order[0]);
  const off = order.filter((i) => shiftOf(group, i) !== target);
  let choice = "confirm";
  if (lock && off.length) {
    choice = await confirmChoice({
      title: "Use the same pitch for all instances?",
      message: `${off.length} occurrence${off.length === 1 ? "" : "s"} of ${refName(group, ref)} ${off.length === 1 ? "sits" : "sit"} at a different pitch than the first. `
        + `Move ${off.length === 1 ? "it" : "them"} back to the first occurrence's pitch, or detach ${off.length === 1 ? "it" : "them"} and keep the notes where they are?`,
      confirmLabel: "Move back",
      alternativeLabel: "Detach",
    });
    if (choice === "cancel") return;
  }
  const prev = snapshotEdit();
  const clock = laneClock(lane);
  freezeShape(lane, group);
  if (!lock) group.transposable = true;
  else {
    if (choice === "alternative") {
      const keep = new Set(group.anchors.map((a, i) => i).filter((i) => !off.includes(i)));
      group.anchors = group.anchors.filter((_, i) => keep.has(i));
    } else for (const i of off) {
      const delta = target - shiftOf(group, i);
      for (const n of notesInBox(boxRect(group, i, clock), lane.notes)) { n.pitch += delta; dropFingering(n); }
    }
    // Every remaining box now sits at the target: fold it into the shared pitch.
    group.pLo += target; group.pHi += target;
    delete group.shifts; delete group.transposable;
  }
  commit(prev); refreshCounts(); draw();
}

// Delete one occurrence: drop its box AND the notes inside it in a single step.
// Removing the anchor is a structural change, so no mirror fires; the group is
// removed when its last box goes.
export function deleteRefOccurrence(occ) {
  const { lane, group, ref, i } = occ;
  if (group.locked) return;
  freezeShape(lane, group);
  const doomed = new Set(notesInBox(boxRect(group, i, laneClock(lane)), lane.notes));
  const prev = snapshotEdit();
  lane.notes = lane.notes.filter((n) => !doomed.has(n));
  group.anchors.splice(i, 1);
  group.shifts?.splice(i, 1);
  if (!group.anchors.length) delete lane.refBoxes[ref];
  S.selection = new Set();
  commit(prev);
  refreshCounts(); draw();
  toast(`Reference #${ref}: occurrence deleted`);
}

// Delete an entire reference group: every box and all the notes inside them.
export function deleteRefGroup(lane, ref) {
  const group = lane.refBoxes && lane.refBoxes[ref];
  if (!group || group.locked) return;
  const doomed = new Set();
  const clock = laneClock(lane);
  for (let i = 0; i < group.anchors.length; i++)
    for (const n of notesInBox(boxRect(group, i, clock), lane.notes)) doomed.add(n);
  const prev = snapshotEdit();
  lane.notes = lane.notes.filter((n) => !doomed.has(n));
  delete lane.refBoxes[ref];
  S.selection = new Set();
  commit(prev);
  refreshCounts(); draw();
  toast(`Reference #${ref} deleted (${doomed.size} note(s))`);
}

// Replay `pattern` (relative to its source anchor) into the box at `anchor`,
// overwriting whatever was there. Reuses existing note objects by order so identity
// (selection / undo) survives where the counts allow.
function mirrorBox(lane, anchor, oldNotes, pattern, shift, srcShift, clock, mintId = nid) {
  const ordered = [...oldNotes].sort(noteOrder), b = clock.beatAt(anchor);
  for (let k = 0; k < pattern.length; k++) {
    const p = pattern[k];
    let nn = ordered[k];
    if (!nn) { nn = { id: mintId() }; lane.notes.push(nn); }
    nn.start = clock.timeAt(b + p.dt); nn.end = clock.timeAt(b + p.dt + p.dur); nn.pitch = p.pitch + shift;
    for (const f of EFFECT_FIELDS) delete nn[f];
    copyEffects(p.src, nn);
    if (shift !== srcShift) dropFingering(nn);
  }
  if (ordered.length > pattern.length) {
    const extra = new Set(ordered.slice(pattern.length));
    lane.notes = lane.notes.filter((n) => !extra.has(n));
  }
}

// Mirror an edit across a group's boxes. Called at the top of commit() with the
// pre-edit snapshot, so the user's change + its mirror commit (and undo) as one.
// The source box is the one whose contents changed vs prev (or `forced` = { ref, i }
// after a resize); its contents are replayed into every other box. A structural
// change (box added/removed) is left to its own handler — never auto-mirrored.
function reconcileRefGroup(lane, ref, group, prevNotes, prevGroup, mirrorSource, mintId = nid) {
  if (group.locked) return;
  const clock = laneClock(lane);
  const contents = group.anchors.map((a, i) => notesInBox(boxRect(group, i, clock), lane.notes));
  let src = mirrorSource && mirrorSource.ref === ref ? mirrorSource.i : -1;
  if (src < 0 && prevGroup && prevGroup.anchors.length === group.anchors.length) {
    for (let i = 0; i < group.anchors.length; i++) {
      // A box whose shift changed was moved, not edited: it is never the source.
      if (shiftOf(group, i) !== shiftOf(prevGroup, i)) continue;
      const before = notesInBox(boxRect(prevGroup, i, clock), prevNotes);
      if (boxSig(contents[i], group.anchors[i], shiftOf(group, i), true, clock) !== boxSig(before, prevGroup.anchors[i], shiftOf(prevGroup, i), true, clock)) { src = i; break; }
    }
  }
  if (src < 0) return;
  const srcShift = shiftOf(group, src);
  const pattern = relPattern(contents[src], group.anchors[src], srcShift, clock);
  for (let j = 0; j < group.anchors.length; j++) {
    if (j === src) continue;
    const shift = shiftOf(group, j), same = shift === srcShift;
    if (boxSig(contents[j], group.anchors[j], shift, same, clock) === boxSig(contents[src], group.anchors[src], srcShift, same, clock)) continue;
    mirrorBox(lane, group.anchors[j], contents[j], pattern, shift, srcShift, clock, mintId);
  }
}

export function reconcileReferences(prev, mirrorSource) {
  eachRefGroup((lane, ref, group) => reconcileRefGroup(lane, ref, group,
    prev.lanes?.[lane.id] || [], prev.boxes?.[lane.id]?.[ref], mirrorSource));
}

// Use the same reference propagation as commit, on detached preview data.
// Preview-only ids must never advance the editor's real note id counter.
export function previewPositionReferences(original, preview) {
  let id = 0;
  for (const [ref, group] of Object.entries(preview.refBoxes || {}))
    reconcileRefGroup(preview, ref, group, original.notes, original.refBoxes?.[ref],
      null, () => `position-preview-${++id}`);
}

// Paint each reference occurrence: a gold capture box plus its name, drawn like a
// motif's. Hovering/selecting any note of a group spotlights all its occurrences;
// the box under the pointer's edge (or being resized) lights up as a whole.
// The shared transposition glyph follows each reference label on the timeline.
const TRANSPOSE_PX = 14;
function drawTranspose(x, y, color) {
  for (const image of [stageIcon("transpose", halo(), 5, draw), stageIcon("transpose", color, 2, draw)])
    if (image.complete) sctx.drawImage(image, x, y - TRANSPOSE_PX, TRANSPOSE_PX, TRANSPOSE_PX);
}

export function drawReferences() {
  S.refBadges = []; S.refBoxRects = []; S.refLocks = [];
  if (!S.state) return;
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth, vy0 = scroll.scrollTop;
  const hotRefs = new Set();   // "laneId:ref" spotlighted by hover / selection
  const mark = (n) => { const b = n && boxOfNote(n); if (b) hotRefs.add(b.lane.id + ":" + b.ref); };
  mark(S.hoverNote); for (const n of S.selection) mark(n);
  const edge = S.drag?.mode === "refBox" ? S.drag : S.refEdgeHover;
  sctx.save();
  sctx.font = stageUi(11, 700); sctx.textAlign = "left"; sctx.textBaseline = "bottom";
  eachRefGroup((lane, ref, group) => {
    if (!lane.visible) return;
    const on = hotRefs.has(lane.id + ":" + ref), clock = laneClock(lane);
    for (let i = 0; i < group.anchors.length; i++) {
      const s = shiftOf(group, i), label = refName(group, ref) + (s ? ` ${s > 0 ? "+" : "−"}${Math.abs(s)}` : "");
      const box = boxRect(group, i, clock);
      const x0 = xOf(box.t0), x1 = xOf(box.t1);
      if (x0 > vx1 || x1 < vx0) continue;   // off-screen
      const y0 = yOf(box.pHi), y1 = yOf(box.pLo) + S.state.rowH;   // y0 = top (high pitch)
      const lit = edge && edge.lane === lane && edge.ref === ref && edge.i === i;
      if (lit) { sctx.fillStyle = hexA(REF_ACCENT, WASH); sctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
      sctx.lineWidth = on || lit ? 2 : 1;
      sctx.strokeStyle = on || lit ? REF_ACCENT : hexA(REF_ACCENT, 0.5);
      sctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      S.refBoxRects.push({ ref, lane, i, x0, y0, x1, y1 });
      // Above the box, as a motif's label: free-floating 11, haloed.
      const lx = Math.max(x0 + 3, vx0 + 3), ly = clamp(y0 - 2, vy0 + 14, vy0 + S.stageHeight - 1);
      const tw = sctx.measureText(label).width;
      sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.strokeText(label, lx, ly);
      sctx.fillStyle = on || lit ? REF_ACCENT : hexA(REF_ACCENT, 0.85); sctx.fillText(label, lx, ly);
      // Transposition sits at the box's right end, above it like the label (never
      // over the label on a narrow box). Its state is said in words only while it
      // is pointed at, or for a moment after it was flipped.
      const color = group.transposable ? REF_ACCENT : PAINT.hint;
      const kx = Math.max(x1 - 2 * TRANSPOSE_PX - 4, lx + tw + 6);
      drawTranspose(kx, ly, color);
      S.refLocks.push({ x: kx - 2, y: ly - TRANSPOSE_PX - 2, w: TRANSPOSE_PX + 4, h: TRANSPOSE_PX + 4, lane, ref, i, kind: "transpose" });
      const editX = kx + TRANSPOSE_PX + 4;
      const editColor = group.locked ? REF_ACCENT : PAINT.hint;
      for (const image of [stageIcon(group.locked ? "lock" : "unlock", halo(), 5, draw), stageIcon(group.locked ? "lock" : "unlock", editColor, 2, draw)])
        if (image.complete) sctx.drawImage(image, editX, ly - TRANSPOSE_PX, TRANSPOSE_PX, TRANSPOSE_PX);
      S.refLocks.push({ x: editX - 2, y: ly - TRANSPOSE_PX - 2, w: TRANSPOSE_PX + 4, h: TRANSPOSE_PX + 4, lane, ref, i, kind: "edit" });
      const hovered = S.refLockHover && S.refLockHover.lane === lane && S.refLockHover.ref === ref && S.refLockHover.i === i;
      const flashed = S.refLockFlash && S.refLockFlash.lane === lane && S.refLockFlash.ref === ref && performance.now() < S.refLockFlash.until;
      if (hovered || flashed) {
        const words = hovered && S.refLockHover.kind === "edit"
          ? (group.locked ? "Reference locked" : "Lock reference")
          : (group.transposable ? "Transposable" : "Same pitch");
        sctx.save(); sctx.font = stageUi(11, 400); sctx.textAlign = "right";
        const wx = kx - 4;   // left of the transposition glyph, inside the box's width
        sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.strokeText(words, wx, ly);
        sctx.fillStyle = color; sctx.fillText(words, wx, ly);
        sctx.restore();
      }
      S.refBadges.push({ x: lx - 3, y: ly - 13, w: tw + 6, h: 14, lane, box, ref, i });   // click selects, drag moves, double-click renames
    }
  });
  sctx.restore();
}

// The transposition toggle under a world-space point, or null.
export function refLockAt(x, y) {
  return S.refLocks?.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
}

// Flip a reference's pitch lock (locking may ask first; see setRefPitchLock),
// then show its new transposition state beside the glyph for a moment.
const LOCK_FLASH_MS = 1500;
export async function toggleRefPitchLock(lane, ref) {
  const group = lane.refBoxes?.[ref];
  if (!group) return;
  await setRefPitchLock(lane, ref, !!group.transposable);
  S.refLockFlash = { lane, ref, until: performance.now() + LOCK_FLASH_MS };
  draw(); setTimeout(draw, LOCK_FLASH_MS + 20);
}

// The reference label under a world-space point, or null. (badge.box = rect)
export function refBadgeAt(x, y) {
  for (const b of S.refBadges)
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
  return null;
}

// A reference box edge or corner under a world-space point: { ref, lane, i, edge }
// where edge holds "t"/"b" (pitch) and/or "l"/"r" (time), e.g. "tl"; or null.
export function refBoxEdgeAt(x, y) {
  const T = REF_BOX_EDGE_TOL;
  for (const b of S.refBoxRects) {
    if (x < b.x0 - T || x > b.x1 + T || y < b.y0 - T || y > b.y1 + T) continue;
    const e = (Math.abs(y - b.y0) <= T ? "t" : Math.abs(y - b.y1) <= T ? "b" : "")
            + (Math.abs(x - b.x0) <= T ? "l" : Math.abs(x - b.x1) <= T ? "r" : "");
    if (e) return { ref: b.ref, lane: b.lane, i: b.i, edge: e };
  }
  return null;
}

// The resize cursor for an edge from refBoxEdgeAt.
export const refEdgeCursor = (edge) => edge.length === 2
  ? (edge === "tl" || edge === "br" ? "nwse-resize" : "nesw-resize")
  : (edge === "l" || edge === "r" ? "ew-resize" : "ns-resize");

// Drag a box edge: resize the group's shared shape (so every box resizes), keyed
// off the dragged box's anchor. Mirroring of newly-captured notes happens on
// mouseup (reconcile with the dragged box forced as the source).
export function resizeRefBox(drag, x, y) {
  const group = drag.lane.refBoxes[drag.ref];
  if (!group || group.locked) return;
  const a = group.anchors[drag.i], clock = laneClock(drag.lane);
  let [r0, r1] = beatShape(group, clock);
  const at = clock.beatAt(snap(timeAt(x))) - clock.beatAt(a);
  if (drag.edge.includes("l")) {
    const floor = Math.max(...group.anchors.map(anchor => clock.beatAt(projectStart(S.state)) - clock.beatAt(anchor)));
    r0 = Math.max(floor, Math.min(at, r1 - 1e-3));
  }
  else if (drag.edge.includes("r")) r1 = Math.max(at, r0 + 1e-3);
  setBeatShape(group, r0, r1, clock);
  if (drag.edge.includes("t")) group.pHi = Math.max(Math.round(pitchAt(y)), group.pLo);
  else if (drag.edge.includes("b")) group.pLo = Math.min(Math.round(pitchAt(y)), group.pHi);
  draw();
}

// The reference entry for the NOTE menu: only the action to turn an un-referenced
// selection into a reference. Notes/chords already inside a reference return null
// here — managing an existing reference happens in openRefMenu, off its badge.
export function refMenuEntry(sel) {
  if (sel.some((n) => boxOfNote(n))) return null;   // inside a reference → managed via its badge
  return { label: "Group into reference", kw: "repeat copies linked duplicate", fn: () => markSelectionAsReference() };
}
