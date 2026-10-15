import assert from "node:assert/strict";
import { slideRibbon, slideTargets } from "../../web/bend.js";

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
assert.equal(slideRibbon({ start: 0, slide: "outUp" }, { start: 1, pitch: 65 }), null);
assert.equal(slideRibbon({ start: 1, slide: "shift" }, { start: 1, pitch: 65 }), null);
