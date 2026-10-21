// Pure reference fingerprints. Repeat discovery ignores downstream fingering;
// reconciliation includes it so manual choices mirror across existing boxes.

import { EFFECT_FIELDS } from "./note-effects.js";

function arrangementSignature(arrangement) {
  const notes = Array.isArray(arrangement?.notes)
    ? arrangement.notes.map((note) => ({
      pitch: note.pitch,
      string: note.string,
      fret: note.fret,
    })).sort((a, b) =>
      (a.pitch - b.pitch) || (a.string - b.string) || (a.fret - b.fret))
    : [];
  return JSON.stringify({
    follow: arrangement?.follow,
    notes,
  });
}

// IS THIS NOTE IN THAT BOX? One rule, because two readers ask it: the mirror, which
// decides what an edit propagates to, and the fingering pass, which decides what has to
// be played the same way. Two copies of "inside" would eventually disagree about a note
// on an edge, and then an edit would mirror to a note the fingering left alone.
//
// `minIn` is how deep a note has to sit before it counts — the editor passes one grid
// cell, the smallest a note may be — so a note merely grazing the edge stays out.
export const inRefBox = (note, box, minIn) =>
  Math.min(note.end, box.t1) - Math.max(note.start, box.t0) >= minIn - 1e-6 &&
  note.pitch >= box.pLo && note.pitch <= box.pHi;

// Each occurrence of a group, slot-ordered, out of whatever note array the caller is
// working on — the lane's own, or the arranged copy the voicer actually sees. Pure: the
// box geometry and nothing of the editor's state.
export function refOccurrences(group, notes, minIn, clock = null) {
  if (!group || !Array.isArray(group.anchors) || typeof group.rt0 !== "number") return [];
  return group.anchors.map((anchor, i) => notes
    .filter((n) => inRefBox(n, occurrenceBox(group, i, clock), minIn))
    .sort((a, b) => (a.start - b.start) || (a.pitch - b.pitch)));
}

// An occurrence may sit some semitones off the group's pitch when the reference
// allows it (group.transposable); group.shifts runs parallel to group.anchors and
// may be absent or sparse (a missing entry is 0).
export const shiftOf = (group, i) => group?.shifts?.[i] || 0;

// A group's time shape in beats from its anchor: [rb0, rb1]. Stored as rb0/rb1;
// a group from before beats were stored reads its seconds (rt0/rt1) at its first
// occurrence's tempo. rt0/rt1 stay written, measured at the first occurrence, so
// older readers still find a box.
export function beatShape(group, clock) {
  if (Number.isFinite(group.rb0) && Number.isFinite(group.rb1)) return [group.rb0, group.rb1];
  const a = group.anchors[0], b = clock.beatAt(a);
  return [clock.beatAt(a + group.rt0) - b, clock.beatAt(a + group.rt1) - b];
}

// The time span a box anchored at `anchor` covers. With a clock (a beatClock of
// the layer's timing) the shape is laid out in beats, so the box stretches with
// the tempo it sits under; without one, in the stored seconds.
export function spanAt(group, anchor, clock = null) {
  if (!clock) return { t0: anchor + group.rt0, t1: anchor + group.rt1 };
  const [r0, r1] = beatShape(group, clock), b = clock.beatAt(anchor);
  return { t0: clock.timeAt(b + r0), t1: clock.timeAt(b + r1) };
}

// Occurrence i's box, unclamped: its anchor's span at its own pitch.
export function occurrenceBox(group, i, clock = null) {
  const s = shiftOf(group, i);
  return { ...spanAt(group, group.anchors[i], clock), pLo: group.pLo + s, pHi: group.pHi + s };
}

export function effectSig(note, { includePos = false } = {}) {
  let signature = "";
  for (const key of EFFECT_FIELDS) {
    if ((!includePos && (key === "pos" || key === "arrangement"))
      || note[key] == null) continue;
    let value = note[key];
    if (key === "fx") value = JSON.stringify(value);
    else if (key === "pos") value = JSON.stringify({
      string: value.string,
      fret: value.fret,
      scope: value.scope || "local",
      follow: value.follow,
    });
    else if (key === "arrangement") value = arrangementSignature(value);
    signature += key + ":" + value + ";";
  }
  return signature;
}
