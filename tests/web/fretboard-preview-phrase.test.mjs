import assert from 'node:assert/strict';
import { fretboardPreviewPhrase } from '../../web/fretboard-preview-phrase.js';
const tuning = [64,59,55,50,45,40];
const { columns, duration } = fretboardPreviewPhrase(tuning);
const chords = columns.slice(0,3);
for (const c of columns) for (const f of c.fingers) {
  assert.equal(f.start, f.note.start, 'string attacks share the written onset');
  assert.equal(f.soundingEnd, f.note.end);
}
assert.equal(new Set(chords.map(c => c.shape)).size,3);
assert.deepEqual(chords.map(c => c.fingers.length), [6,5,4]);
const intervals = chords.map(c => c.fingers.map(f => f.fret - c.seat).join(','));
assert.equal(new Set(intervals).size, 3, 'three distinct grips, not transpositions');
const run = columns.slice(3);
assert.ok(run.every(c => c.fingers.length === 1));
const pitches = run.map(c => c.fingers[0].pitch);
const apex = pitches.indexOf(Math.max(...pitches));
assert.ok(apex > 3 && apex < pitches.length - 4);
assert.ok(pitches.slice(0,apex+1).every((p,i,a) => !i || p > a[i-1]), 'ascending');
assert.ok(pitches.slice(apex).every((p,i,a) => !i || p < a[i-1]), 'descending');
assert.ok(pitches.every(p => [7,9,11,2,4].includes(p%12)), 'G major pentatonic');
assert.equal(pitches[0], pitches.at(-1));
assert.ok(duration > columns.at(-1).end);
for (const capo of [0,2,7,12]) for (const column of fretboardPreviewPhrase(tuning,capo).columns) {
  assert.ok(Number.isFinite(column.seat));
  assert.ok(column.fingers.every(f => f.fret+capo <= 12));
}
console.log('Preview plays different chords and a major pentatonic run up and down');
