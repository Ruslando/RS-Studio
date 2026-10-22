import { chordColumns, voiceNotesFingered } from './voicing-core.js';

// Auto means the answer without any anchor belonging to this column. Keep the
// rest of the song's anchors, tuning and note-position overrides intact.
export function automaticHandSeat(notes, tuning, time, options = {}) {
  const columns = chordColumns(notes);
  const index = columns.findIndex(column => column.t0 >= Number(time) - 1e-6);
  if (index < 0) return null;
  const column = columns[index], after = index ? columns[index - 1].t0 : -Infinity;
  const holds = (options.holds || []).filter(hold =>
    !(Number(hold.t) > after + 1e-6 && Number(hold.t) <= column.t0 + 1e-6));
  const result = voiceNotesFingered(notes, tuning, Infinity, { ...options, holds });
  return column.notes.map(note => result.seats.get(note)).find(seat => seat != null) ?? null;
}
