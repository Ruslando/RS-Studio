import assert from 'node:assert/strict';
import { laneIssues } from '../../web/note-issues.js';

// One list, each problem tagged error or warning.
const BASS = [43, 38, 33, 28];
const note = (start, end, pitch, more = {}) => ({ id: `n${start}${pitch}`, start, end, pitch, ...more });
const kinds = (notes) => laneIssues({ notes }, BASS, 20).map((i) => [i.kind, i.tone]);

assert.deepEqual(kinds([note(0, 1, 33, { fx: { dead: true } }), note(1, 2, 44)]), [], 'playable notes are fine');
assert.deepEqual(kinds([note(0, 1, 20)]), [['outOfRange', 'warning']], 'said once, not also as a shape');
assert.deepEqual(kinds([note(0, 1, 40), note(0.5, 1.5, 40)]), [['stack', 'warning']]);
assert.deepEqual(kinds([note(0, 1, 40), note(1, 2, 40)]), [], 'touching notes are not a stack');
assert.deepEqual(kinds([note(0, 1, 40, { bend: 'full', bendPoints: [[0, 0], [0.5, 1], [0.5, 2]] })]), [['bendStack', 'warning']]);
// Five notes at once on four strings: no shape plays them.
assert.deepEqual(kinds([28, 33, 38, 43, 48].map((p) => note(0, 1, p))), [['shape', 'warning']]);
const [bend] = laneIssues({ notes: [note(2, 4, 40, { bend: 'full', bendPoints: [[0, 0], [0.5, 1], [0.5, 2]] })] }, BASS, 20);
assert.equal(bend.time, 3, 'a bend stack sits at its points, not the note start');
// What the Rocksmith chart leaves out is a warning at the note; what it imitates is not.
assert.deepEqual(kinds([note(0, 1, 33, { fx: { ghost: true, staccato: true, letRing: true } })]),
  [['ghost', 'warning'], ['staccato', 'warning'], ['letRing', 'warning']]);
assert.deepEqual(kinds([note(0, 1, 33, { stroke: 'down' }), note(0, 1, 40, { stroke: 'down' })]), [], 'one per chord');
assert.deepEqual(kinds([note(0, 1, 33, { whammy: 'dip', trill: 'half', grace: 'half' })]), [['trill', 'note'], ['grace', 'note'], ['whammy', 'note']]);
// Positions stay where they are set, so what no longer fits them is said, with why.
// BASS strings: 0 G2 (43), 1 D2 (38), 2 A1 (33), 3 E1 (28).
assert.deepEqual(kinds([note(0, 1, 38, { pos: { string: 1, fret: 0 }, fx: { vibrato: true } })]), [['position', 'warning']],
  'an open string under vibrato, said once (not also as a chord)');
assert.deepEqual(kinds([note(0, 1, 33, { pos: { string: 2, fret: 0 }, slide: 'shift' }), note(1, 2, 45, { pos: { string: 0, fret: 2 } })]
  .map((n, i) => i ? n : { ...n, pos: { string: 2, fret: 0 } })), [['position', 'warning']], 'a slide, said once');
const shape = (more) => ({ shapeId: 's', shapeKind: 'arpeggio', ...more });
const [grip] = laneIssues({ notes: [note(0, 1, 33, shape({ pos: { string: 2, fret: 0 } })), note(1, 2, 36, shape({ pos: { string: 2, fret: 3 } }))] }, BASS, 20);
assert.equal(grip.kind, 'shapeGrip');
assert.match(grip.help, /both on the A string/);
assert.deepEqual(kinds([note(0, 1, 33, shape({ pos: { string: 2, fret: 0 } })), note(1, 2, 38, shape({ pos: { string: 1, fret: 0 } }))]), [], 'one grip: fine');
console.log('note issues passed');
