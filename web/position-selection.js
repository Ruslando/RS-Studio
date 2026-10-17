import { noteName } from "./util.js";
import { chordColumns, placementLimits, shapeFault, writeColumnOverride } from './voicing-core.js';

const pitchKey = notes => notes.map(n => n.pitch).sort((a, b) => a - b).join(',');
const ordered = notes => [...notes].sort((a, b) => a.pitch - b.pitch);

// Batch edits contain either standalone single notes or complete chords.
// Chord voices cannot be treated as standalone notes in this mode.
export function positionSelection(lane, selection) {
  const selected = [...selection].filter(n => Number.isFinite(n.pitch));
  const columns = lane ? chordColumns(lane.notes) : [];
  const targets = columns.filter(c => c.notes.some(n => selection.has(n)));
  const voices = targets.map(c => c.notes.filter(n => selection.has(n)));
  const multiple = targets.length > 1 || selected.some(n => !lane?.notes.includes(n));
  if (!multiple) return { multiple: false, columns: targets, voices, error: null };
  const kind = targets.every(c => c.notes.length === 1) ? 'note' : 'chord';
  const mixed = targets.some(c => c.notes.length === 1) && targets.some(c => c.notes.length > 1);
  let error = null;
  if (selected.some(n => !lane?.notes.includes(n))) error = 'Select notes in one layer';
  else if (mixed) error = 'Select only single notes or only chords';
  else if (targets.some(c => c.notes.some(n => !selection.has(n)))) error = 'Select all notes in each chord';
  else if (voices.some(notes => pitchKey(notes) !== pitchKey(voices[0])))
    error = kind === 'note' ? 'Select notes with the same pitch' : 'Select chords with the same notes';
  return { multiple: true, columns: targets, voices, kind, error };
}

// Map a complete exact-pitch grip (including duplicate pitch multiplicity).
export function mapPositionShape(sourceNotes, shape, targetNotes) {
  if (pitchKey(sourceNotes) !== pitchKey(targetNotes)) return null;
  const source = ordered(sourceNotes), target = ordered(targetNotes);
  return new Map(target.map((n, i) => [n, shape.get(source[i])]));
}

// Pure, atomic plan: validate the proposed positions against every occurrence's
// own effects and neighbours before writing anything. Effects are never copied.
export function sharedPositionPlan(lane, selection, sourceNotes, shape, tuning, positionOf, maxFret = 24) {
  const group = positionSelection(lane, selection);
  if (!group.multiple || group.error) return { ...group, changes: [] };
  if (!sourceNotes.some(n => selection.has(n)))
    return { ...group, error: 'Choose a position for the selected notes', changes: [] };
  const changes = [];
  for (const [index, column] of group.columns.entries()) {
    const mapped = mapPositionShape(sourceNotes, shape, group.voices[index]);
    if (!mapped) return { ...group, error: 'This position does not match the selection', changes: [] };
    for (const [note, pos] of mapped) {
      if (!pos) return { ...group, error: `At ${column.t0.toFixed(2)} s: a note has no position yet`, changes: [] };
      if (!Number.isInteger(pos.fret) || pos.fret < 0 || pos.fret > maxFret)
        return { ...group, error: `At ${column.t0.toFixed(2)} s: that position is outside this fretboard`, changes: [] };
      changes.push({ note, pos: { string: pos.string, fret: pos.fret, scope: 'local',
        influencePrevious: false, influenceNext: false, adaptPrevious: false, adaptNext: false } });
    }
  }
  const proposed = new Map(changes.map(({ note, pos }) => [note, pos]));
  const originalOf = new Map();
  const notes = lane.notes.map(note => {
    const copy = proposed.has(note) ? { ...note, pos: proposed.get(note) } : note;
    if (proposed.has(note)) delete copy.arrangement;
    originalOf.set(copy, note);
    return copy;
  });
  const columns = chordColumns(notes);
  const at = note => proposed.get(originalOf.get(note)) || positionOf(originalOf.get(note));
  const selectedColumns = new Set();
  columns.forEach((c, i) => {
    if (c.notes.some(n => proposed.has(originalOf.get(n)))) selectedColumns.add(i);
  });
  const inspect = new Set(selectedColumns);
  // A selected slide destination must also be compatible with the source before
  // it. Automatic following notes may follow the moved source normally.
  for (const i of selectedColumns) if (i > 0) inspect.add(i - 1);
  for (const i of inspect) {
    const column = columns[i];
    const limits = placementLimits(columns, i, tuning, at, maxFret);
    const mapped = new Map(column.notes.flatMap(n => at(n) ? [[n, at(n)]] : []));
    const strings = new Map();
    let collision = null;
    for (const [note, pos] of mapped) {
      const other = strings.get(pos.string);
      if (other) { collision = `${noteName(other.pitch)} and ${noteName(note.pitch)} would use the same string`; break; }
      strings.set(pos.string, note);
    }
    const error = collision || shapeFault(column.notes, tuning, mapped, limits, maxFret);
    if (!error) continue;
    if (!selectedColumns.has(i)) {
      const original = chordColumns(lane.notes);
      const oldLimits = placementLimits(original, i, tuning, positionOf, maxFret);
      const oldShape = new Map(original[i].notes.flatMap(n => positionOf(n) ? [[n, positionOf(n)]] : []));
      if (shapeFault(original[i].notes, tuning, oldShape, oldLimits, maxFret)
        === shapeFault(column.notes, tuning, mapped, limits, maxFret)) continue;
    }
    return { ...group, error: `At ${column.t0.toFixed(2)} s: ${error}`, changes: [] };
  }
  return { ...group, error: null, changes };
}

export function applySharedPositionPlan(plan) {
  if (plan.error || !plan.multiple) return false;
  let changed = false;
  for (const { note, pos } of plan.changes) {
    const same = note.pos && Object.keys(pos).every(key => note.pos[key] === pos[key]);
    if (same && !note.arrangement) continue;
    note.pos = { ...pos };
    delete note.arrangement;
    changed = true;
  }
  return changed;
}

// Also used for reset preview: never clear hand anchors in this local-only mode.
export function resetSharedPositions(lane, selection) {
  const group = positionSelection(lane, selection);
  if (!group.multiple || group.error) return { ...group, changed: false };
  const selected = new Set(group.columns.flatMap(c => c.notes));
  const copies = new Map([...selected].map(n => [n, { ...n }]));
  let notes = lane.notes.map(n => copies.get(n) || n);
  const restored = [];
  let changed = false;
  for (const column of group.columns) {
    changed ||= column.notes.some(n => n.pos || n.arrangement || n.written);
    const result = writeColumnOverride(notes, column.notes.map(n => copies.get(n)), null, {});
    notes = result.notes;
    restored.push(...result.column);
  }
  return { ...group, notes, selection: new Set(restored), changed };
}
