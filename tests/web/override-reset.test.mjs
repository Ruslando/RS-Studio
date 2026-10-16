import assert from "node:assert/strict";
import { writeColumnOverride } from "../../web/voicing-core.js";
import { overrideResetPreview } from "../../web/override-reset.js";

const original = [
  { id: "a", pitch: 45, start: 0, end: 1, pos: { string: 5, fret: 5 } },
  { id: "b", pitch: 55, start: 0, end: 1, pos: { string: 3, fret: 5 } },
];
const expected = structuredClone(original);
const voices = [{ pitch: 45 }, { pitch: 60 }];
const choice = { notes: voices, shape: new Map(voices.map((n, i) => [n, { string: 4 - i, fret: 7 }])) };
const changed = writeColumnOverride(original, original, choice, {});
const lane = { notes: changed.notes, handHolds: [{ t: 0, fret: 7 }, { t: 2, fret: 3 }] };
const before = structuredClone(lane);
const preview = overrideResetPreview(lane, changed.column, 0);
assert.deepEqual(preview.notes, expected, "preview restores original notes AND fixed positions");
assert.deepEqual(preview.handHolds, [{ t: 2, fret: 3 }]);
assert.deepEqual(lane, before, "preview must not change live state");
const reset = writeColumnOverride(lane.notes, changed.column, null, {});
assert.deepEqual(reset.notes, expected, "reset returns the same shape as its preview");
console.log("override reset tests passed");
