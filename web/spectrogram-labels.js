import { noteName } from './util.js';
import { chordColumns } from './voicing-core.js';

export function spectrogramLabelOptions(root = document) {
  return {
    notes: root.getElementById('spectrogramNoteNames')?.value || 'always',
    positions: root.getElementById('spectrogramPositions')?.value || 'always',
    effects: root.getElementById('spectrogramEffects')?.value || 'always',
    fromNut: root.getElementById('fretNumbering')?.value === 'nut',
  };
}

export const labelVisible = (setting, hovered) => setting === 'always' || setting === 'hover' && hovered;

export function migrateNoteAppearanceSettings(store = {}) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) store = {};
  const valid = value => ['off', 'always', 'hover'].includes(value);
  const oldMode = store.spectrogramLabels || 'both';
  if (!valid(store.spectrogramNoteNames)) store.spectrogramNoteNames = ['none', 'positions'].includes(oldMode) ? 'off' : 'always';
  if (!valid(store.spectrogramPositions)) store.spectrogramPositions = ['none', 'notes'].includes(oldMode) ? 'off' : 'always';
  if (!valid(store.spectrogramEffects)) store.spectrogramEffects = store.spectrogramEffects === false ? 'off' : 'always';
  if (!('fretNumbering' in store) && store.spectrogramFretNumbering) store.fretNumbering = store.spectrogramFretNumbering;
  delete store.spectrogramLabels;
  delete store.spectrogramFretNumbering;
  return store;
}

export function resolveNoteAppearance(options, hovered = false) {
  const notes = labelVisible(options.notes, hovered), positions = labelVisible(options.positions, hovered);
  return { mode: notes ? positions ? 'both' : 'notes' : positions ? 'positions' : 'none',
    effects: labelVisible(options.effects, hovered), fromNut: options.fromNut };
}

export function edgeSlide(slide) {
  const glyph = { inBelow: '↗', inAbove: '↘', outDown: '↘', outUp: '↗' }[slide];
  return glyph ? { glyph, side: slide.startsWith('in') ? 'left' : 'right' } : null;
}

// Arranged chords replace source objects for export. Match retained pitches
// back to the editor, consuming duplicates so omitted voices stay unlabelled.
export function sourceLabelPositions(source, performed, voiced) {
  const result = new Map(voiced);
  for (const column of chordColumns(source)) {
    if (!column.notes.some(note => note.arrangement?.notes?.length)) continue;
    const start = Math.min(...column.notes.map(note => note.start));
    const candidates = performed.filter(note => note.arranged && note.start === start);
    for (const note of column.notes) {
      const index = candidates.findIndex(candidate => candidate.pitch === note.pitch);
      if (index < 0) continue;
      const [candidate] = candidates.splice(index, 1);
      const position = voiced.get(candidate);
      if (position) result.set(note, position);
    }
  }
  return result;
}

export function spectrogramLabel(note, position, mode = 'both', tags = [], capo = 0) {
  const parts = [];
  if (mode === 'notes' || mode === 'both') parts.push(noteName(note.pitch));
  if ((mode === 'positions' || mode === 'both') && position &&
      Number.isInteger(position.string) && position.string >= 0 &&
      Number.isFinite(position.fret) && position.fret >= 0)
    parts.push(`S${position.string + 1}:F${position.fret + capo}`);
  return [...parts, ...tags].join(' ');
}
