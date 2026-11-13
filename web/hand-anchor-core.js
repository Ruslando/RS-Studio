import { chordColumns, voiceNotesFingered } from './voicing-core.js';

// Auto means the answer without any anchor belonging to this column. Keep the
// rest of the song's anchors, tuning and note-position overrides intact.
export function holdsWithoutColumn(notes, time, holds = []) {
  const columns = chordColumns(notes);
  const index = columns.findIndex(column => column.t0 >= Number(time) - 1e-6);
  if (index < 0) return holds;
  const column = columns[index], after = index ? columns[index - 1].t0 : -Infinity;
  return holds.filter(hold =>
    !(Number(hold.t) > after + 1e-6 && Number(hold.t) <= column.t0 + 1e-6));
}

export function automaticHandSeat(notes, tuning, time, options = {}) {
  const column = chordColumns(notes).find(column => column.t0 >= Number(time) - 1e-6);
  if (!column) return null;
  const holds = holdsWithoutColumn(notes, time, options.holds);
  const result = voiceNotesFingered(notes, tuning, Infinity, { ...options, holds });
  return column.notes.map(note => result.seats.get(note)).find(seat => seat != null) ?? null;
}

// Of several holds on one column the engine obeys the earliest (holdsByColumn);
// the others change nothing and only shadow a later edit. Keep the one obeyed.
// `holds` in time order.
export function obeyedHolds(notes, holds) {
  const starts = chordColumns(notes).map(column => column.t0), seen = new Set();
  return holds.filter(hold => {
    const i = starts.findIndex(t0 => t0 >= Number(hold.t) - 1e-6);
    if (i < 0) return true;
    if (seen.has(i)) return false;
    seen.add(i); return true;
  });
}
