// A marked shape is a held grip, independent of which strings are picked now.
// Positions and finger numbers always come from the same solve as the notes.
import { shapeGroups } from './shapes.js';
import { fretCentre, fretDistance, handAt, handColumns } from './fretboard-core.js';

export function fretboardShapeFrames({notes, voiced, fingers, seats}, columns) {
  const events = new Map(columns.flatMap(column => column.fingers.map(finger => [finger.note, finger])));
  const frames = [];
  for (const [id, members] of shapeGroups(notes)) {
    if (!members.some(note => !note.gripOnly)) continue;
    const start = Math.min(...members.map(note => note.start));
    const last = Math.max(...members.map(note => note.start));
    // Use the export's grip rules: an intervening unrelated note or two frets
    // on one string cannot describe one held hand position.
    if (notes.some(note => !note.gripOnly && note.shapeId !== id && note.start >= start - 1e-6 && note.start <= last + 1e-6)) continue;
    const contacts = new Map();
    let invalid = false;
    for (const note of members) {
      const pos = voiced.get(note);
      if (!pos || pos.string < 0 || pos.fret < 0) { invalid = true; break; }
      const previous = contacts.get(pos.string);
      if (previous && previous.fret !== pos.fret) { invalid = true; break; }
      // Repeated notes share one grip contact. Prefer a real finger assignment
      // over a dead note that intentionally has none.
      if (!previous || (previous.finger < 0 && fingers.get(note) >= 0)) contacts.set(pos.string, {
        ...pos, note, pitch: note.pitch, finger: fingers.get(note) ?? -1,
        start: note.start, dead: !!note.fx?.dead,
      });
    }
    if (invalid || contacts.size < 2) continue;
    const next = Math.min(Infinity, ...notes.filter(note => !note.gripOnly && note.start > last + 1e-6).map(note => note.start));
    const end = Math.min(next, Math.max(...members.map(note => note.end)));
    const seat = members.map(note => seats?.get(note)).find(value => Number.isFinite(value)) ?? null;
    frames.push({id, kind: members[0].shapeKind, start, end, seat, contacts: [...contacts.values()],
      events: members.filter(note => !note.gripOnly).map(note => events.get(note)).filter(Boolean)});
  }
  return frames.sort((a, b) => a.start - b.start);
}

export function shapeHandAt(frames, time, pose, instrument, animate = true) {
  const frame = frames.find(frame => frame.start <= time && time < frame.end);
  if (!frame) return pose;
  // Earlier picked strings can still sustain while a later string is picked.
  const active = new Map();
  for (const event of frame.events) if (event.start <= time && time < (event.soundingEnd ?? event.note.end)) {
    if (!active.has(event.string) || active.get(event.string).start <= event.start) active.set(event.string, event);
  }
  const played = handAt(handColumns([{start: frame.start, end: frame.end, seat: frame.seat,
    fingers: [...active.values()]}], instrument.strings), time, 0, instrument, animate);
  const marks = (played?.marks || []).map(mark => {
    // Retain the existing slide/bend/hammer animation for an active note.
    const current = pose?.marks.find(current => current.note === mark.note && !current.releasing && current.pressed !== false) || mark;
    const contact = frame.contacts.find(contact => contact.string === current.string);
    // Picking a different string must not re-finger the chord as a lone note.
    return !current.dead && contact?.finger >= 0 && current.finger !== contact.finger
      ? {...current, finger: contact.finger} : current;
  });
  const sounding = new Set(marks.map(mark => mark.string));
  for (const contact of frame.contacts) if (!sounding.has(contact.string)) marks.push({
    ...contact, x: fretCentre(contact.fret, instrument), lift: 0, pressed: true,
    shapeHeld: true, opacity: .45,
  });
  const anchor = frame.seat > 0 ? {
    x0: fretDistance(frame.seat + (instrument.capo || 0) - 1, instrument.scale),
    x1: fretDistance(frame.seat + (instrument.capo || 0), instrument.scale), opacity: 1,
  } : played?.anchor ?? pose?.anchor ?? null;
  // The complete grip is one stable drawing. Picked-note marks are a separate
  // animation layer; regrouping the grip by which notes sound splits barres.
  const gripMarks = frame.contacts.map(contact => ({...contact,
    x: fretCentre(contact.fret, instrument), lift: 0, pressed: true, shapeHeld: true, opacity: 1}));
  return {pressed: true, marks, gripMarks, anchor, shapeId: frame.id};
}
