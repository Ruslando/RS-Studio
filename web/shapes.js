// Explicit fretting-hand shapes. Notes keep independent start/end times; a
// shared shapeId says they are performed while one multi-string grip is held.
// This is deliberately separate from onset chords and linked reference boxes.

import {
  columnShapeChoices, handProfileForTuning, hasPlayableFingering,
} from "./voicing-core.js";

const validShapeId = (value) => typeof value === "string" && /^shape_\d+$/.test(value);

// Only groups with at least two surviving notes are real shapes. Ignoring
// singletons makes partially deleted/legacy data harmless until cleanup runs.
export function shapeGroups(notes) {
  const groups = new Map();
  for (const note of notes || []) {
    if (!validShapeId(note?.shapeId)) continue;
    if (!groups.has(note.shapeId)) groups.set(note.shapeId, []);
    groups.get(note.shapeId).push(note);
  }
  for (const [id, members] of groups) if (members.length < 2) groups.delete(id);
  return groups;
}

export function shapeMembers(notes, shapeId) {
  return shapeGroups(notes).get(shapeId) || [];
}

export function ungroupShape(notes, shapeId) {
  if (!shapeId) return 0;
  let removed = 0;
  for (const note of notes || []) if (note.shapeId === shapeId) {
    delete note.shapeId; delete note.shapeSource; removed++;
  }
  return removed;
}

// Remove meaningless one-note remnants after deletion, regrouping, or load.
export function cleanupShapeMembership(notes) {
  const counts = new Map();
  for (const note of notes || []) if (validShapeId(note?.shapeId))
    counts.set(note.shapeId, (counts.get(note.shapeId) || 0) + 1);
  let removed = 0;
  for (const note of notes || []) if (note.shapeId && (counts.get(note.shapeId) || 0) < 2) {
    delete note.shapeId; delete note.shapeSource; removed++;
  }
  return removed;
}

function coherentPinnedShape(notes, tuning) {
  const byString = new Map(), out = new Map();
  for (const note of notes) {
    const string = Number(note.pos?.string), fret = Number(note.pos?.fret);
    if (!Number.isInteger(string) || string < 0 || string >= tuning.length ||
        !Number.isInteger(fret) || fret < 0 || tuning[string] + fret !== note.pitch) return null;
    const prior = byString.get(string);
    if (prior && prior.fret !== fret) return null;
    if (!prior) byString.set(string, { note, fret });
    out.set(note, { string, fret });
  }
  if (byString.size < 2) return null;
  const representative = new Map([...byString].map(([string, value]) =>
    [value.note, { string, fret: value.fret }]));
  return hasPlayableFingering(representative, handProfileForTuning(tuning)) ? out : null;
}

function automaticShape(notes, tuning) {
  const representatives = [], byPitch = new Map();
  for (const note of notes) if (!byPitch.has(note.pitch)) {
    byPitch.set(note.pitch, note); representatives.push(note);
  }
  if (representatives.length < 2 || representatives.length > tuning.length) return null;
  const choice = columnShapeChoices(representatives, tuning, 1)[0];
  if (!choice || choice.size !== representatives.length) return null;
  const positionByPitch = new Map(representatives.map((note) => [note.pitch, choice.get(note)]));
  const out = new Map();
  for (const note of notes) {
    const pos = positionByPitch.get(note.pitch);
    if (!pos) return null;
    out.set(note, { string: pos.string, fret: pos.fret });
  }
  return out;
}

// Preserve a coherent authored/manual grip when one exists. Created automatic
// layers otherwise receive one jointly optimized shape for all distinct pitches.
export function chooseShapePositions(notes, tuning, { allowAutomatic = true } = {}) {
  return coherentPinnedShape(notes, tuning) ||
    (allowAutomatic ? automaticShape(notes, tuning) : null);
}
