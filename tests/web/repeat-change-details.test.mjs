import assert from 'node:assert/strict';
import { curveGraph, curveSummary, instanceChangeRows, noteChangeRows, techniqueChangeRows } from '../../web/repeat-change-details.js';
assert.deepEqual(techniqueChangeRows({ fx: { palmMute: true } }, { fx: { vibrato: true } }), [
  { key: 'fx.palmMute', label: 'Palm mute', before: 'On', after: 'Off' },
  { key: 'fx.vibrato', label: 'Vibrato', before: 'Off', after: 'On' },
  { key: 'vibratoStart', label: 'Vibrato starts', before: 'Off', after: '0% of note' },
  { key: 'vibratoEnd', label: 'Vibrato ends', before: 'Off', after: '100% of note' },
]);
assert.deepEqual(techniqueChangeRows({ slide: 'shift', slideStart: .25 }, { slide: 'legato', slideStart: .5 }), [
  { key: 'slide', label: 'Slide', before: 'Shift slide', after: 'Legato slide' },
  { key: 'slideStart', label: 'Slide starts', before: '25% of note', after: '50% of note' },
]);
assert.deepEqual(techniqueChangeRows({ bend: 'half', bendPoints: [[0, 0], [1, 1]] }, { bend: 'full', bendPoints: [[0, 0], [.5, 2], [1, 0]] }), [
  { key: 'bend', label: 'Bend', before: 'Half step', after: 'Whole step' },
  { key: 'bendPoints', label: 'Bend curve', before: '1 st bend', after: '2 st bend', curves: { before: [[0, 0], [1, 1]], after: [[0, 0], [.5, 2], [1, 0]] } },
]);
assert.deepEqual(techniqueChangeRows({}, { fx: { palmMute: false } }), []);
assert.deepEqual(techniqueChangeRows({ fx: { hammer: 'origin' } }, { fx: { hammer: 'dest' } }), [
  { key: 'fx.hammer', label: 'Hammer-on / pull-off', before: 'Start of hammer-on / pull-off', after: 'End of hammer-on / pull-off' },
]);
const a = { id: 'a', pitch: 40, start: 0, end: 1, pos: { string: 5, fret: 0 } };
const b = { id: 'b', pitch: 41, start: 10, end: 12, pos: { string: 4, fret: 3 } };
const original = structuredClone([a, b]);
assert.deepEqual(noteChangeRows(a, b, { firstBeat: 1, currentBeat: 1.125, fingers: new Map([['a', 0], ['b', 3]]) }), [
  { key: 'pitch', label: 'Pitch', before: 'E2', after: 'F2' }, { key: 'length', label: 'Length', before: '1 beat', after: '2 beats' },
  { key: 'onset', label: 'Onset in passage', before: '1 beat', after: '1.13 beats' },
  { key: 'finger', label: 'Finger', before: 'Thumb', after: '3' },
]);
assert.deepEqual(noteChangeRows(a, null), [{ key: 'presence', label: 'Note', before: 'E2', after: 'Missing' }]);
assert.deepEqual(noteChangeRows(null, b), [{ key: 'presence', label: 'Note', before: 'Not present', after: 'F2' }]);
assert.deepEqual([a, b], original, 'formatting hover details never changes notes');
console.log('Exact, named repeat change descriptions passed');

const shallow = [[0, 0], [.58, -1], [1, 0]], deep = [[0, 0], [.68, -2], [1, 0]];
assert.equal(curveSummary(shallow), '1 st dip');
assert.equal(curveSummary(deep), '2 st dip');
const graphA = curveGraph(shallow, -2, 0), graphB = curveGraph(deep, -2, 0);
assert.equal(graphA.baseline, graphB.baseline);
assert.notEqual(graphA.path, graphB.path, 'before and after curves share a scale and show different depths and timing');
assert.equal(curveSummary([[0, -2], [1, -2]]), '-2 st held');
const whammy = techniqueChangeRows({ whammy: 'dip', whammyPoints: shallow }, { whammy: 'dip', whammyPoints: deep });
assert.equal(whammy[0].before, '1 st dip'); assert.equal(whammy[0].after, '2 st dip');
assert.deepEqual(whammy[0].curves, { before: shallow, after: deep }, 'all original points remain available for the graphs');
assert.ok(whammy[0].before.length < 15 && whammy[0].after.length < 15, 'curve captions stay compact');

assert.deepEqual(noteChangeRows(null, null), [], 'two absent counterparts have no remaining difference');

assert.equal(noteChangeRows(a, b).some(row => row.key === 'position'), false, 'different pitches do not offer a position comparison');
assert.equal(noteChangeRows(a, { ...b, pitch: a.pitch }).some(row => row.key === 'position'), true, 'matching pitches can still compare strings and frets');

const slideInstances = [0, 1].map(i => ({ note: { ...a, id: `slide${i}`, start: i * 10, end: i * 10 + 1,
  pos: { string: 3, fret: 8 }, slide: 'inBelow', slideEnd: i ? .7 : .3 }, onset: 0 }));
const slideRows = instanceChangeRows(slideInstances[0], slideInstances[1]);
assert.deepEqual(slideRows.map(row => row.key), ['slideCurve'], 'slide details are consolidated into one curve');
assert.deepEqual(slideRows[0].curves.after, [[0, -4], [.7, 0], [1, 0]]);
const bendRows = instanceChangeRows({ note: { ...a, bend: 'half', bendPoints: [[0, 0], [1, 1]] } }, { note: { ...a, bend: 'full', bendPoints: [[0, 0], [1, 2]] } });
assert.deepEqual(bendRows.map(row => row.key), ['bendPoints'], 'bend kind text is omitted beside its curve');
const anchored = instanceChangeRows({ note: { ...a, finger: 4 }, handAnchor: 5 }, { note: { ...a, finger: 3 }, handAnchor: 6 });
assert.deepEqual(anchored.map(row => [row.key, row.before, row.after]), [['finger', '4', '3'], ['handAnchor', 'F5', 'F6']]);
assert.deepEqual(instanceChangeRows({ note: a, handAnchor: 5 }, { note: null }).map(row => row.key), ['presence'], 'a missing note is one row');
assert.deepEqual(instanceChangeRows({ note: a, handAnchor: 5 }, { note: { ...a }, handAnchor: 5 }), [], 'identical instances have no rows');
console.log('Two-instance comparison rows passed');
