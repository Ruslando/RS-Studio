import { chordColumns, slideLanding, voiceNotesFingered } from './voicing-core.js';
import { slideInOf, edgeSlideSpan, slideEndOf } from './bend.js';

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

// Slide-in travel is displayed on the anchor rail without becoming a saved change.
// Landings of other slides are implicit anchors (handAnchorsInForce), not travel.
export function slideHandChanges(notes, seats, voiced = new Map(), eighthAt = () => .25) {
  const events = [];
  for (const column of chordColumns(notes)) {
    if (column.notes.length !== 1) continue;
    const note = column.notes[0], seat = seats.get(note);
    if (!Number.isFinite(seat)) continue;
    const kind = slideInOf(note), pos = voiced.get(note) || note.pos;
    const offset = kind && pos ? edgeSlideSpan(note, pos.fret, kind) : 0;
    if (!offset) continue;
    const id = note.id || note.start;
    events.push({ id: `slide_${id}_start`, t: note.start, fret: Math.max(1, seat + offset) });
    events.push({
      id: `slide_${id}_end`,
      t: note.start + (note.end - note.start) * slideEndOf(note, note.end - note.start, eighthAt(note.start)),
      fret: seat,
    });
  }
  return events;
}

// A slide that leaves its note (slide-out, shift or legato slide) takes the hand
// from the note's hand at its start to where the slide lands, at the note's end.
// The landing is marked `ends`: the rail draws it ending there, pointing left, so
// the next note's own hand can start right after it.
export function slideOutHandChanges(notes, seats, voiced = new Map()) {
  const columns = chordColumns(notes), events = [];
  columns.forEach((column, i) => {
    if (column.notes.length !== 1) return;
    const note = column.notes[0], seat = seats.get(note);
    if (!Number.isFinite(seat)) return;
    const land = slideLanding(note, columns[i + 1], seat, n => voiced.get(n) || n.pos);
    if (land == null) return;
    const id = note.id || note.start;
    events.push({ id: `slide_${id}_from`, t: note.start, fret: seat },
      { id: `slide_${id}_to`, t: note.end, fret: land, ends: true });
  });
  return events;
}

// Only where the hand moves: { t, fret } at the first note on a new seat. Notes
// without a seat (open strings) keep the hand where it was.
export function seatChanges(notes, seats, voiced = new Map(), eighthAt = () => .25) {
  const events = [];
  for (const column of chordColumns(notes)) {
    const note = column.notes.find(n => Number.isFinite(seats.get(n)));
    if (!note) continue;
    const seat = seats.get(note);
    const slideEvents = column.notes.length === 1
      ? slideHandChanges(column.notes, seats, voiced, eighthAt).map(({ t, fret }) => ({ t, fret })) : [];
    events.push(...(slideEvents.length ? slideEvents : [{ t: note.start, fret: seat }]));
  }
  events.sort((a, b) => a.t - b.t);
  const out = [];
  let last = null;
  for (const event of events) {
    if (event.fret === last) continue;
    last = event.fret; out.push(event);
  }
  return out;
}
