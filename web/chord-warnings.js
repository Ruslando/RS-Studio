import { chordColumns, chordPlayability } from './voicing-core.js';
import { paintMemo } from './paint-memo.js';

// What each kind says, on the fretboard and on the stage's warning mark.
export const SHAPE_WARNINGS = {
  stretch: ["No reasonable shape found", "Only a very wide hand reaches these notes together."],
  impossible: ["No valid shape found", "The notes cannot all be played together with this tuning, fret range and fingering."],
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
    const key = JSON.stringify([tuning, maxFret, column.notes.map(n => [n.pitch, n.pos?.string, n.pos?.fret])]);
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
