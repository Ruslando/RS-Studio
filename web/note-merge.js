// A repeated detection can vary the release time without finding a new attack.
export function uniqueDetectedNotes(existing, detected, tolerance = 1e-4) {
  const attacks = new Map();
  for (const note of existing) {
    if (!attacks.has(note.pitch)) attacks.set(note.pitch, []);
    attacks.get(note.pitch).push(note.start);
  }
  return detected.filter(note => {
    const starts = attacks.get(note.pitch) || [];
    if (starts.some(start => Math.abs(start - note.start) <= tolerance)) return false;
    starts.push(note.start); attacks.set(note.pitch, starts);
    return true;
  });
}

// Recompute from the gesture's original neighbours on every move, so dragging
// back restores their full length. Selected notes and locked references win.
export function makeResizeRoom(notes, resized, originals, edge, minDuration, locked = () => false) {
  const selected = new Set(resized);
  for (const note of notes) {
    if (selected.has(note) || locked(note)) continue;
    const original = originals.get(note);
    if (!original) continue;
    note.start = original.start; note.end = original.end;
    for (const edited of resized) {
      if (edited.pitch !== note.pitch) continue;
      const before = originals.get(edited);
      if (edge === 'r' && original.start >= before.end - 1e-5 && edited.end > original.start)
        note.start = Math.min(original.end, Math.max(note.start, edited.end));
      if (edge === 'l' && original.end <= before.start + 1e-5 && edited.start < original.end)
        note.end = Math.max(original.start, Math.min(note.end, edited.start));
    }
  }
  return notes.filter(note => {
    const original = originals.get(note);
    const changed = original && (note.start !== original.start || note.end !== original.end);
    return !changed || selected.has(note) || locked(note) || note.end - note.start >= minDuration - 1e-5;
  });
}
