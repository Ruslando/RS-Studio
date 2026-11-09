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
