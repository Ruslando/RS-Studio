import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BASS_HAND_PROFILE, assignFingers, chordColumns, fingeringChoices, fingeringOptions, gripCostBreakdown, handForShape, shapeKey,
} from '../../web/voicing-core.js';

const project = JSON.parse(readFileSync(new URL('../../examples/chord-showcase/project.json', import.meta.url)));
const tuning = [64, 59, 55, 50, 45, 40];
const notes = project.editLanes[0].notes.filter(n => n.start < 96);
const columns = chordColumns(notes);
const shape = frets => new Map(frets.flatMap((fret, i) => fret === null ? [] : [[
  { pitch: tuning[5 - i] + fret }, { string: 5 - i, fret },
]]));

// Every intended playable showcase grip, including C, G and non-index barres,
// must remain available. The stricter checks must not erase standard chords.
for (const column of columns) {
  const grip = new Map(column.notes.map(n => [n, n.pos]));
  assert.ok(fingeringOptions(grip).length, `showcase chord ${column.t0 / 4 + 1} remains playable`);
}

// Availability alone is insufficient: conventional C and D should use the
// ring finger, rather than unnecessarily spreading the grip onto the pinky.
for (const [start, expected] of [[12, [3, 2, 0, 1, 0]], [16, [0, 1, 3, 2]]]) {
  const column = columns.find(c => c.t0 === start);
  const best = gripCostBreakdown(new Map(column.notes.map(n => [n, n.pos])));
  assert.deepEqual(column.notes.map(n => best.fingering.fingers.get(n)), expected);
}

// The same one-fret ring/little split is shorter higher on the neck and longer
// on a bass: millimetres decide whether a hand reaches it, but which finger
// takes a note follows one finger per fret, so it costs the same anywhere.
const pair = (fret, profile) => {
  const grip = shape([null, null, null, null, fret + 1, fret]);
  const poses = fingeringOptions(grip, profile);
  return poses.find(p => [...grip].every(([n, pos]) => p.fingers.get(n) === (pos.string === 0 ? 3 : 4)));
};
assert.ok(pair(1));
assert.equal(pair(1, BASS_HAND_PROFILE), undefined, 'bass scale is not treated as guitar geometry');
assert.equal(pair(10).cost, pair(1).cost, 'finger choice does not depend on where on the neck');
// One finger per fret: two frets up is the ring finger, three the little one, at the nut and up the neck.
for (const fret of [1, 7]) {
  const two = shape([null, null, null, null, fret + 2, fret]), three = shape([null, null, null, null, fret + 3, fret]);
  assert.deepEqual([...two].map(([n]) => assignFingers(two).get(n)).sort(), [1, 3], `fret ${fret}: 2 frets apart = 1-3`);
  assert.deepEqual([...three].map(([n]) => assignFingers(three).get(n)).sort(), [1, 4], `fret ${fret}: 3 frets apart = 1-4`);
}

// The D-major counterexamples are the actual late offers reported by the user.
const rejected = [
  [null, 12, 0, 7, 7, null],
  [10, 12, null, 7, 7, null],
  [10, 12, 12, null, 7, null],
  [17, 17, 0, 11, null, null],
].map(shape);
for (const grip of rejected) {
  assert.equal(fingeringOptions(grip).length, 0, `reject overstretched D major: ${shapeKey(grip)}`);
}
const ordinaryD = shape([null, null, 0, 2, 3, 2]);
const movableD = shape([null, 5, 7, 7, 7, null]);
assert.ok(Number.isFinite(gripCostBreakdown(ordinaryD).total));
assert.ok(Number.isFinite(gripCostBreakdown(movableD).total));
assert.equal(gripCostBreakdown(shape([0, 0, 0, 0, 0, 0])).total, 0, 'open strings need no fretting hand');

// Exercise the production worker, not a test-only alternative generator.
let reply;
globalThis.self = { postMessage: value => { reply = value; } };
try {
  await import('../../web/voicing-worker.js');
  const before = JSON.stringify(columns);
  self.onmessage({ data: {
    columns, focusIdx: 4, tuning, instrument: 'electric', capo: 0,
    bars: Array.from({ length: 25 }, (_, i) => i * 4),
  } });
  assert.equal(JSON.stringify(columns), before, 'preview does not edit the song');
  assert.ok(reply.choices.length > 1, 'useful alternative D positions survive');
  const original = shapeKey(new Map(columns[4].notes.map(n => [n, n.pos])));
  assert.ok(reply.choices.some(choice => shapeKey(new Map(choice.notes.map((n, k) => [n, choice.positions[k]]))) === original),
    'the original is present before the board removes it from the alternatives');
  const badKeys = new Set(rejected.map(shapeKey));
  for (const [i, choice] of reply.choices.entries()) {
    const grip = new Map(choice.notes.map((n, k) => [n, choice.positions[k]]));
    assert.ok(!badKeys.has(shapeKey(grip)));
    assert.deepEqual(choice.notes.map(n => n.pitch), columns[4].notes.map(n => n.pitch), 'preserve every written pitch');
    assert.ok(Number.isFinite(choice.costs.grip));
    if (i) {
      const previous = reply.choices[i - 1].costs;
      assert.ok(previous.grip < choice.costs.grip ||
        (previous.grip === choice.costs.grip && previous.passage <= choice.costs.passage),
      'ergonomics precedes passage cost');
    }
  }
  console.log(`grip rating: 24 showcase grips preserved; D-major offers reduced to ${reply.choices.length - 1} alternatives`);
  for (let focusIdx = 0; focusIdx < columns.length; focusIdx++) {
    self.onmessage({ data: {
      columns, focusIdx, tuning, instrument: 'electric', capo: 0,
      bars: Array.from({ length: 25 }, (_, i) => i * 4),
    } });
    for (const choice of reply.choices) {
      const grip = new Map(choice.notes.map((n, k) => [n, choice.positions[k]]));
      const shown = new Map(choice.fingers);
      const pose = fingeringOptions(grip).find(p => [...grip].every(([n, pos]) => p.fingers.get(n) === shown.get(pos.string)));
      assert.ok(pose, `worker displays a feasible fingering at chord ${focusIdx + 1}`);
      assert.equal(pose.cost, choice.costs.grip, 'ranking measures the displayed fingering');
    }
  }
} finally {
  delete globalThis.self;
}

// Every valid fingering is a Finger choice, not only the few the search keeps, and
// a chosen one holds: the m7 shell 1x111x with a ring barre (EOF's 2x333x).
{
  const shell = shape([1, null, 1, 1, 1, null]);
  const notes = [...shell.keys()];
  const ring = new Map(notes.map((n, i) => [n, i === 0 ? 2 : 3]));
  const same = (a, b) => notes.every(n => a.get(n) === b.get(n));
  assert.ok(fingeringOptions(shell).length < fingeringOptions(shell).all.length);
  assert.ok(fingeringChoices(shell).some(c => same(c, ring)), 'the ring barre is offered');
  assert.ok(same(handForShape(shell, null, undefined, ring).fingers, ring), 'and kept when chosen');
}
// A-shape barre with three fingers: index/middle span two frets from fret 3 on.
{
  const a = shape([null, 3, 5, 5, 5, 3]), notes = [...a.keys()];
  assert.ok(fingeringChoices(a).some(c => notes.map(n => c.get(n)).join('') === '12341'));
}
console.log('every valid fingering is a choice');
