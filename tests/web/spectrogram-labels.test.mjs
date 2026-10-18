import assert from 'node:assert/strict';
import { edgeSlide, migrateNoteAppearanceSettings, resolveNoteAppearance, sourceLabelPositions, spectrogramLabel } from '../../web/spectrogram-labels.js';
import { addedArrangementNotes } from '../../web/voicing-core.js';

const note = { pitch: 64 }, pos = { string: 1, fret: 5 };
assert.equal(spectrogramLabel(note, pos), 'E4 S2:F5');
assert.equal(spectrogramLabel(note, pos, 'positions'), 'S2:F5');
assert.equal(spectrogramLabel(note, pos, 'notes'), 'E4');
assert.equal(spectrogramLabel(note, pos, 'none'), '');
assert.equal(spectrogramLabel(note, pos, 'none', ['PM']), 'PM');
assert.equal(spectrogramLabel(note, null), 'E4', 'does not invent a position while computing');
assert.equal(spectrogramLabel(note, { string: 0, fret: 0 }, 'positions'), 'S1:F0');
assert.equal(spectrogramLabel(note, pos, 'both', ['PM'], 2), 'E4 S2:F7 PM');
assert.equal(spectrogramLabel(note, { string: undefined, fret: NaN }), 'E4', 'invalid positions do not render NaN');

const chord = [
  { start: 1, end: 2, pitch: 64, arrangement: { notes: [{ pitch: 64, string: 0, fret: 0 }] } },
  { start: 1, end: 2, pitch: 64 },
  { start: 1, end: 2, pitch: 60 },
];
const played = { start: 1, end: 2, pitch: 64, arranged: true };
const mapped = sourceLabelPositions(chord, [played], new Map([[played, pos]]));
assert.equal(mapped.get(chord[0]), pos);
assert.equal(mapped.has(chord[1]), false, 'does not label an omitted duplicate');
assert.equal(mapped.has(chord[2]), false, 'does not invent positions for omitted pitches');
const added = addedArrangementNotes([{ start: 1, end: 2, pitch: 60,
  arrangement: { notes: [{ pitch: 64, string: 1, fret: 5 }] } }]);
assert.equal(spectrogramLabel(added[0], added[0].pos, 'positions'), 'S2:F5', 'added arrangement notes have position labels too');
assert.equal(spectrogramLabel(added[0], added[0].pos, 'none'), '', 'None hides added arrangement labels');
console.log('Spectrogram label tests passed');

for (const notes of ['off', 'always', 'hover']) for (const positions of ['off', 'always', 'hover']) for (const effects of ['off', 'always', 'hover']) {
  for (const hovered of [false, true]) {
    const resolved = resolveNoteAppearance({ notes, positions, effects }, hovered);
    const label = spectrogramLabel(note, pos, resolved.mode, resolved.effects ? ['PM'] : []);
    assert.equal(label.includes('E4'), notes === 'always' || notes === 'hover' && hovered);
    assert.equal(label.includes('S2:F5'), positions === 'always' || positions === 'hover' && hovered);
    assert.equal(label.includes('PM'), effects === 'always' || effects === 'hover' && hovered);
  }
}
assert.deepEqual(edgeSlide('inBelow'), { glyph: '↗', side: 'left' });
assert.deepEqual(edgeSlide('inAbove'), { glyph: '↘', side: 'left' });
assert.deepEqual(edgeSlide('outDown'), { glyph: '↘', side: 'right' });
assert.deepEqual(edgeSlide('outUp'), { glyph: '↗', side: 'right' });
assert.equal(edgeSlide('shift'), null);
const migrated = migrateNoteAppearanceSettings({ spectrogramLabels: 'notes', spectrogramEffects: false, spectrogramFretNumbering: 'nut' });
assert.equal(migrated.spectrogramNoteNames, 'always');
assert.equal(migrated.spectrogramPositions, 'off');
assert.equal(migrated.spectrogramEffects, 'off');
assert.equal(migrated.fretNumbering, 'nut');
assert.ok(!('spectrogramLabels' in migrated) && !('spectrogramFretNumbering' in migrated));
assert.equal(migrateNoteAppearanceSettings({ spectrogramPositions: 'hover', fretNumbering: 'capo', spectrogramFretNumbering: 'nut' }).fretNumbering, 'capo');
assert.equal(migrateNoteAppearanceSettings({ spectrogramPositions: 'hover' }).spectrogramPositions, 'hover');
assert.equal(migrateNoteAppearanceSettings(null).spectrogramNoteNames, 'always');
