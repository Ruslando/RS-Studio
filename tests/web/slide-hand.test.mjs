import test from "node:test";
import assert from "node:assert/strict";
import * as fretboardCore from "../../web/fretboard-core.js";
const { slidLanding } = fretboardCore;

const col = (...fingers) => ({ fingers });

test("a slide landing takes its hand from the slide start", () => {
  const start = col({ string: 3, fret: 4, note: { slide: "legato" } });
  assert.equal(slidLanding(start, col({ string: 3, fret: 8, note: {} })), true);
  assert.equal(slidLanding(start, col({ string: 2, fret: 8, note: {} })), false);   // other string
  assert.equal(slidLanding(col({ string: 3, fret: 4, note: { slide: "outDown" } }), col({ string: 3, fret: 8, note: {} })), false);
  assert.equal(slidLanding(col({ string: 3, fret: 4, note: {} }), col({ string: 3, fret: 8, note: {} })), false);
});

test("a slide-in counts its hand from where the finger goes down", () => {
  const { slideInShift } = fretboardCore;
  assert.equal(slideInShift(col({ string: 3, fret: 8, note: { slide: "inBelow", pos: { fret: 8 } } })), -4);
  assert.equal(slideInShift(col({ string: 3, fret: 8, note: { slide: "inAbove", pos: { fret: 8 } } })), 4);
  assert.equal(slideInShift(col({ string: 3, fret: 8, note: {} })), 0);
  // A chord where only one note slides in keeps its own frets.
  assert.equal(slideInShift(col({ string: 3, fret: 8, note: { slide: "inBelow" } }, { string: 2, fret: 9, note: {} })), 0);
});

test("a slide-in fits whole on its string, a slide-out needs a fret", async () => {
  const { chordColumns, placementLimits, placementFault } = await import("../../web/voicing-core.js");
  const tuning = [64, 59, 55, 50, 45, 40];
  const fault = (slide, pitch, string) => {
    const note = { start: 0, end: 1, pitch, slide };
    const limits = placementLimits(chordColumns([note]), 0, tuning, () => null);
    return placementFault(limits.get(note), pitch, string, tuning);
  };
  assert.match(fault("inBelow", 63, 1), /does not fit/);   // D#4 on B fret 4 would start on open B3
  assert.equal(fault("inBelow", 63, 2), null);              // G fret 8: fretted B3 at fret 4
  assert.equal(fault("outDown", 68, 0), null);              // e fret 4: a shorter slide-out is fine
  assert.match(fault("outDown", 65, 0), /does not fit/);    // e fret 1: nowhere to go
  assert.equal(fault("outUp", 65, 0), null);
});

test("a slide-in is fingered where it starts, the hand travelling with it", async () => {
  const { handForShape } = await import("../../web/voicing-core.js");
  // D#4 slid into from B3 on the G string, the passage's hand at 4: the index on fret 4
  // slides to 8. It used to be the pinky stretched to 8 from a hand that never moved.
  const note = { start: 0, end: 1, pitch: 63, slide: "inBelow" };
  const hand = handForShape(new Map([[note, { string: 2, fret: 8 }]]), 4);
  assert.equal(hand.fingers.get(note), 1);
  assert.equal(hand.seat, 8);   // the landing's seat; the board shows it from the start (4)
  const plain = { start: 0, end: 1, pitch: 63 };
  assert.equal(handForShape(new Map([[plain, { string: 2, fret: 8 }]]), 4).fingers.get(plain), 4);
});

test("the hand travels to where a slide-in starts and leaves from where a slide-out ends", () => {
  const { handAt, handColumns } = fretboardCore;
  const col = (start, end, fret, slide) => {
    const note = { start, end, pitch: 55 + fret, ...(slide ? { slide } : {}) };
    return { start, end, eighth: 4, seat: fret, fingers: [{ string: 2, fret, finger: 1, note, start, strikeStart: start }] };
  };
  const x0 = (columns, t) => handAt(handColumns(columns), t, 0.5)?.anchor?.x0;
  // Fret 4, then a slide-in that lands on 8 from 4: no trip to 8 and back.
  const into = [col(0, 1, 4), col(1, 2, 8, "inBelow")];
  for (const t of [0.8, 0.95, 0.999]) assert.ok(Math.abs(x0(into, t) - x0(into, 1.001)) < 1, `slide-in at ${t}`);
  // A slide-out from 8 down, then fret 3: the move starts where the slide ended.
  const out = [col(0, 1, 8, "outDown"), col(1.5, 2, 3)];
  const ended = x0(out, 0.999), left = x0(out, 1.0 + 1e-3);
  assert.ok(Math.abs(ended - left) < 2, "no jump back to fret 8 when the hand leaves");
});

test("a remembered finger puts the hand under a single note, unless the hand is held", async () => {
  const { handForShape } = await import("../../web/voicing-core.js");
  const note = { pitch: 63, slide: "inBelow" };
  const shape = new Map([[note, { string: 3, fret: 13 }]]);
  // From a passage at 5, the slide-in from 9 would be the pinky; asked for the index, the hand goes to 9.
  assert.equal(handForShape(shape, 9, undefined, new Map()).fingers.get(note), 4);
  const asked = handForShape(shape, 9, undefined, new Map([[note, 1]]));
  assert.deepEqual([asked.fingers.get(note), asked.seat], [1, 13]);
  assert.equal(handForShape(shape, 9, undefined, new Map([[note, 1]]), true).fingers.get(note), 4);
});
