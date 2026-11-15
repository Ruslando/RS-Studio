// Display ranges only: repeated attacks stay separate notes and export chords.
export function chordNameRanges(chords, notes, maxGap = () => .25) {
  const members = new Set(chords.flatMap(chord => chord.notes));
  const interruptions = notes.filter(note => !members.has(note)).map(note => note.start).sort((a, b) => a - b);
  const ranges = [];
  let current = null, previous = null, cursor = 0;
  for (const chord of chords) {
    let interrupted = false;
    while (cursor < interruptions.length && interruptions[cursor] <= chord.t0 + 1e-6) {
      if (previous && interruptions[cursor] > previous.t0 + 1e-6) interrupted = true;
      cursor++;
    }
    if (!chord.name) { current = null; previous = chord; continue; }
    const end = Math.max(chord.t0, ...chord.notes.map(note => note.end));
    const previousEnd = previous && Math.max(previous.t0, ...previous.notes.map(note => note.end));
    if (current && current.name === chord.name && !interrupted && chord.t0 - previousEnd <= maxGap(chord.t0) + 1e-6) {
      current.chords.push(chord);
      current.notes.push(...chord.notes);
      current.t1 = Math.max(current.t1, end);
    } else {
      current = { ...chord, t1: end, chords: [chord], notes: [...chord.notes] };
      ranges.push(current);
    }
    previous = chord;
  }
  for (let i = 0; i + 1 < ranges.length; i++) ranges[i].t1 = Math.min(ranges[i].t1, ranges[i + 1].t0);
  return ranges;
}

export function fitChordName(name, width, measure) {
  if (width <= 0) return '';
  if (measure(name) <= width) return name;
  if (measure('…') > width) return '';
  const chars = Array.from(name);
  while (chars.length && measure(chars.join('') + '…') > width) chars.pop();
  return chars.join('') + '…';
}

// Keep names anchored to their musical start. Conflicts create another row
// above the notes instead of shifting the name onto a later chord attack.
export function layoutChordName(chord, { left, right, rangeRight = right, y, top }, measure, obstacles) {
  const name = fitChordName(chord.name, right - left - 6, measure);
  const repeated = chord.chords.length > 1;
  if (!name && !repeated) return null;
  const overlaps = (a, b) => a && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let attempts = 0; attempts <= obstacles.length; attempts++) {
    const labelBox = name ? { x: left + 1, y: y - 16, w: measure(name) + 4, h: 14 } : null;
    const rangeBox = repeated ? { x: left, y: y - 2, w: rangeRight - left, h: 5 } : null;
    if ((labelBox || rangeBox).y < top) return null;
    const conflicts = obstacles.filter(obstacle => overlaps(labelBox, obstacle) || overlaps(rangeBox, obstacle));
    if (!conflicts.length) return { name, labelBox, rangeBox, bracketY: y, x: left + 3, y: y - 3 };
    y = Math.min(y - 16, ...conflicts.map(obstacle => obstacle.y - 6));
  }
  return null;
}
