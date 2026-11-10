import { chordColumns, chordPlayability, needsFret } from './voicing-core.js';
import { paintMemo } from './paint-memo.js';

// What each kind says, on the fretboard and on the stage's warning mark.
export const SHAPE_WARNINGS = {
  stretch: ["Chord needs a large hand stretch", "The editor found a fingering that needs a large hand stretch. Change the string positions or notes if the stretch is too difficult."],
  impossible: ["Chord has no valid fingering", "The editor found no fingering for these notes with the current tuning, fret range, and fixed positions. Change the notes or their string positions."],
};

const laneCache = new WeakMap();
const shapeCache = new Map();

// Both canvases use the same result. Repeated grips share the physical test;
// gesture frames invalidate by their actual timing/pitches as well as revision.
export const chordWarnings = paintMemo(function chordWarnings(lane, tuning, maxFret, revision = 0) {
  if (!lane?.notes?.length) return [];
  const signature = JSON.stringify([revision, tuning, maxFret,
    lane.notes.map(n => [n.id, n.start, n.end, n.pitch, n.pos?.string, n.pos?.fret])]);
  const cached = laneCache.get(lane);
  if (cached?.signature === signature) return cached.warnings;
  // kind: "stretch" (only the widest hands reach it) or "impossible".
  const warnings = chordColumns(lane.notes).flatMap(column => {
    // A technique that needs a fret changes the answer (enumerateShapes), so it is in the key.
    const key = JSON.stringify([tuning, maxFret, column.notes.map(n => [n.pitch, n.pos?.string, n.pos?.fret, needsFret(n)])]);
    if (!shapeCache.has(key)) {
      shapeCache.set(key, chordPlayability(column.notes, tuning, maxFret));
      if (shapeCache.size > 512) shapeCache.delete(shapeCache.keys().next().value);
    }
    const kind = shapeCache.get(key);
    return kind === "ok" ? [] : [{ ...column, kind }];
  });
  laneCache.set(lane, { signature, warnings });
  return warnings;
});
