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
    influencePrevious: arrangement?.influencePrevious,
    influenceNext: arrangement?.influenceNext,
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
export function refOccurrences(group, notes, minIn) {
  if (!group || !Array.isArray(group.anchors) || typeof group.rt0 !== "number") return [];
  return group.anchors.map((anchor) => notes
    .filter((n) => inRefBox(n, {
      t0: anchor + group.rt0, t1: anchor + group.rt1, pLo: group.pLo, pHi: group.pHi,
    }, minIn))
    .sort((a, b) => (a.start - b.start) || (a.pitch - b.pitch)));
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
      influencePrevious: value.influencePrevious,
      influenceNext: value.influenceNext,
    });
    else if (key === "arrangement") value = arrangementSignature(value);
    signature += key + ":" + value + ";";
  }
  return signature;
}
