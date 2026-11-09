import test from "node:test";
import assert from "node:assert/strict";
import { enumerateShapes, fingeringOptions } from "../../web/voicing-core.js";

const E = [64, 59, 55, 50, 45, 40];   // app strings: 0 = high e
const key = (shape) => [...shape.values()].map((p) => `${p.string}:${p.fret}`).sort().join(" ");

test("a chord muted as a whole is offered only the grips the chord has", () => {
  const chord = (dead) => [47, 54, 58, 63, 66].map((pitch) => ({ pitch, ...(dead ? { fx: { dead: true } } : {}) }));
  const sounding = new Set(enumerateShapes(chord(false), E).map(key));
  const muted = enumerateShapes(chord(true), E).map(key);
  assert.ok(muted.length > 0);
  for (const k of muted) assert.ok(sounding.has(k), `muted grip ${k} cannot be held as a chord`);
});

test("a muted note beside sounding ones is still not a reach", () => {
  const low = { pitch: 43 }, high = { pitch: 59 }, scratch = { pitch: 74, fx: { dead: true } };
  const shape = new Map([[low, { string: 5, fret: 3 }], [high, { string: 2, fret: 4 }], [scratch, { string: 0, fret: 10 }]]);
  assert.ok(fingeringOptions(shape).length > 0);
});

test("a barre chord muted as a whole keeps its barre and its hand", async () => {
  const { handForShape } = await import("../../web/voicing-core.js");
  const mk = (pitch, string, fret) => [{ pitch, fx: { dead: true } }, { string, fret }];
  const hand = handForShape(new Map([mk(44, 5, 4), mk(51, 4, 6), mk(56, 3, 6), mk(59, 2, 4), mk(63, 1, 4)]), 4);
  assert.deepEqual([hand.playable, hand.seat], [true, 4]);
});
