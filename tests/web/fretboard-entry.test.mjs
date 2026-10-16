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

// A different or unknown finger never inherits another finger's position.
for (const finger of [0, 2]) {
  const other = grip(5, 6, 0, 17);
  other.fingers[0].finger = finger;
  const cols = handColumns([grip(0, 5, 5, 2), other]);
  const before = handAt(cols, 4.75, 0.5);
  assert.equal(before.marks.length, 2);
  assert.equal(before.marks[0].x, fretCentre(2), "outgoing finger stays planted");
  assert.equal(before.marks[0].pressed, true);
  const preview = before.marks[1];
  assert.equal(preview.x, fretCentre(17), "upcoming note previews at its target fret");
  assert.equal(preview.string, 0, "preview never travels from the outgoing string");
  assert.equal(preview.opacity, 0.5, "preview fades in ahead of its onset");
  assert.equal(before.pressed, false, "preview is not sounding yet");
  const onset = handAt(cols, 5, 0.5);
  assert.equal(onset.marks[0].x, fretCentre(17), "new finger appears at its destination");
  const tail = onset.marks.find((m) => m.releasing);
  assert.equal(tail.x, fretCentre(2), "outgoing note fades in place");
  assert.equal(tail.opacity, 1);
}

// Silence and the end of the song both release smoothly; paused views stay exact.
const single = handColumns([old]);
let previousOpacity = 1;
for (const t of [1.01, 1.05, 1.09, 1.15, 1.179]) {
  const m = handAt(single, t, 0.5).marks[0];
  assert.equal(m.x, fretCentre(2));
  assert.ok(m.opacity > 0 && m.opacity < previousOpacity);
  previousOpacity = m.opacity;
}
assert.equal(handAt(single, 1.18, 0.5), null);
assert.equal(handAt(single, 1.05, 0), null);

// A chord can move one finger while keeping another in place.
const outgoing = grip(0, 5, 5, 2);
outgoing.fingers.push({ start: 0, string: 3, fret: 4, finger: 2, note: { start: 0, end: 5 } });
const incoming = grip(5, 6, 0, 17);
incoming.fingers.push({ start: 5, string: 2, fret: 19, finger: 3, note: { start: 5, end: 6 } });
const mixed = handAt(handColumns([outgoing, incoming]), 4.75, 0.5);
assert.equal(mixed.marks.length, 3);
assert.equal(mixed.marks.find((m) => m.finger === 2).x, fretCentre(4));
assert.equal(mixed.marks.find((m) => m.finger === 3).x, fretCentre(19));
assert.equal(mixed.marks.find((m) => m.finger === 3).opacity, 0.5);
assert.ok(mixed.marks.find((m) => m.finger === 1).x > fretCentre(2));
console.log("fretboard entry, finger transitions and release OK");

// Disabling animation shows only current authored positions and no technique motion.
const expressive = grip(1, 2, 2, 7);
expressive.fingers[0].note.bend = "full";
expressive.fingers[0].note.fx = { vibrato: true };
expressive.fingers[0].note.slide = "outUp";
const staticCols = handColumns([expressive, grip(2, 3, 4, 12)]);
assert.equal(handAt(staticCols, 0.9, 0.5, undefined, false), null, "no anticipation");
for (const t of [1, 1.5, 1.95]) {
  const pose = handAt(staticCols, t, 0.5, undefined, false);
  assert.equal(pose.pressed, true);
  assert.equal(pose.marks[0].x, fretCentre(7));
  assert.equal(pose.marks[0].string, 2);
  assert.equal(pose.marks[0].lift, undefined);
  assert.equal(pose.marks[0].opacity, undefined);
}
assert.equal(handAt(staticCols, 2, 0.5, undefined, false).marks[0].x, fretCentre(12));
assert.equal(handAt(staticCols, 3.05, 0.5, undefined, false), null, "no animated release tail");
