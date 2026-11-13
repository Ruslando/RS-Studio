import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareCopy, findRepeats } from '../../web/repeats-core.js';

let id = 0;
const phrase = (start, pitches, offsets = pitches.map((_, i) => i / 2)) => pitches.map((pitch, i) => ({
  id: `phrase${++id}`, pitch, start: start + offsets[i], end: start + offsets[i] + .4,
}));
const pitches = [40, 43, 45, 47, 45, 43, 40, 38];
const starts = group => group.copies.map(copy => copy.notes[0].note.start);

test('long silent gaps separate recurring passages, without splitting sustained notes', () => {
  const a = phrase(0, pitches), b = phrase(20, [51, 53, 54, 58, 54, 53, 51, 49]);
  const c = phrase(40, pitches), d = phrase(60, [51, 53, 54, 58, 54, 53, 51, 49]);
  const found = findRepeats([...a, ...b, ...c, ...d]);
  assert.deepEqual(found.map(starts), [[0, 40], [20, 60]]);
  const offsets = [0, .5, 1, 1.5, 12, 12.5, 13, 13.5];
  const sustainedA = phrase(0, pitches, offsets), sustainedB = phrase(40, pitches, offsets);
  sustainedA[3].end = 12; sustainedB[3].end = 52;
  assert.deepEqual(findRepeats([...sustainedA, ...sustainedB]).map(g => g.copies.map(c => c.notes.length)), [[8, 8]]);
});

test('steady chord hits do not count as phrases; a changing chord progression does', () => {
  const chordHits = start => Array.from({ length: 8 }, (_, i) => phrase(start + i, [40, 44, 47, 52], [0, 0, 0, 0])).flat();
  assert.deepEqual(findRepeats([...chordHits(0), ...chordHits(20)]), []);
  const progression = start => [0, 2, 5, 3].flatMap((shift, i) => phrase(start + i, [40, 44, 47, 52].map(p => p + shift), [0, 0, 0, 0]));
  assert.deepEqual(findRepeats([...progression(0), ...progression(20)]).map(g => g.copies.map(c => c.notes.length)), [[16, 16]]);
});

test('octave variants stay together and still appear as pitch differences in comparison', () => {
  const a = phrase(0, pitches), b = phrase(20, pitches.map((p, i) => p + (i >= 4 ? 12 : 0))), c = phrase(40, pitches);
  const found = findRepeats([...a, ...b, ...c]);
  assert.deepEqual(found.map(starts), [[0, 20, 40]]);
  assert.equal(compareCopy(found[0].copies[0], found[0].copies[1]).changes.filter(c => c.fields.includes('pitch')).length, 4);
  assert.deepEqual(findRepeats([...a, ...phrase(20, pitches.map(p => p + 2))]), [], 'arbitrary key changes are not octave variants');
});

test('a dense ornament does not break a longer phrase at three unmatched attacks', () => {
  const values = Array.from({ length: 32 }, (_, i) => 40 + (i * 7 % 23));
  const a = phrase(0, values), b = phrase(30, values);
  b[8].start += .18; b[8].end += .18;
  b[9].start += .18; b[9].end += .18;
  const extras = phrase(34.05, [80, 81], [0, .2]);
  const found = findRepeats([...a, ...b, ...extras]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].copies.map(c => c.notes.length), [32, 34]);
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kroi-lead-notes.json', import.meta.url)));
const kroi = () => fixture.notes.map(([pitch, start, end], i) => ({ id: `kroi${i}`, pitch, start, end }));
test('Kroi Lead yields its recurring phrase families', () => {
  const notes = kroi(), unchanged = structuredClone(notes), found = findRepeats(notes);
  assert.equal(found.length, 5);
  assert.deepEqual(found.map(g => g.copies.length), [2, 4, 2, 4, 4]);
  const expectedStarts = [[36, 659.95625], [68, 404, 596, 628], [123.5, 459.5],
    [195.875, 227.875, 531.875, 563.875], [308, 324, 340, 356]];
  found.forEach((g, i) => starts(g).forEach((start, j) => assert.ok(Math.abs(start - expectedStarts[i][j]) < 1e-5)));
  assert.deepEqual(found.slice(0, 2).map(g => g.copies.map(c => c.notes.length)), [[26, 26], [25, 25, 25, 25]],
    'the verse riff splits by its fourth bar, which each version plays more than once');
  assert.deepEqual(found[2].copies.map(c => c.notes.length), [15, 15], 'the chord/run fill is separate from the riff across the long rest');
  assert.deepEqual(found[3].copies.map(c => c.notes.length), [26, 26, 26, 26], 'the octave variation keeps its chorus membership');
  assert.deepEqual(found[4].copies.map(c => c.notes.length), [5, 6, 5, 6], 'bridge embellishments stay in their phrase');
  const ids = found.flatMap(g => g.copies.flatMap(c => c.notes.map(e => e.note.id)));
  assert.equal(new Set(ids).size, ids.length, 'phrase instances never share a note');
  for (const group of found) for (const copy of group.copies.slice(1)) {
    const diff = compareCopy(group.copies[0], copy);
    assert.ok(diff.missing.every(e => e.beat >= 0 && e.beat <= copy.notes.at(-1).beat + .125), 'missing notes stay inside common boundaries');
  }
  assert.deepEqual(notes, unchanged, 'discovery only changes group membership');
});

test('phrase grouping is independent of note ordering, absolute pitch and tempo origin', () => {
  const notes = kroi(), original = findRepeats(notes);
  const transformed = notes.toReversed().map(n => ({ ...n, pitch: n.pitch + 5, start: 2 + n.start / 2, end: 2 + n.end / 2 }));
  const membership = groups => groups.map(g => g.copies.map(c => c.notes.map(e => e.note.id)));
  assert.deepEqual(membership(findRepeats(transformed, t => (t - 2) * 2)), membership(original));
});
