import assert from 'node:assert/strict';
import { slideFingerGroup } from '../../web/voicing-core.js';
const note = (start, string, fret, slide) => ({ start, end: start + 0.5, pitch: 55 + fret,
  pos: { string, fret }, slide });
const a = note(0, 2, 5, 'shift'), b = note(.5, 2, 7, 'legato'), c = note(1, 2, 9);
const other = note(.5, 1, 3), after = note(1.5, 2, 11);
const notes = [after, c, other, a, b];
for (const n of [a, b, c]) assert.deepEqual(new Set(slideFingerGroup(notes, n)), new Set([a, b, c]));
assert.deepEqual(slideFingerGroup(notes, other), [other], 'other strings remain independent');
assert.deepEqual(slideFingerGroup(notes, after), [after], 'a following note without a slide link stays independent');
for (const slide of ['inBelow', 'outUp', 'pickDown', undefined]) {
  a.slide = slide;
  assert.deepEqual(slideFingerGroup([a, b], b), [b], 'only shift and legato connect fingers');
}
a.slide = 'shift';
b.pos.fret = 0;
assert.deepEqual(slideFingerGroup([a, b], b), [b], 'open-string landings have no shared finger');
b.pos.fret = 7;
const positions = new Map([[a, { string: 4, fret: 5 }], [b, { string: 3, fret: 7 }]]);
assert.deepEqual(slideFingerGroup([a, b], b, n => positions.get(n)), [b], 'current voiced positions decide the links');
console.log('Slide finger groups: bidirectional chains, strings, open notes and slide kinds passed');
