import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chordColumns, scoreShapesAsDecided, voiceNotesFingered } from '../../web/voicing-core.js';

const tuning = [64, 59, 55, 50, 45, 40];
const project = JSON.parse(readFileSync(new URL('../../examples/override-showcase/project.json', import.meta.url)));
const lane = project.editLanes[0];
const options = { bars: Array.from({ length: 33 }, (_, i) => i * 4),
  holds: lane.handHolds, instrument: 'electric' };
const solve = (notes, opts = options) => voiceNotesFingered(notes, tuning, Infinity, opts);
const result = solve(lane.notes);
const run = start => lane.notes.filter(n => n.start >= start && n.start < start + 8);
const positions = (notes, got) => notes.map(n => got.voiced.get(n));

assert.deepEqual(positions(run(64), result), positions(run(32), result), 'A returns to its learned low strings');
assert.deepEqual(positions(run(72), result), positions(run(40), result), 'B returns to its learned low strings');
for (const start of [32, 40, 64, 72, 80, 88, 112, 120]) {
  assert.ok(run(start).every(n => result.seats.get(n) === 2),
    `run/variation at ${start}s stays together at hand position 2, across bar lines`);
}
for (const [start, seat] of [[48, 7], [56, 12], [96, 7], [104, 12]]) {
  assert.ok(run(start).every(n => result.seats.get(n) === seat), 'necessary high shifts still happen');
}
assert.deepEqual(lane.handHolds, [{ t: 32, fret: 2 }], 'only the initial low position is authored');
assert.ok(lane.notes.every(n => !n.pos && !n.motifId), 'the showcase has no note pins or motif answers');

// Repeated solves and save/reload reconstruct the same memory, without training
// on previous optimizer passes or changing serialized project data.
const serialized = JSON.stringify(lane.notes);
const reloaded = JSON.parse(serialized);
assert.deepEqual(positions(reloaded, solve(reloaded)), positions(lane.notes, result));
assert.equal(JSON.stringify(lane.notes), serialized);

const A = [52, 54, 55, 57, 59, 57, 55, 52];
const D = [76, 78, 79, 78, 76, 78, 79, 76];
const original = [...A, ...A, ...D, ...A, ...A].map((pitch, start) => ({ pitch, start, end: start + .8 }));
const opts = { bars: Array.from({ length: 11 }, (_, i) => i * 4), holds: [{ t: 0, fret: 2 }], instrument: 'electric' };
const base = solve(original, opts);
const pin = adaptNext => ({ string: 5, fret: 12, scope: 'local', influencePrevious: false,
  influenceNext: false, adaptPrevious: false, adaptNext });
const local = structuredClone(original);
local[24].pos = pin(false);
const localResult = solve(local, opts);
for (let i = 0; i < local.length; i++) if (i !== 24) {
  assert.deepEqual(localResult.voiced.get(local[i]), base.voiced.get(original[i]),
    'a local exception neither changes the approach nor teaches a new future preference');
}

const adapted = structuredClone(original);
adapted[24].pos = pin(true);
const adaptedResult = solve(adapted, opts);
const direct = structuredClone(original);
direct[24].pos = pin(false);
const directResult = solve(direct, { ...opts, holds: [...opts.holds, { t: 24, fret: 12 }] });
assert.deepEqual(positions(adapted, adaptedResult), positions(direct, directResult),
  'forward adaptation and direct hand placement use the same memory reset');
for (let i = 0; i < 24; i++) assert.deepEqual(adaptedResult.voiced.get(adapted[i]), base.voiced.get(original[i]));
assert.ok(adapted.slice(24).every(n => adaptedResult.seats.get(n) === 12),
  'old low memories do not pull an explicitly redirected run back, including the next bar');

// A frequently and exclusively used position can outweigh the same large
// movement cost that beats a weak memory. Offered-position scores expose the
// same frequency/confidence terms as the placement search.
const preferenceGap = count => {
  const notes = [...Array(count).fill(52), ...D, 52, ...D]
    .map((pitch, start) => ({ pitch, start, end: start + .8 }));
  const index = count + D.length, target = notes[index];
  const offers = [new Map([[target, { string: 3, fret: 2 }]]),
    new Map([[target, { string: 5, fret: 12 }]])];
  const scored = scoreShapesAsDecided(offers, chordColumns(notes), index, tuning,
    { bars: Array.from({ length: 20 }, (_, i) => i * 4), holds: [{ t: 0, fret: 2 }] });
  return scored[0].cost - scored[1].cost;
};
assert.ok(preferenceGap(1) > 0, 'one previous use need not justify a large isolated jump');
assert.ok(preferenceGap(16) < 0, 'frequent exclusive use can outweigh that same jump');

const chords = [52, 55, 59].map(pitch => ({ pitch, start: 0, end: .8 }));
const withReturn = [...chords, ...D.map((pitch, i) => ({ pitch, start: i + 1, end: i + 1.8 })),
  ...chords.map(n => ({ ...n, start: 9, end: 9.8 }))];
const chordResult = solve(withReturn, { bars: [0, 4, 8, 12], holds: [{ t: 0, fret: 2 }] });
assert.deepEqual(positions(withReturn.slice(-3), chordResult), positions(chords, chordResult),
  'a complete chord returns as a whole grip, including its open strings');

console.log('voicing memory: showcase returns, variations, local exceptions, resets and deterministic reload passed');
