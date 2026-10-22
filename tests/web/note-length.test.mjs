import assert from 'node:assert/strict';
import { NoteLengthMemory, lengthInBeats, endAfterBeats } from '../../web/note-length.js';

const grid = [{ t: 0, bpm: 120 }, { t: 4, bpm: 60 }];
const memory = new NoteLengthMemory(), project = {}, anotherProject = {};
assert.equal(memory.end(project, 1, grid), 1.5, 'initial length is a quarter note');
memory.remember(project, { start: 1, end: 2 }, grid);
assert.equal(memory.end(project, 2, grid), 3, 'a half note is reused');
assert.equal(memory.end(project, 5, grid), 7, 'the rhythmic value survives a tempo change');
memory.remember(project, { start: 2, end: 2.125 }, grid);
assert.equal(memory.end(project, 3, grid), 3.125, 'shortening a note updates the next insertion');
assert.equal(memory.end(anotherProject, 1, grid), 1.5, 'another project starts with the default');
memory.remember(project, { start: 0, end: 0 }, grid);
assert.equal(memory.end(project, 3, grid), 3.125, 'invalid durations do not overwrite the remembered value');
assert.equal(lengthInBeats(3.5, 5, grid), 2, 'notes crossing a tempo marker count both tempos');
assert.equal(endAfterBeats(3.5, 2, grid), 5, 'insertion crossing a tempo marker preserves beats');
assert.equal(endAfterBeats(0, 1, []), .5, 'an unset tempo uses 120 BPM');
console.log('note length: remembered rhythm, tempo changes and project isolation passed');
