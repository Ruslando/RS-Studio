import { ungroupShape } from './shapes.js';
import { overrideInfluence, writeColumnOverride } from './voicing-core.js';

// Prepare exactly the reset's input for the normal fingering renderer, without
// touching live notes, selection, undo history or saved project state.
export function overrideResetPreview(lane, columnNotes, time) {
  // A live lane also carries DOM/audio caches. Clone only the musical collections
  // that reset or reference alignment can change, retaining read-only metadata.
  const copy = { ...lane, notes: structuredClone(lane.notes),
    handHolds: structuredClone(lane.handHolds || []), refBoxes: structuredClone(lane.refBoxes || {}) };
  const column = (columnNotes || []).map(note => copy.notes[lane.notes.indexOf(note)]).filter(Boolean);
  for (const id of new Set(column.map(note => note.shapeId).filter(Boolean))) ungroupShape(copy.notes, id);
  if (column.length) copy.notes = writeColumnOverride(copy.notes, column, null, overrideInfluence(column)).notes;
  if (Number.isFinite(time)) copy.handHolds = (copy.handHolds || []).filter(hold => Math.abs(Number(hold.t) - time) > 1e-6);
  return copy;
}
