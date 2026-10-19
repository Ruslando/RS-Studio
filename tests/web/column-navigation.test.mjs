import assert from 'node:assert/strict';
import { adjacentColumn } from '../../web/column-navigation.js';

const notes = [
  { start: 0, end: .8 }, { start: 1, end: 1.8 },
  { start: 1.005, end: 1.7 }, { start: 2, end: 2.8 },
];
const columns = [{ t0: 0, notes: [notes[0]] }, { t0: 1, notes: [notes[1], notes[2]] }, { t0: 2, notes: [notes[3]] }];
const selected = new Set([notes[1], notes[2]]);
assert.equal(adjacentColumn(columns, 1.005, -1, selected), columns[0], 'seek rounding does not repeat the current chord');
assert.equal(adjacentColumn(columns, 1.005, 1, selected), columns[2]);
assert.equal(adjacentColumn(columns, .998, -1, selected), columns[0], 'rounding before an onset is also tolerated');
assert.equal(adjacentColumn(columns, 1.5, -1, selected), columns[0], 'step from the sounding focused chord');
assert.equal(adjacentColumn(columns, 2.2, -1, selected), columns[2], 'a stale selection does not override a different cursor location');
assert.equal(adjacentColumn(columns, 1.9, -1, selected), columns[1], 'in a rest, previous returns to the preceding onset');
assert.equal(adjacentColumn(columns, .5, 1, new Set()), columns[1]);
assert.equal(adjacentColumn(columns, 0, -1, new Set([notes[0]])), null);
assert.equal(adjacentColumn(columns, 2, 1, new Set([notes[3]])), null);
console.log('Column navigation follows the focused chord without repeating it');
