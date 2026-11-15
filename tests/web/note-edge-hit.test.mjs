import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const lane = { visible: true, notes: [] };
const S = { state: { lanes: [lane] }, selection: new Set() };
const y = pitch => (80.5 - pitch) * 10;
let lockedReference = false;
const { pickNoteEdge } = await mockImport(new URL('../../web/stage-hit-test.js', import.meta.url), {
  './store.js': { S }, './lanes.js': { activeLane: () => lane },
  './geometry.js': { xOf: time => time * 100, pitchAtExact: py => 80.5 - py / 10 },
  './references.js': { boxOfNote: () => lockedReference ? { group: { locked: true } } : null },
  './note-render.js': { noteRibbon: (_lane, note) => note.ribbon },
}, { './constants.js': true, './bend.js': true, './whammy.js': true });

const note = { start: 1, end: 1.5, pitch: 64 };
lane.notes = [note];
assert.equal(pickNoteEdge(152, y(64))?.edge, 'r', 'the tail is reachable from outside the bar');
assert.equal(pickNoteEdge(98, y(64))?.edge, 'l', 'the head is reachable from outside the bar');
assert.equal(pickNoteEdge(157, y(64)), null, 'edge tolerance does not swallow open space');
assert.equal(pickNoteEdge(150, y(66)), null, 'other pitch rows are not edge targets');
note.bend = 'full';
assert.equal(pickNoteEdge(152, y(66))?.note, note, 'bent tails are hit where they are drawn');
assert.equal(pickNoteEdge(152, y(64)), null, 'the original pitch is not a hidden bend target');
note.whammy = 'dip'; note.whammyPoints = [[0, 0], [1, -1]];
assert.equal(pickNoteEdge(152, y(65))?.note, note, 'combined bend and whammy use the drawn pitch');
delete note.bend;
assert.equal(pickNoteEdge(152, y(63))?.note, note, 'whammy-only tails follow their curve');
delete note.whammy; delete note.whammyPoints;
note.ribbon = { end: 2, points: [[0, 0], [1, 4]] };
assert.equal(pickNoteEdge(152, y(66))?.note, note, 'a slide ribbon keeps the actual sustain endpoint reachable');
assert.equal(pickNoteEdge(200, y(68)), null, 'a ribbon continuation is not the sustain endpoint');
delete note.ribbon;
const next = { start: 1.5, end: 2, pitch: 64 };
lane.notes.push(next); S.selection.add(note);
assert.equal(pickNoteEdge(150, y(64))?.note, note, 'selection breaks a tie between touching endpoints');
lane.notes = [note]; note.end = 1.05;
assert.equal(pickNoteEdge(104, y(64))?.edge, 'r', 'short notes choose the nearer endpoint');
lockedReference = true;
assert.equal(pickNoteEdge(104, y(64)), null, 'locked reference notes cannot be resized');
lockedReference = false; lane.locked = true;
assert.equal(pickNoteEdge(104, y(64)), null, 'locked layers cannot be resized');
lane.locked = false; lane.visible = false;
assert.equal(pickNoteEdge(104, y(64)), null, 'hidden layers cannot be resized');
console.log('Note edge hit testing: curves, outside grabs, short notes, touching edges and locks passed');
