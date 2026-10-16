import assert from "node:assert/strict";
import { barreGroups, barreSpanSupported } from "../../web/fretboard-core.js";
import { assignFingers, fingeringOptions } from "../../web/voicing-core.js";

const mark = (string, fret = 5, finger = 1, extra = {}) =>
  ({ string, fret, finger, note: { start: 0, end: 1 }, ...extra });
const strings = marks => barreGroups(marks).map(group => group.map(m => m.string));
const gap = [mark(5), mark(3), mark(2)];
assert.deepEqual(strings(gap), [[2, 3], [5]], "missing A string breaks the full barre, preserving the D/G partial barre");
assert.deepEqual(strings([mark(5), mark(4), mark(3), mark(2)]), [[2, 3, 4, 5]], "adjacent strings form a barre");
assert.deepEqual(strings([...gap, mark(4, 7, 3)]), [[2, 3, 5], [4]], "a higher fretted A string covers the gap");
assert.deepEqual(strings([...gap, mark(4, 3, 2)]), [[2, 3], [5], [4]], "a lower A string cannot be covered");
assert.deepEqual(strings([...gap, mark(4, 0, 0)]), [[4], [2, 3], [5]], "an open A string breaks the barre");
for (const extra of [{ dead: true }, { note: { fx: { dead: true } } }, { note: { harmonic: "natural" } }]) {
  assert.equal(barreSpanSupported([...gap, mark(4, 7, 3, extra)], 5, 2, 5), false);
}
assert.equal(barreSpanSupported([mark(0), mark(3), mark(1, 7, 2)], 5, 0, 3), false,
  "every skipped string needs coverage, not just one");
assert.deepEqual(strings([mark(0), mark(3), mark(1, 7, 2), mark(2, 8, 3)]), [[0, 3], [1], [2]]);
assert.deepEqual(strings([...gap, mark(4, 7, 3, { pressed: false })]), [[2, 3], [5], [4]],
  "a future finger cannot bridge a currently pressed barre");
assert.deepEqual(strings([...gap, mark(4, 7, 3, { releasing: true })]), [[2, 3], [5], [4]],
  "an outgoing finger cannot bridge the next barre");
assert.deepEqual(strings([...gap, mark(4, 7, 3, { opacity: 0 })]), [[2, 3], [5], [4]]);
assert.deepEqual(gap.map(m => m.string), [5, 3, 2], "grouping does not reorder the source marks");

// Finger assignment and every enumerated pose must obey the same geometry.
for (const bridge of [null, mark(4, 0, 0), mark(4, 3, 2), mark(4, 7, 3)]) {
  const marks = bridge ? [...gap, bridge] : gap;
  const shape = new Map(marks.map(m => [m.note, { string: m.string, fret: m.fret }]));
  const fingers = assignFingers(shape);
  const poses = fingeringOptions(shape);
  if (bridge?.fret > 5) assert.ok(poses.some(pose =>
    pose.fingers.get(marks[0].note) === pose.fingers.get(marks[1].note)),
    "higher-fretted coverage keeps the full barre available to the voicer");
  for (const pose of [{ fingers }, ...poses]) {
    const assigned = marks.map(m => ({ ...m, finger: pose.fingers.get(m.note) }));
    const low = assigned.find(m => m.string === 5), middle = assigned.find(m => m.string === 3);
    if (!bridge || bridge.fret < 5) assert.notEqual(low.finger, middle.finger,
      "the voicer cannot assign one barre finger across an unsupported gap");
  }
}
console.log("fretboard barre continuity and higher-fret coverage OK");
