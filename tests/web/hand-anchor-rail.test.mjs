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

// Implicit anchors: a slide's landing holds like a saved anchor until the next saved one.
{
  const { applyHandAnchors, chordColumns, handAnchorsInForce } = await import('../../web/voicing-core.js');
  const BASS = [28, 33, 38, 43];
  const seatsOf = (notes, holds) => {
    const found = { voiced: new Map(), fingers: new Map(), seats: new Map() };
    applyHandAnchors(notes, found, BASS, holds);
    return { seats: notes.map(n => found.seats.get(n)), anchors: found.handAnchors };
  };
  const tail = () => [{ id: 'b', start: 1, end: 2, pos: { string: 0, fret: 11 } },
    { id: 'c', start: 2, end: 3 }, { id: 'd', start: 3, end: 4 }];

  // Slide-out: 4 slides up 5 frets to 9.
  const out = [{ id: 'a', start: 0, end: 1, slide: 'outUp', slideFrets: 5, pos: { string: 0, fret: 4 } }, ...tail()];
  const holds = [{ id: 'h0', t: 0, fret: 4 }, { id: 'h1', t: 3, fret: 2 }];
  const got = seatsOf(out, holds);
  assert.deepEqual(got.seats, [4, 9, 9, 2]);
  assert.deepEqual(got.anchors.map(({ t, fret, implicit }) => [t, fret, !!implicit]),
    [[0, 4, false], [1, 9, true], [3, 2, false]], 'the landing is an anchor in force, marked implicit');
  assert.deepEqual(handAnchorsInForce(chordColumns(out), holds), got.anchors, 'one answer for every reader');

  // Shift slide: the hand moves by the frets the finger travels (4 -> 11 is +7).
  const shift = [{ id: 'a', start: 0, end: 1, slide: 'shift', pos: { string: 0, fret: 4 } }, ...tail()];
  assert.deepEqual(seatsOf(shift, holds).seats, [4, 11, 11, 2]);

  // A saved anchor on the landing column wins.
  assert.deepEqual(seatsOf(out, [{ id: 'h0', t: 0, fret: 4 }, { id: 'h1', t: 1, fret: 7 }]).seats, [4, 7, 7, 7]);

  // Pick slides move the picking hand, not the fretting hand.
  out[0].slide = 'pickUp';
  assert.deepEqual(seatsOf(out, [{ id: 'h0', t: 0, fret: 4 }]).seats, [4, 4, 4, 4]);
}

// Overriding a landing: the user's 4 right after a 4->9 slide-out repeats the saved
// fret but not the hand in force, so saving it must keep it (and keep it on later notes).
{
  const { changedHandAnchor } = await import('../../web/hand-anchor-state.js');
  const notes = [{ id: 'a', start: 0, end: 1, slide: 'outUp', slideFrets: 5, pos: { string: 0, fret: 4 } },
    { id: 'b', start: 1, end: 2, pos: { string: 0, fret: 6 } }, { id: 'c', start: 2, end: 3 }];
  const holds = [{ id: 'h0', t: 0, fret: 4 }];
  for (const t of [1, 2])
    assert.deepEqual(changedHandAnchor(notes, holds, t, 4, 'x').map(h => [h.t, h.fret]), [[0, 4], [t, 4]]);
  // Repeating the landing itself is still redundant.
  assert.deepEqual(changedHandAnchor(notes, holds, 1, 9, 'x').map(h => [h.t, h.fret]), [[0, 4]]);
}
