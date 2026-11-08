import { slideTargets } from './bend.js';

// Follow the focused column while its notes are sounding. A media seek can settle
// a few milliseconds after the requested onset; time alone would revisit it on ←.
export function adjacentColumn(columns, time, direction, selection) {
  const focused = columns.filter(column => column.notes.some(note => selection.has(note)));
  if (focused.length === 1) {
    const current = focused[0], index = columns.indexOf(current);
    const end = Math.min(Math.max(...current.notes.map(note => note.end)), columns[index + 1]?.t0 ?? Infinity);
    if (time >= current.t0 - .02 && time < end)
      return columns[index + direction] ?? null;
  }
  const boundary = time + direction * 1e-3;
  return (direction < 0 ? [...columns].reverse() : columns)
    .find(column => direction < 0 ? column.t0 < boundary : column.t0 > boundary) ?? null;
}
// A legato landing continues the same picked gesture. Keep its onset columns
// together for navigation without changing the actual notes or their timing.
export function legatoColumns(columns) {
  const notes = columns.flatMap(column => column.notes);
  const columnOf = new Map(columns.flatMap((column, i) => column.notes.map(note => [note, i])));
  const joined = new Set();
  for (const [source, target] of slideTargets(notes, note => note.pos || note.auto)) {
    if (source.slide !== 'legato') continue;
    const from = columnOf.get(source), to = columnOf.get(target);
    for (let i = from; i < to; i++) joined.add(i);
  }
  const units = [];
  for (let i = 0; i < columns.length; i++) {
    if (i && joined.has(i - 1)) {
      const previous = units.pop();
      units.push({ t0: previous.t0, notes: [...previous.notes, ...columns[i].notes] });
    } else units.push(columns[i]);
  }
  return units;
}
