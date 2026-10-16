import assert from 'node:assert/strict';
import { uniqueDetectedNotes, makeResizeRoom } from '../../web/note-merge.js';
import { unplayableColumn } from '../../web/voicing-core.js';
import { chordWarnings } from '../../web/chord-warnings.js';
import { readFileSync } from 'node:fs';

const n = (start, end, pitch = 60) => ({ start, end, pitch });
const existing = [n(0, 1)];
assert.deepEqual(uniqueDetectedNotes(existing, [n(0, .8), n(1, 2), n(1, 2), n(0, 1, 61)]), [n(1, 2), n(0, 1, 61)]);
assert.equal(uniqueDetectedNotes(existing, [n(0.00000001, 1)]).length, 0);
assert.equal(existing.length, 1);

const left = n(0, 1), right = n(1, 2), next = n(2, 3), other = n(1, 2, 61), short = n(4, 4.01);
const notes = [left, right, next, other, short];
const originals = new Map(notes.map(note => [note, { ...note }]));
left.end = 1.5;
assert.equal(makeResizeRoom(notes, [left], originals, 'r', .25).length, 5);
assert.deepEqual([right.start, right.end, other.start], [1.5, 2, 1]);
left.end = 2.25;
assert.deepEqual(makeResizeRoom(notes, [left], originals, 'r', .25), [left, next, other, short]);
assert.equal(next.start, 2.25);
left.end = 1;
makeResizeRoom(notes, [left], originals, 'r', .25);
assert.deepEqual([right.start, next.start], [1, 2], 'dragging back restores neighbours');
right.start = .5;
makeResizeRoom(notes, [right], originals, 'l', .25);
assert.equal(left.end, .5, 'left edge makes room symmetrically');

const tuning = [64,59,55,50,45,40];
assert.equal(unplayableColumn([n(0,1,40), n(0,1,41)], tuning), true, 'two notes need the same string');
assert.equal(unplayableColumn([n(0,1,40), n(0,1,92)], tuning), true, 'missing pitches cannot count as a complete shape');
assert.equal(unplayableColumn([n(0,1,86)], tuning, 21), true, 'actual neck length is respected');
assert.equal(unplayableColumn([n(0,1,40), n(0,1,47), n(0,1,52)], tuning), false);
const project = JSON.parse(readFileSync(new URL('../../examples/chord-showcase/project.json', import.meta.url)));
const lane = project.editLanes[0];
const warnings = chordWarnings(lane, tuning, 22);
assert.deepEqual(warnings.filter(c => c.t0 >= 96).map(c => c.t0), [96,100,104,108]);
assert.equal(chordWarnings(lane, tuning, 22), warnings, 'unchanged frames reuse their analysis');
console.log('note merging, resize neighbours and chord warnings passed');
