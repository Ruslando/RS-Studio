import assert from "node:assert/strict";
import { barreGroups, barreSpanSupported } from "../../web/fretboard-core.js";
import { assignFingers, fingeringOptions, voiceNotesFingered, chordColumns } from "../../web/voicing-core.js";
import { readFileSync } from 'node:fs';

const mark = (string, fret = 5, finger = 1, extra = {}) =>
  ({ string, fret, finger, note: { start: 0, end: 1 }, ...extra });
const strings = marks => barreGroups(marks).map(group => group.map(m => m.string));
const gap = [mark(5), mark(3), mark(2)];
assert.deepEqual(strings(gap), [[2, 3, 5]], "a string the chord leaves out may lie under the barre (pressed, not picked)");
assert.deepEqual(strings([mark(5), mark(4), mark(3), mark(2)]), [[2, 3, 4, 5]], "adjacent strings form a barre");
assert.deepEqual(strings([...gap, mark(4, 7, 3)]), [[2, 3, 5], [4]], "a higher fretted A string covers the gap");
assert.deepEqual(strings([...gap, mark(4, 3, 2)]), [[2, 3], [5], [4]], "a lower A string cannot be covered");
assert.deepEqual(strings([...gap, mark(4, 0, -1)]), [[4], [2, 3], [5]], "an open A string breaks the barre");
for (const extra of [{ dead: true }, { note: { fx: { dead: true } } }, { note: { harmonic: "natural" } }]) {
  assert.equal(barreSpanSupported([...gap, mark(4, 7, 3, extra)], 5, 2, 5), false);
}
assert.equal(barreSpanSupported([mark(0), mark(3), mark(1, 3, 2), mark(2)], 5, 0, 3), false,
  "every played string under the barre needs coverage, not just one");
assert.equal(barreSpanSupported([mark(0), mark(3), mark(1, 7, 2)], 5, 0, 3), true, "an unplayed string needs none");
assert.deepEqual(strings([mark(0), mark(3), mark(1, 7, 2), mark(2, 8, 3)]), [[0, 3], [1], [2]]);
assert.deepEqual(strings([...gap, mark(4, 7, 3, { pressed: false })]), [[2, 3], [5], [4]],
  "a future finger cannot bridge a currently pressed barre");
assert.deepEqual(strings([...gap, mark(4, 7, 3, { releasing: true })]), [[2, 3], [5], [4]],
  "an outgoing finger cannot bridge the next barre");
assert.deepEqual(strings([...gap, mark(4, 7, 3, { opacity: 0 })]), [[2, 3], [5], [4]]);
assert.deepEqual(gap.map(m => m.string), [5, 3, 2], "grouping does not reorder the source marks");

// Finger assignment and every enumerated pose must obey the same geometry.
for (const bridge of [null, mark(4, 0, -1), mark(4, 3, 2), mark(4, 7, 3)]) {
  const marks = bridge ? [...gap, bridge] : gap;
  const shape = new Map(marks.map(m => [m.note, { string: m.string, fret: m.fret }]));
  const fingers = assignFingers(shape);
  const poses = fingeringOptions(shape);
  if (!bridge || bridge.fret > 5) assert.ok(poses.some(pose =>
    pose.fingers.get(marks[0].note) === pose.fingers.get(marks[1].note)),
    "an unplayed or higher-fretted string keeps the full barre available");
  for (const pose of [{ fingers }, ...poses]) {
    const assigned = marks.map(m => ({ ...m, finger: pose.fingers.get(m.note) }));
    const low = assigned.find(m => m.string === 5), middle = assigned.find(m => m.string === 3);
    if (bridge && bridge.fret < 5) assert.notEqual(low.finger, middle.finger,
      "the voicer cannot assign one barre finger across an unsupported gap");
  }
}
console.log("fretboard barre continuity and higher-fret coverage OK");

// Exercise the production passage solver, not just its isolated grip scorer.
const project = JSON.parse(readFileSync(new URL('../../examples/chord-showcase/project.json', import.meta.url)));
const notes = project.editLanes[0].notes.filter(n => n.start >= 72 && n.start < 92);
const tuning = [64, 59, 55, 50, 45, 40];
const played = voiceNotesFingered(notes, tuning);
for (const column of chordColumns(notes)) {
  const contacts = column.notes.map(note => ({ note, ...played.voiced.get(note), finger: played.fingers.get(note) }));
  const fretting = contacts.filter(c => c.fret > 0);
  for (const finger of new Set(fretting.map(c => c.finger))) {
    const held = fretting.filter(c => c.finger === finger);
    assert.ok(finger >= 1 && finger <= 4);
    assert.equal(new Set(held.map(c => c.fret)).size, 1, `one fret per finger at ${column.t0}`);
    const groups = barreGroups(contacts).filter(g => g[0].finger === finger && g[0].fret > 0);
    assert.equal(groups.length, 1, `one connected grip per finger at ${column.t0}`);
  }
  if (column.t0 === 72 || column.t0 === 76)
    assert.equal(new Set(fretting.map(c => c.finger)).size, 4, 'E7#9 and B7 require four separate fingers');
}
console.log('showcase passage uses one connected grip per finger');
