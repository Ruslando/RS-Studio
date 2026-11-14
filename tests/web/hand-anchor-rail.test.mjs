import assert from 'node:assert/strict';
import { seatChanges } from '../../web/hand-anchor-core.js';

// The rail flags every seat change, automatic or chosen; open strings keep the hand.
const notes = [0, 1, 2, 3, 4].map(t => ({ start: t }));
const seats = new Map([[notes[0], 5], [notes[1], 5], [notes[3], 7], [notes[4], 5]]);
assert.deepEqual(seatChanges(notes, seats), [{ t: 0, fret: 5 }, { t: 3, fret: 7 }, { t: 4, fret: 5 }]);

// A slide-in's solved seat belongs to its landing, not its earlier start.
for (const [slide, fret, seat, startSeat] of [
  ['inBelow', 9, 9, 5], ['inAbove', 5, 5, 9], ['inBelow', 9, 7, 3],
]) {
  const n = { start: 1, end: 3, slide, slideFrets: 4 };
  const positions = new Map([[n, { string: 0, fret }]]);
  assert.deepEqual(seatChanges([n], new Map([[n, seat]]), positions),
    [{ t: 1, fret: startSeat }, { t: 1.25, fret: seat }]);
  assert.deepEqual(seatChanges([n], new Map([[n, seat]]), positions, () => .5),
    [{ t: 1, fret: startSeat }, { t: 1.5, fret: seat }]);
  n.slideEnd = .4;
  assert.deepEqual(seatChanges([n], new Map([[n, seat]]), positions),
    [{ t: 1, fret: startSeat }, { t: 1.8, fret: seat }]);
}
