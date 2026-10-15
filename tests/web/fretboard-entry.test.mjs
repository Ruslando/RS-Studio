import assert from "node:assert/strict";
import { fretCentre, handAt, handColumns } from "../../web/fretboard-core.js";

const grip = (start, end, string, fret) => ({ start, end,
  fingers: [{ start, string, fret, finger: 1, note: { start, end } }] });
const old = grip(0, 1, 5, 2);
const target = grip(5, 6, 0, 17);
const columns = handColumns([old, target]);
assert.equal(handAt(columns, 3, 0.5), null, "the hand disappears during the rest");
let lastOpacity = -1;
for (const t of [4.5, 4.6, 4.75, 4.9, 4.99]) {
  const { pressed, marks: [m] } = handAt(columns, t, 0.5);
  assert.equal(pressed, false, "preparation is not a sounding note");
  assert.equal(m.x, fretCentre(17), "re-entry stays at the target fret");
  assert.equal(m.string, 0, "re-entry stays on the target string");
  assert.ok(m.opacity >= 0 && m.opacity < 1 && m.opacity > lastOpacity, "smooth fade-in");
  lastOpacity = m.opacity;
}
assert.equal(handAt(columns, 5, 0.5).pressed, true, "fully pressed at the onset");
assert.equal(handAt(columns, 4.75, 0), null, "paused view has no anticipation");

const repeated = handColumns([old, grip(5, 6, 5, 2)]);
assert.equal(handAt(repeated, 4.75, 0.5).marks[0].opacity, 0.5,
  "the same shape also fades back in after silence");
const first = handAt(handColumns([target]), 4.75, 0.5).marks[0];
assert.equal(first.opacity, 0.5, "the first grip fades in too");

const connected = handColumns([grip(0, 5, 5, 2), target]);
const moving = handAt(connected, 4.75, 0.5).marks[0];
assert.ok(moving.x > fretCentre(2) && moving.x < fretCentre(17), "connected grips still travel");
assert.ok(moving.string > 0 && moving.string < 5);
assert.equal(moving.opacity, undefined, "connected shifts retain their opacity");
