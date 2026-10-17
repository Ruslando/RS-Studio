import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { positionPreviewHand, positionPreviewLane } from '../../web/position-preview.js';
import { applySharedPositionPlan, positionSelection, sharedPositionPlan } from '../../web/position-selection.js';
import { chordColumns, handForShape, normalizeOverrideInfluence, overrideFlow, voiceNotesFingered, writeColumnOverride } from '../../web/voicing-core.js';

const project = JSON.parse(readFileSync(new URL('../../examples/override-showcase/project.json', import.meta.url)));
const tuning = [64, 59, 55, 50, 45, 40];
const solve = lane => voiceNotesFingered(lane.notes, tuning, Infinity, {
  bars: Array.from({ length: 33 }, (_, i) => i * 4), holds: lane.handHolds, instrument: lane.instrument,
});

function compare(lane, source, shape, selection, kind) {
  const before = JSON.stringify(lane), voiced = solve(lane).voiced;
  const prepared = positionPreviewLane(lane, source, shape, selection, tuning, n => voiced.get(n), 22, kind);
  assert.ok(prepared);
  const preview = solve(prepared.lane);
  const hand = positionPreviewHand(source, prepared.noteFor, preview);
  assert.equal(JSON.stringify(lane), before, 'preview leaves live notes, holds and flags untouched');
  const actual = structuredClone(lane);
  const mapping = new Map(lane.notes.map((n, i) => [n, actual.notes[i]]));
  const actualSource = source.map(n => mapping.get(n));
  const actualShape = new Map([...shape].map(([n, pos]) => [mapping.get(n), pos]));
  const actualSelection = new Set([...selection].map(n => mapping.get(n)));
  if (positionSelection(actual, actualSelection).multiple) {
    const positions = solve(actual).voiced;
    const plan = sharedPositionPlan(actual, actualSelection, actualSource, actualShape, tuning, n => positions.get(n), 22);
    assert.equal(plan.error, null);
    applySharedPositionPlan(plan);
  } else if (kind === 'chord') {
    const result = writeColumnOverride(actual.notes, actualSource,
      { notes: actualSource, shape: actualShape }, normalizeOverrideInfluence(overrideFlow(actualSource)));
    actual.notes = result.notes;
  } else {
    const flags = normalizeOverrideInfluence(overrideFlow(actualSource));
    for (const n of actualSource) n.pos = { ...actualShape.get(n), scope: 'local',
      influencePrevious: flags.previous, influenceNext: flags.next,
      adaptPrevious: flags.adaptPrevious, adaptNext: flags.adaptNext };
  }
  const committed = solve(actual);
  lane.notes.forEach((note, i) => {
    const target = actual.notes[i], previewNote = prepared.noteFor(note);
    assert.deepEqual(preview.voiced.get(previewNote), committed.voiced.get(target));
    assert.equal(preview.seats.get(previewNote), committed.seats.get(target));
    assert.equal(preview.fingers.get(previewNote), committed.fingers.get(target));
  });
  for (const note of source) {
    const target = mapping.get(note);
    assert.equal(hand.seat, committed.seats.get(target));
    assert.equal(hand.fingers.get(note), committed.fingers.get(target));
  }
  return hand;
}

// Reproduce the mismatch: a local pose estimate from seat 2 reports 4 for A7,
// whereas the committed passage can choose a different anchor and finger.
for (const adaptNext of [false, true]) for (const [string, fret] of [[3, 2], [4, 7], [5, 12]]) {
  const lane = structuredClone(project.editLanes[0]), first = lane.notes[0];
  first.pos = { string: 3, fret: 2, scope: 'local', influencePrevious: false, influenceNext: false,
    adaptPrevious: false, adaptNext };
  const shape = new Map([[first, { string, fret }]]);
  const hand = compare(lane, [first], shape, new Set([first]), 'note');
  if (!adaptNext && fret === 7) assert.notEqual(hand.seat, handForShape(shape, 2).seat,
    'regression: do not display the old single-grip estimate as the final answer');
}

{
  const lane = structuredClone(project.editLanes[0]);
  const source = chordColumns(lane.notes).find(c => c.t0 === 3).notes;
  const positions = new Map([[52, { string: 3, fret: 2 }], [55, { string: 2, fret: 0 }], [59, { string: 1, fret: 0 }]]);
  compare(lane, source, new Map(source.map(n => [n, positions.get(n.pitch)])), new Set(source), 'custom');
}

for (const multiple of [false, true]) {
  const lane = structuredClone(project.editLanes[0]);
  const columns = chordColumns(lane.notes), source = columns.find(c => c.t0 === 3).notes;
  const selection = new Set(multiple ? [...source, ...columns.find(c => c.t0 === 7).notes] : source);
  const positions = new Map([[52, { string: 3, fret: 2 }], [55, { string: 2, fret: 0 }], [59, { string: 1, fret: 0 }]]);
  compare(lane, source, new Map(source.map(n => [n, positions.get(n.pitch)])), selection, 'chord');
}

{
  const lane = structuredClone(project.editLanes[0]), first = lane.notes[0];
  compare(lane, [first], new Map([[first, { string: 4, fret: 7 }]]),
    new Set([first, lane.notes.find(n => n.start === 8 && n.pitch === 52)]), 'note');
}

console.log('position preview: committed positions, hand anchors and fingers match for notes, chords, adaptation and batch edits');
