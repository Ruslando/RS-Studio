import assert from 'node:assert/strict';
import { chordNameRanges, fitChordName, layoutChordName } from '../../web/chord-name-ranges.js';
import { mockImport } from './mock-import.mjs';

const chord = (t0, name = 'Abm', duration = .2, pitches = [56, 59, 63]) => ({
  t0, name, auto: name, key: pitches.join(','), notes: pitches.map(pitch => ({ start: t0, end: t0 + duration, pitch })),
});
const repeated = [chord(1), chord(1.25), chord(1.5)];
const notes = repeated.flatMap(chord => chord.notes);
const [range] = chordNameRanges(repeated, notes);
assert.equal(range.name, 'Abm');
assert.equal(range.chords.length, 3);
assert.equal(range.notes.length, 9);
assert.equal(range.t0, 1);
assert.equal(range.t1, 1.7);
const changed = [...repeated, chord(1.75, 'E'), chord(2, 'Abm')];
assert.equal(chordNameRanges(changed, changed.flatMap(chord => chord.notes)).length, 3, 'a chord change starts a new range');
const overlapping = [chord(1, 'Abm', 2), chord(2, 'E')];
assert.equal(chordNameRanges(overlapping, overlapping.flatMap(chord => chord.notes))[0].t1, 2,
  'a range ends at the next harmony even when a note sustains across the change');
assert.equal(overlapping[0].notes[0].end, 3, 'the display range does not shorten notes');
const rest = [...repeated, chord(3)];
assert.equal(chordNameRanges(rest, rest.flatMap(chord => chord.notes)).length, 2, 'a long rest splits repeated names');
assert.equal(chordNameRanges(repeated, [...notes, { start: 1.4, end: 1.45, pitch: 65 }]).length, 2,
  'single notes between chord attacks interrupt the range');
const unnamed = [chord(1), chord(1.25, ''), chord(1.5)];
assert.equal(chordNameRanges(unnamed, unnamed.flatMap(chord => chord.notes)).length, 2, 'unnamed harmonies do not merge named ranges');
const voicing = [chord(1), chord(1.25, 'Abm', .2, [68, 71, 75])];
assert.equal(chordNameRanges(voicing, voicing.flatMap(chord => chord.notes)).length, 1, 'the same named harmony shares a range across voicings');
assert.equal(chordNameRanges(repeated, notes, () => .01).length, 3, 'the musical gap threshold is supplied by the tempo');
const measure = text => Array.from(text).length * 6;
assert.equal(fitChordName('Abm', 18, measure), 'Abm');
assert.equal(fitChordName('Ab minor add9', 30, measure), 'Ab m…');
assert.equal(fitChordName('Abm', 4, measure), '', 'tiny ranges retain the bracket instead of overflowing text');
assert.equal(fitChordName('Abm', -1, measure), '');

const geometry = { left: 100, right: 200, y: 100, top: 0 };
const singleton = { name: 'Abm', chords: [repeated[0]] };
const singleLabel = layoutChordName(singleton, geometry, measure, []);
assert.equal(singleLabel.rangeBox, null, 'a single chord has no range bracket');
assert.equal(singleLabel.name, 'Abm');
const repeatedLabel = layoutChordName(range, geometry, measure, []);
assert.ok(repeatedLabel.rangeBox, 'repeated chords retain their range bracket');
const extendedLabel = layoutChordName(range, { ...geometry, right: 260, rangeRight: 200 }, measure, []);
assert.equal(extendedLabel.rangeBox.w, 100, 'a repeated chord frame keeps its musical range when the label may use extra room');
const reference = { x: 100, y: 85, w: 85, h: 14 };
const stacked = layoutChordName(range, geometry, measure, [reference]);
assert.equal(stacked.x, repeatedLabel.x, 'reference conflicts never shift the chord away from its musical start');
assert.ok(stacked.rangeBox.y + stacked.rangeBox.h <= reference.y, 'both the label and bracket move above the reference name');
assert.ok(stacked.labelBox.y + stacked.labelBox.h <= reference.y);
const twiceStacked = layoutChordName(range, geometry, measure, [reference, stacked.labelBox, stacked.rangeBox]);
assert.ok(twiceStacked.bracketY < stacked.bracketY, 'multiple annotation rows stay separate');
assert.equal(layoutChordName(range, { ...geometry, top: 85 }, measure, [reference]), null,
  'annotations cannot escape into the toolbar or marker rails');

const { setChordName } = await mockImport(new URL('../../web/chord-names.js', import.meta.url));
setChordName(chordNameRanges(voicing, voicing.flatMap(chord => chord.notes))[0], 'Custom');
for (const member of voicing) for (const note of member.notes) {
  assert.equal(note.chordName, 'Custom');
  assert.equal(note.chordNameFor, member.key, 'renaming the shared name preserves each voicing identity');
}
console.log('Chord name ranges: repetitions, interruptions, pauses, fitting and shared renaming passed');
