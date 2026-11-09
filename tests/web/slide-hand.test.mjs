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
