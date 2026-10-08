// Linked repeated-note groups ("references"): creating a reference from a selection
// and the per-occurrence operations (move, resize, or edit a single instance).

import { STAGE_ANCHORED, stageMono } from "./constants.js";
import { scroll, sctx } from "./dom.js";
import { draw } from "./repaint.js";
import { commit, snapshotEdit } from "./edit.js";
import { pitchAt, timeAt, xOf, yOf } from "./geometry.js";
import { minDur, snap } from "./grid.js";
import { nid } from "./ids.js";
import { editLanes, laneOf, refreshCounts } from "./lanes.js";
import { EFFECT_FIELDS, copyEffects } from "./note-effects.js";
import { toast } from "./notify.js";
import { effectSig, inRefBox } from "./reference-core.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";
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
// Box i spans [anchors[i]+rt0, anchors[i]+rt1] in time (relative to its anchor, so
// one shape mirrors to every box) and [pLo, pHi] in pitch (absolute — occurrences
// share pitch, no transposition).
export const REF_TIME_TOL = 0.03;   // s — timing slack when matching repeats

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
function boxRect(group, i) {
  const a = group.anchors[i];
  return {
    t0: Math.max(0, a + group.rt0), t1: Math.min(S.state.duration, a + group.rt1),
    pLo: Math.max(S.state.spec.midi_low, group.pLo), pHi: Math.min(S.state.spec.midi_high, group.pHi),
  };
}

// Notes from `arr` that sit inside `box`: pitch within range, and at least one
// full cell (the smallest a note may be) of the note lies inside the box's time
// span — a note merely grazing the edge has to be pushed a cell deep to join.
export function notesInBox(box, arr) {
  const minIn = minDur();
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
    for (let i = 0; i < group.anchors.length; i++)
      if (notesInBox(boxRect(group, i), [note]).length) { hit = { lane: l, ref, group, i }; return; }
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
function relPattern(notes, anchor) {
  return [...notes].sort(noteOrder).map((n) => ({
    dt: n.start - anchor, dur: n.end - n.start, pitch: n.pitch, src: n,
  }));
}

// Position-independent fingerprint of a box's contents (anchored), for spotting
// which box the user just changed.
function boxSig(notes, anchor) {
  return relPattern(notes, anchor)
    .map((p) => `${p.dt.toFixed(3)}|${p.dur.toFixed(3)}|${p.pitch}|${effectSig(p.src, { includePos: true })}`).join("~");
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

// Group the selection into a reference: find its repeats in the lane and drop a
// capture box over each. The boxes (not the notes) hold the link.
function markSelectionAsReference() {
  const sel = [...S.selection].filter((n) => laneOf(n));
  if (!sel.length) { toast("Select notes in an edit lane to group into a reference"); return; }
  const lane = laneOf(sel[0]);
  const selNotes = sel.filter((n) => laneOf(n) === lane);
  if (selNotes.some((n) => boxOfNote(n))) { toast("Selection is already inside a reference"); return; }
  const occ = findRepeats(selNotes, lane);
  if (!occ.length) return;
  const prev = snapshotEdit();
  const ref = nextRef();
  const nb = noteBounds(selNotes);
  (lane.refBoxes || (lane.refBoxes = {}))[ref] = {
    rt0: 0, rt1: nb.t1 - nb.t0,
    pLo: nb.pLo, pHi: nb.pHi,
    anchors: occ.map((notes) => noteBounds(notes).t0),
  };
  commit(prev);
  refreshCounts(); draw();
  toast(occ.length > 1 ? `Reference #${ref}: ${occ.length} boxes` : `Reference #${ref}: boxed (no repeats found)`);
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
    group.anchors = group.anchors.filter((_, i) => !t.idx.has(i));
    n += t.idx.size;
    if (!group.anchors.length) delete t.lane.refBoxes[t.ref];   // only drop the group when no boxes remain
  }
  commit(prev); draw();
  toast(`Detached ${n} occurrence(s)`);
}

// ---- reference-level (occurrence) operations ----
// These treat a reference occurrence as a first-class object: the box and the notes
// inside it move / copy / delete together, instead of routing through note edits
// (which would mirror to siblings or pull notes out of the box).

// Relocate one occurrence (box + its notes) by a single time delta during a badge
// drag. Because the box and its notes shift together, the box's contents relative
// to its anchor are unchanged — so no mirror fires and the siblings stay put. Pitch
// is locked (occurrences share pitch by design). Snapshot + commit are handled by
// the mousedown/mouseup that bracket the drag.
export function moveRefOccurrence(drag, x) {
  const group = drag.lane.refBoxes[drag.ref];
  if (!group) return;
  let dt = snap(drag.a0 + (timeAt(x) - drag.grabT)) - drag.a0;
  dt = clamp(dt, -(drag.a0 + group.rt0), S.state.duration - (drag.a0 + group.rt1));   // keep the box in-song
  group.anchors[drag.i] = drag.a0 + dt;
  for (const o of drag.notes) { o.n.start = o.s + dt; o.n.end = o.e + dt; }
  draw();
}

// Delete one occurrence: drop its box AND the notes inside it in a single step.
// Removing the anchor is a structural change, so no mirror fires; the group is
// removed when its last box goes.
export function deleteRefOccurrence(occ) {
  const { lane, group, ref, i } = occ;
  const doomed = new Set(notesInBox(boxRect(group, i), lane.notes));
  const prev = snapshotEdit();
  lane.notes = lane.notes.filter((n) => !doomed.has(n));
  group.anchors.splice(i, 1);
  if (!group.anchors.length) delete lane.refBoxes[ref];
  S.selection = new Set();
  commit(prev);
  refreshCounts(); draw();
  toast(`Reference #${ref}: occurrence deleted`);
}

// Delete an entire reference group: every box and all the notes inside them.
export function deleteRefGroup(lane, ref) {
  const group = lane.refBoxes && lane.refBoxes[ref];
  if (!group) return;
  const doomed = new Set();
  for (let i = 0; i < group.anchors.length; i++)
    for (const n of notesInBox(boxRect(group, i), lane.notes)) doomed.add(n);
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
function mirrorBox(lane, anchor, oldNotes, pattern) {
  const ordered = [...oldNotes].sort(noteOrder);
  for (let k = 0; k < pattern.length; k++) {
    const p = pattern[k];
    let nn = ordered[k];
    if (!nn) { nn = { id: nid() }; lane.notes.push(nn); }
    nn.start = anchor + p.dt; nn.end = nn.start + p.dur; nn.pitch = p.pitch;
    for (const f of EFFECT_FIELDS) delete nn[f];
    copyEffects(p.src, nn);
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
export function reconcileReferences(prev, mirrorSource) {
  eachRefGroup((lane, ref, group) => {
    const prevNotes = (prev.lanes && prev.lanes[lane.id]) || [];
    const prevGroup = prev.boxes && prev.boxes[lane.id] && prev.boxes[lane.id][ref];
    const contents = group.anchors.map((a, i) => notesInBox(boxRect(group, i), lane.notes));
    let src = mirrorSource && mirrorSource.ref === ref ? mirrorSource.i : -1;
    if (src < 0 && prevGroup && prevGroup.anchors.length === group.anchors.length) {
      for (let i = 0; i < group.anchors.length; i++) {
        const before = notesInBox(boxRect(prevGroup, i), prevNotes);
        if (boxSig(contents[i], group.anchors[i]) !== boxSig(before, prevGroup.anchors[i])) { src = i; break; }
      }
    }
    if (src < 0) return;
    const pattern = relPattern(contents[src], group.anchors[src]);
    const srcSig = boxSig(contents[src], group.anchors[src]);
    for (let j = 0; j < group.anchors.length; j++) {
      if (j === src || boxSig(contents[j], group.anchors[j]) === srcSig) continue;
      mirrorBox(lane, group.anchors[j], contents[j], pattern);
    }
  });
}

// Paint each reference occurrence: a gold capture box (resizable in time + pitch)
// plus a number badge. Hovering/selecting any note of a group spotlights — and
// shows resize handles on — all of its occurrences.
export function drawReferences() {
  S.refBadges = []; S.refBoxRects = [];
  if (!S.state) return;
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth, vy0 = scroll.scrollTop;
  const hotRefs = new Set();   // "laneId:ref" spotlighted by hover / selection
  const mark = (n) => { const b = n && boxOfNote(n); if (b) hotRefs.add(b.lane.id + ":" + b.ref); };
  mark(S.hoverNote); for (const n of S.selection) mark(n);
  sctx.save();
  // "R3" is an identifier you match against the other occurrences, so mono; the
  // badge is 12px tall and pinned to its box, so the anchored 9.
  sctx.font = stageMono(STAGE_ANCHORED); sctx.textAlign = "left"; sctx.textBaseline = "alphabetic";
  eachRefGroup((lane, ref, group) => {
    if (!lane.visible) return;
    const on = hotRefs.has(lane.id + ":" + ref);
    for (let i = 0; i < group.anchors.length; i++) {
      const box = boxRect(group, i);
      const x0 = xOf(box.t0), x1 = xOf(box.t1);
      if (x0 > vx1 || x1 < vx0) continue;   // off-screen
      const y0 = yOf(box.pHi), y1 = yOf(box.pLo) + S.state.rowH;   // y0 = top (high pitch)
      sctx.lineWidth = on ? 2 : 1;
      sctx.strokeStyle = on ? REF_ACCENT : hexA(REF_ACCENT, 0.5);
      sctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      S.refBoxRects.push({ ref, lane, i, x0, y0, x1, y1 });
      if (on) {                                     // edge grab-handles when spotlighted
        sctx.fillStyle = REF_ACCENT;
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        for (const [hx, hy] of [[x0, my], [x1, my], [mx, y0], [mx, y1]]) sctx.fillRect(hx - 2, hy - 2, 4, 4);
      }
      const label = "R" + ref, tw = sctx.measureText(label).width, bw = tw + 6;
      const ly = clamp(y0 - 14, vy0 + 1, vy0 + S.stageHeight - 13);
      sctx.fillStyle = on ? REF_ACCENT : hexA(REF_ACCENT, 0.8);
      sctx.fillRect(x0, ly, bw, 12);
      sctx.fillStyle = PAINT.ground; sctx.fillText(label, x0 + 3, ly + 9);
      S.refBadges.push({ x: x0, y: ly, w: bw, h: 12, lane, box, ref, i });   // click selects, drag moves the occurrence
    }
  });
  sctx.restore();
}

// The reference number badge under a world-space point, or null. (badge.box = rect)
export function refBadgeAt(x, y) {
  for (const b of S.refBadges)
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
  return null;
}

// A reference box edge under a world-space point: { ref, lane, i, edge } where edge
// is "l"/"r" (time) or "t"/"b" (pitch), or null.
export function refBoxEdgeAt(x, y) {
  const T = REF_BOX_EDGE_TOL;
  for (const b of S.refBoxRects) {
    const inX = x >= b.x0 - T && x <= b.x1 + T, inY = y >= b.y0 - T && y <= b.y1 + T;
    if (!inX || !inY) continue;
    const e = inY && Math.abs(x - b.x0) <= T ? "l"
            : inY && Math.abs(x - b.x1) <= T ? "r"
            : inX && Math.abs(y - b.y0) <= T ? "t"
            : inX && Math.abs(y - b.y1) <= T ? "b" : null;
    if (e) return { ref: b.ref, lane: b.lane, i: b.i, edge: e };
  }
  return null;
}

// Drag a box edge: resize the group's shared shape (so every box resizes), keyed
// off the dragged box's anchor. Mirroring of newly-captured notes happens on
// mouseup (reconcile with the dragged box forced as the source).
export function resizeRefBox(drag, x, y) {
  const group = drag.lane.refBoxes[drag.ref];
  if (!group) return;
  const a = group.anchors[drag.i];
  if (drag.edge === "l") group.rt0 = Math.min(snap(timeAt(x)) - a, group.rt1 - 1e-3);
  else if (drag.edge === "r") group.rt1 = Math.max(snap(timeAt(x)) - a, group.rt0 + 1e-3);
  else if (drag.edge === "t") group.pHi = Math.max(Math.round(pitchAt(y)), group.pLo);
  else if (drag.edge === "b") group.pLo = Math.min(Math.round(pitchAt(y)), group.pHi);
  draw();
}

// The reference entry for the NOTE menu: only the action to turn an un-referenced
// selection into a reference. Notes/chords already inside a reference return null
// here — managing an existing reference happens in openRefMenu, off its badge.
export function refMenuEntry(sel) {
  if (sel.some((n) => boxOfNote(n))) return null;   // inside a reference → managed via its badge
  // Named like its sibling "Group selection into shape", and for the same reason:
  // "Mark as reference" said what happens to the notes you can see and nothing
  // about the GROUP it creates, which is the whole point — the repeats it finds
  // elsewhere in the lane come along, and an edit to one reaches all of them.
  return { label: "Group selection into reference", kw: "repeat copies linked duplicate", fn: () => markSelectionAsReference() };
}
