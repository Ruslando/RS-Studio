import assert from 'node:assert/strict';
import { curveGraph, curveSummary, noteChangeRows, noteCharacteristicRows, noteInstanceRows, techniqueChangeRows } from '../../web/repeat-change-details.js';
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
assert.deepEqual(noteCharacteristicRows(a, { fingers: new Map([['a', 0]]) }), [
  { key: 'pitch', label: 'Pitch', value: 'E2' }, { key: 'length', label: 'Length', value: '1 beat' },
  { key: 'position', label: 'Position', value: 'S6 · F0' }, { key: 'finger', label: 'Finger', value: 'Thumb' },
]);
assert.deepEqual(noteCharacteristicRows(null), [{ key: 'presence', label: 'Note', value: 'Missing' }]);
const active = noteCharacteristicRows({ ...a, fx: { palmMute: true }, whammy: 'dip', whammyPoints: [[0, 0], [.5, -1], [1, 0]] });
assert.ok(active.some(row => row.key === 'fx.palmMute' && row.value === 'On'));
assert.ok(active.some(row => row.key === 'whammyPoints' && row.value === '1 st dip' && row.curve.length === 3));

const occurrences = Array.from({ length: 6 }, (_, i) => ({
  note: { ...a, id: `occ${i}`, start: i * 10, end: i * 10 + (i === 5 ? 2 : 3) }, onset: 4,
}));
const uncommon = (instances, selected, key) => noteInstanceRows(instances, selected).find(row => row.key === key)?.uncommon;
assert.equal(uncommon(occurrences, 5, 'length'), true, 'one shorter length is uncommon');
assert.equal(uncommon(occurrences, 0, 'length'), false, 'the five common lengths are not highlighted');
const tied = occurrences.slice(0, 2).map((item, i) => ({ ...item, note: { ...item.note, end: item.note.start + 2 + i } }));
assert.equal(uncommon(tied, 0, 'length'), false, 'the lower observed middle length is the median');
assert.equal(noteInstanceRows(tied, 1).find(row => row.key === 'length').commonLength, 2);
assert.equal(uncommon(tied, 1, 'length'), true);
const absent = occurrences.map((item, i) => i === 5 ? { note: null, onset: null } : item);
assert.equal(uncommon(absent, 5, 'presence'), true);
assert.equal(uncommon(absent, 0, 'presence'), false);
const curveVersions = occurrences.map((item, i) => ({ ...item, note: { ...item.note, whammy: 'dip',
  whammyPoints: [[0, 0], [i === 5 ? .7 : .5, -1], [1, 0]] } }));
assert.equal(uncommon(curveVersions, 5, 'whammyPoints'), true, 'a curve with different point timing is uncommon even when its depth matches');
assert.equal(uncommon(curveVersions, 0, 'whammyPoints'), false);
curveVersions[5].note.whammyPoints = [[0, 0], [.7, -2], [1, 0]];
assert.equal(uncommon(curveVersions, 5, 'whammyPoints'), true, 'a different dip depth is highlighted');
curveVersions[5].note.whammyPoints = [[0, 0], [.7, -1], [1, 0]];
assert.equal(uncommon(curveVersions, 5, 'whammyPoints'), true, 'matching depth alone does not conceal different points');
assert.equal(noteInstanceRows(curveVersions, 5).find(row => row.key === 'whammyPoints').commonIndex, 0);
assert.equal(noteInstanceRows(curveVersions, 5).find(row => row.key === 'whammyPoints').curveVaries, true);
curveVersions[5].note.whammyPoints = structuredClone(curveVersions[0].note.whammyPoints);
assert.equal(uncommon(curveVersions, 5, 'whammyPoints'), false, 'matching the common points clears the highlight');
const splitLeaders = occurrences.map((item, i) => ({ ...item, note: { ...item.note, end: item.note.start + (i < 2 ? 2 : i < 4 ? 3 : 4 + i) } }));
assert.equal(noteInstanceRows(splitLeaders, 5).find(row => row.key === 'length').uncommon, true);
assert.equal(noteInstanceRows(splitLeaders, 5).find(row => row.key === 'length').commonLength, 3, 'tied modes fall back to the median');
const threeLengths = occurrences.map((item, i) => ({ ...item, note: { ...item.note, end: item.note.start + [2, 2, 3, 3, 4, 4][i] } }));
assert.equal(uncommon(threeLengths, 2, 'length'), false);
assert.equal(noteInstanceRows(threeLengths, 5).find(row => row.key === 'length').commonLength, 3);
const oneMuted = occurrences.map((item, i) => ({ ...item, note: { ...item.note, fx: i === 5 ? { palmMute: true } : {} } }));
assert.equal(uncommon(oneMuted, 5, 'fx.palmMute'), true, 'an uncommon active technique is highlighted');
assert.equal(uncommon(oneMuted, 0, 'fx.palmMute'), false, 'the common disabled value is shown without highlighting');
assert.equal(noteInstanceRows(oneMuted, 0).find(row => row.key === 'fx.palmMute').value, 'Off');
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

const slideInstances = [0, 1, 2].map(i => ({ note: { ...a, id: `slide${i}`, start: i * 10, end: i * 10 + 1,
  pos: { string: 3, fret: 8 }, slide: 'inBelow', slideEnd: i === 2 ? .7 : .3 }, onset: 0 }));
const slideRows = noteInstanceRows(slideInstances, 2);
assert.ok(!slideRows.some(row => ['slide', 'slideStart', 'slideEnd', 'slideFrets'].includes(row.key)), 'slide details are consolidated into a graph');
const slideRow = slideRows.find(row => row.key === 'slideCurve');
assert.deepEqual(slideRow.curve, [[0, -4], [.7, 0], [1, 0]]);
assert.equal(slideRow.uncommon, true); assert.equal(slideRow.commonIndex, 0);
const bendInstances = slideInstances.map((item, i) => ({ note: { ...a, id: `bend${i}`, bend: i === 2 ? 'full' : 'half' }, onset: 0 }));
const bendRows = noteInstanceRows(bendInstances, 2);
assert.ok(!bendRows.some(row => row.key === 'bend'), 'bend kind text is omitted');
assert.ok(bendRows.find(row => row.key === 'bendPoints').curve.length);
assert.equal(bendRows.find(row => row.key === 'bendPoints').commonIndex, 0);

const twoFingers = [{note:{...a,finger:4},onset:0,handAnchor:5},{note:{...b,pitch:a.pitch,finger:3},onset:0,handAnchor:6}];
assert.equal(noteInstanceRows(twoFingers,0).find(row=>row.key==='finger').commonIndex,1);
assert.equal(noteInstanceRows(twoFingers,1).find(row=>row.key==='handAnchor').commonIndex,0);
const fourLengths = [1,1,2,2].map((length,i)=>({note:{...a,start:i*10,end:i*10+length},onset:0}));
assert.equal(noteInstanceRows(fourLengths,3).find(row=>row.key==='length').commonLength,1,'even sets use an existing lower middle length');
const categories = [false,true,false,true].map((enabled,i)=>({note:{...a,id:`category${i}`,fx:{vibrato:enabled}},onset:0}));
assert.equal(noteInstanceRows(categories,0).find(row=>row.key==='fx.vibrato').commonIndex,1,'categorical suggestions follow the middle occurrence in song order');
