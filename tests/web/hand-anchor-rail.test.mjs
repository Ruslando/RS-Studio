import assert from 'node:assert/strict';
import { seatChanges, slideHandChanges } from '../../web/hand-anchor-core.js';

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
  assert.deepEqual(slideHandChanges([n], new Map([[n, seat]]), positions),
    [{ id: `slide_${n.id || n.start}_start`, t: 1, fret: startSeat },
      { id: `slide_${n.id || n.start}_end`, t: 1.25, fret: seat }]);
  assert.deepEqual(seatChanges([n], new Map([[n, seat]]), positions, () => .5),
    [{ t: 1, fret: startSeat }, { t: 1.5, fret: seat }]);
  assert.deepEqual(slideHandChanges([n], new Map([[n, seat]]), positions, () => .5).map(({ t, fret }) => [t, fret]),
    [[1, startSeat], [1.5, seat]]);
  n.slideEnd = .4;
  assert.deepEqual(seatChanges([n], new Map([[n, seat]]), positions),
    [{ t: 1, fret: startSeat }, { t: 1.8, fret: seat }]);
}

const slideIn = { id: 'slide-in', start: 4, end: 6, slideIn: 'inBelow', slideFrets: 4, slideEnd: .5 };
assert.deepEqual(slideHandChanges([slideIn], new Map([[slideIn, 6]]),
  new Map([[slideIn, { string: 0, fret: 6 }]])), [
  { id: 'slide_slide-in_start', t: 4, fret: 2 },
  { id: 'slide_slide-in_end', t: 5, fret: 6 },
], 'the rail shows the slide hand at its start and landing without adding saved hand changes');
