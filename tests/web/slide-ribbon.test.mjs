import assert from "node:assert/strict";
import { easedCurveAt, pitchOffsetAt, slideAt, vibratoStartOf, slideRibbon, slideStartOf, slideTargets } from "../../web/bend.js";
import { splitNote } from "../../web/slice.js";
import { effectSignatureFields } from "../../web/note-effects.js";

for (const slide of ["shift", "legato"]) {
  const source = { start: 0, end: 1, pitch: 60, slide, pos: { string: 2 } };
  const other = { start: 2, end: 3, pitch: 61, pos: { string: 1 } };
  const target = { start: 2, end: 3, pitch: 67, pos: { string: 2 } };
  const onto = slideTargets([source, other, target]).get(source);
  assert.equal(onto, target, "connect to the correct chord voice");
  assert.deepEqual(slideRibbon(source, onto), { end: 2, points: [[0, 0], [1, 7]] },
    "ribbon reaches the target across a gap");
  assert.deepEqual(slideRibbon({ ...source, pitch: 72 }, target).points, [[0, 0], [1, -5]],
    "descending slides reach the lower pitch");
  assert.equal(slideRibbon(source, null), null, "no invented target");
}
assert.deepEqual(slideRibbon({ start: 0, end: 1, slide: "outUp" }, { start: 1, pitch: 65 }), { end: 1, points: [[0, 0], [1, 5]] },
  "a slide-out stays within its note");
assert.deepEqual(slideRibbon({ start: 0, end: 1, slide: "outDown", slideFrets: 3 }, null, { fret: 7 }).points,
  [[0, 0], [1, -3]]);
assert.deepEqual(slideRibbon({ start: 0, end: 1, slide: "inAbove", slideEnd: 0.25, slideFrets: 2 }, null).points,
  [[0, 2], [0.25, 0], [1, 0]], "a slide-in comes from its far end");
assert.equal(slideRibbon({ start: 0, end: 1, slide: "outDown" }, null, { fret: 1 }), null, "nowhere to go from fret 1");
assert.equal(slideRibbon({ start: 1, slide: "shift" }, { start: 1, pitch: 65 }), null);

// A late slide start holds the ribbon flat, then slides over the rest.
{
  const source = { start: 0, end: 1, pitch: 60, slide: "legato", slideStart: 0.5 };
  const target = { start: 2, end: 3, pitch: 67 };
  assert.deepEqual(slideRibbon(source, target).points, [[0, 0], [0.25, 0], [1, 7]],
    "hold point sits at the note's own fraction of the ribbon");
  assert.equal(slideAt(source, 0.4, 1, { to: 7 }), 0, "held before the slide start");
  assert.equal(slideAt(source, 0.75, 1, { to: 7 }), 4, "halfway through the slide part");
  assert.equal(slideAt(source, 1, 1, { to: 7 }), 7);
  assert.equal(slideStartOf({ slide: "outUp", slideStart: 0.5 }), 0, "a slide-out spans the whole note");
  assert.equal(slideStartOf({ slide: "inBelow", slideStart: 0.5 }), 0, "a slide-in starts at the pick");
  assert.equal(slideStartOf({ slide: "shift", slideStart: 2 }), 0.95, "never leaves the slide no time");
}

// Slicing keeps the slide start at its moment in time.
{
  const note = { id: "a", start: 0, end: 1, pitch: 60, slide: "shift", slideStart: 0.5 };
  const after = splitNote(note, 0.75, 0.05, () => "b");
  assert.equal(after.left.slide, "shift");
  assert.ok(Math.abs(after.left.slideStart - 2 / 3) < 1e-9);
  assert.equal(after.right.slide, undefined);
  assert.equal(after.right.slideStart, undefined);
  const before = splitNote(note, 0.25, 0.05, () => "b");
  assert.equal(before.left.slide, undefined, "the part before the slide just holds");
  assert.equal(before.left.slideStart, undefined);
  assert.equal(before.right.slide, "shift");
  assert.ok(Math.abs(before.right.slideStart - 1 / 3) < 1e-9);
}

// A note without a late start hashes as it did before the field existed.
assert.equal("slideStart" in effectSignatureFields({ slide: "shift" }), false);
assert.equal(effectSignatureFields({ slide: "shift", slideStart: 0.5 }).slideStart, 0.5);

// Hit-testing follows the eased curve the stage draws, not straight lines.
{
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg}: ${a} vs ${b}`);
  near(easedCurveAt([[0, 0], [1, 2]], 0.5), 1, "midpoint of a step");
  assert.ok(easedCurveAt([[0, 0], [1, 2]], 0.1) < 0.1, "eases out of the start, unlike a straight line");
  near(easedCurveAt([[0, 0], [0.25, 0], [1, 7]], 0.2), 0, "held flat before a late slide");
  near(easedCurveAt([[0, 0], [0.5, 2], [1, 2]], 0.75), 2, "flat after the bend");
  // The same cubic the canvas strokes: x(u), y(u) with both handles at the step's middle.
  for (const u of [0.1, 0.3, 0.7, 0.9]) {
    const x = 3 * (1 - u) * u * 0.5 + u ** 3, y = 2 * (3 * (1 - u) * u * u + u ** 3);
    near(easedCurveAt([[0, 0], [1, 2]], x), y, `on the drawn curve at u=${u}`);
  }
}

// Late vibrato: still before its start, the same wobble after it, kept in time by slicing.
{
  const plain = { start: 0, end: 2, pitch: 60, fx: { vibrato: true } };
  const late = { ...plain, vibratoStart: 0.5 };
  assert.equal(pitchOffsetAt(late, 0.4, 0.8), 0, "no vibrato before it sets in");
  assert.ok(Math.abs(pitchOffsetAt(late, 0.6, 1.2) - pitchOffsetAt(plain, 0.1, 0.2)) < 1e-9, "then it wobbles as from a pick");
  assert.equal(vibratoStartOf({ ...late, fx: {} }), 0, "only with vibrato on");
  const after = splitNote(late, 1.5, 0.05, () => "b");
  assert.equal(after.left.vibratoStart, 2 / 3);
  assert.equal(after.right.fx.vibrato, true);
  assert.equal(after.right.vibratoStart, undefined);
  const before = splitNote(late, 0.5, 0.05, () => "b");
  assert.equal(before.left.fx, undefined, "the part before it has no vibrato");
  assert.equal(before.right.vibratoStart, 1 / 3);
}
