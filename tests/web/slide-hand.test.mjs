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
