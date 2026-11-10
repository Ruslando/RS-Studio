import { holdsWithoutColumn } from './hand-anchor-core.js';

// Ask the normal worker for a fresh placement of this column only. Every other
// note keeps its saved position; the preview never writes to the live lane.
export function suggestionLane(lane, columnNotes) {
  const indices = columnNotes.map(note => lane.notes.indexOf(note));
  const notes = structuredClone(lane.notes);
  for (const index of indices) {
    if (index < 0) return null;
    for (const field of ['pos', 'finger', 'arrangement']) delete notes[index][field];
  }
  const time = Math.min(...columnNotes.map(note => note.start));
  return { ...lane, notes,
    handHolds: structuredClone(holdsWithoutColumn(lane.notes, time, lane.handHolds)),
    refBoxes: structuredClone(lane.refBoxes || {}) };
}

export function suggestionDiffers(current, suggested) {
  if (!current || !suggested || current.marks.length !== suggested.marks.length) return false;
  const signature = marks => marks.map(mark => `${mark.pitch}:${mark.string}:${mark.fret}`).sort().join('|');
  return (current.seat || 0) !== (suggested.seat || 0) || signature(current.marks) !== signature(suggested.marks);
}
