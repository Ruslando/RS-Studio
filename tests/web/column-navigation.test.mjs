import assert from 'node:assert/strict';
import { adjacentColumn, legatoColumns } from '../../web/column-navigation.js';

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

for (const placed of [false, true]) {
  const chain = [0, 1, 2, 3, 4].map(start => ({ start, end: start + 1, pitch: 60 + start,
    ...(placed ? { auto: { string: 2, fret: 5 + start } } : {}) }));
  chain[1].slide = chain[2].slide = 'legato';
  const columns = chain.map(note => ({ t0: note.start, notes: [note] }));
  const before = JSON.stringify(columns), units = legatoColumns(columns);
  assert.equal(units.length, 3);
  assert.deepEqual(units[1].notes, chain.slice(1, 4), 'the entire legato chain is one unit');
  for (const time of [1, 1.005, 2.5, 3.9]) {
    const selected = new Set(units[1].notes);
    assert.equal(adjacentColumn(units, time, 1, selected), units[2], 'right skips every landing');
    assert.equal(adjacentColumn(units, time, -1, selected), units[0], 'left skips every landing');
  }
  assert.equal(adjacentColumn(units, 4, -1, new Set([chain[4]])), units[1]);
  assert.equal(JSON.stringify(columns), before, 'navigation does not alter the source columns');
  chain[1].slide = chain[2].slide = 'shift';
  assert.equal(legatoColumns(columns).length, 5, 'picked shift slides remain separate steps');
}
console.log('Column navigation follows the focused chord without repeating it');
