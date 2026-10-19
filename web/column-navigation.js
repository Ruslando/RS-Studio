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
