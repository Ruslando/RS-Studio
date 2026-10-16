import assert from 'node:assert/strict';
import { fretDistance, handAt, handColumns } from '../../web/fretboard-core.js';

const grip = (start, end, seat, fret = seat, extra = {}) => ({ start, end, seat,
  fingers: [{ start, string: 3, fret, finger: 1, note: { start, end, ...extra } }] });
const columns = handColumns([grip(0, 1, 2), grip(1, 2, 8)]);
const bounds = seat => [fretDistance(seat - 1), fretDistance(seat)];
const [left0, right0] = bounds(2), [left1, right1] = bounds(8);
let lastLeft = left0;
for (const t of [.5, .6, .7, .8, .9, 1]) {
  const anchor = handAt(columns, t, .5).anchor;
  assert.ok(anchor.x0 >= lastLeft && anchor.x0 <= left1);
  assert.ok(anchor.x1 >= right0 && anchor.x1 <= right1);
  assert.ok(anchor.x1 > anchor.x0);
  lastLeft = anchor.x0;
}
const middle = handAt(columns, .75, .5).anchor;
assert.ok(Math.abs(middle.x0 - (left0 + left1) / 2) < 1e-8);
assert.ok(Math.abs(middle.x1 - (right0 + right1) / 2) < 1e-8);
assert.equal(handAt(columns, .75, 0).anchor.x0, left0, 'paused view has no anticipation');
assert.equal(handAt(columns, .75, .5, undefined, false).anchor.x0, left0, 'animation toggle disables anchor motion too');
assert.equal(handAt(columns, 1, .5).anchor.x0, left1, 'band lands exactly at onset');

const sameShape = handColumns([grip(0, 1, 2, 5), grip(1, 2, 4, 5)]);
assert.ok(handAt(sameShape, .75, .5).anchor.x0 > left0, 'a hand shift also animates when the fretted notes do not change');
const silent = handColumns([grip(0, 1, 2), grip(5, 6, 8)]);
assert.equal(handAt(silent, 3, .5), null);
assert.equal(handAt(silent, 4.75, .5).anchor.opacity, .5, 'after a rest the anchor fades with the new hand');

const slide = handColumns([grip(0, 1, 2, 2, { slide: 'shift' }), grip(1, 2, 4)]);
const slideAnchor = handAt(slide, .95, .5).anchor;
assert.ok(slideAnchor.x0 > left0 && slideAnchor.x0 < fretDistance(3), 'the anchor follows the sliding hand');
console.log('hand-anchor animation: shifts, repeats, slides, silence and static mode passed');
