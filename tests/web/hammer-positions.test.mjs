import assert from 'node:assert/strict';
import test from 'node:test';
import { hammerPositionGroup, hammerPositionPlan, hammerPositionPreview } from '../../web/hammer-positions.js';
import { positionPreviewLane } from '../../web/position-preview.js';
import { positionSelection, sharedPositionPlan } from '../../web/position-selection.js';
const tuning = [43, 38, 33, 28];
const pair = (start = 0) => [
  { id: `c${start}`, pitch: 49, start, end: start + 1, pos: { string: 1, fret: 11 }, finger: 1, fx: { hammer: 'origin' } },
  { id: `d${start}`, pitch: 51, start: start + 1, end: start + 2, pos: { string: 1, fret: 13 }, finger: 3, fx: { hammer: 'dest' } },
];
test('either end moves the complete C#3 to D#3 hammer-on onto the G string', () => {
  for (const index of [0, 1]) {
    const notes = pair(), lane = { notes }, original = structuredClone(notes), target = notes[index];
    const shape = new Map([[target, { string: 0, fret: target.pitch - 43 }]]);
    const plan = hammerPositionPlan(lane, shape, tuning, n => n.pos);
    assert.equal(plan.error, null); assert.equal(plan.linked, true);
    assert.deepEqual(plan.changes.map(c => [c.note.id, c.pos.string, c.pos.fret]).sort(), [['c0', 0, 6], ['d0', 0, 8]]);
    const preview = positionPreviewLane(lane, [target], shape, new Set([target]), tuning, n => n.pos, 24);
    assert.deepEqual(preview.lane.notes.map(n => n.pos.string), [0, 0]);
    assert.deepEqual(notes, original, 'planning and hovering do not mutate notes, timing or techniques');
    const links = hammerPositionPreview(preview.lane.notes, [preview.noteFor(target)]);
    assert.equal(links.length, 1); assert.equal(links[0].kind, 'H');
    assert.equal(links[0].from.note.pitch, 49); assert.equal(links[0].to.note.pitch, 51);
    assert.equal(links[0].from.fret, 6); assert.equal(links[0].to.fret, 8);
  }
});
test('authored destination-only hammer toggles also move their unmarked source', () => {
  const notes = pair(); delete notes[0].fx; notes[1].fx.hammer = true;
  const plan = hammerPositionPlan({ notes }, new Map([[notes[1], { string: 0, fret: 8 }]]), tuning, n => n.pos);
  assert.equal(plan.error, null); assert.equal(plan.changes.length, 2);
});
test('chains include incoming hammer-ons and pull-offs but do not absorb a picked note or cross a rest', () => {
  const notes = pair();
  const pull = { id: 'pull', pitch: 49, start: 2, end: 3, pos: { string: 1, fret: 11 }, fx: { hammer: 'dest' } };
  const picked = { id: 'picked', pitch: 47, start: 3, end: 4, pos: { string: 1, fret: 9 } };
  notes.push(pull, picked);
  assert.deepEqual(new Set(hammerPositionGroup(notes, notes[1])), new Set(notes.slice(0, 3)));
  assert.deepEqual(hammerPositionPreview(notes, [notes[1]]).map(l => l.kind), ['H', 'P']);
  assert.equal(positionSelection({ notes }, new Set(notes.slice(0, 3))).error, null, 'selecting a connected run is a single linked edit');
  notes[0].end = .5;
  assert.deepEqual(hammerPositionGroup(notes, notes[0]), [notes[0]], 'a flagged later note cannot bridge a rest');
});
test('unreachable sources and collisions are rejected atomically', () => {
  const notes = pair(); notes[0].pitch = 40; notes[0].pos.fret = 2;
  const rejected = hammerPositionPlan({ notes }, new Map([[notes[1], { string: 0, fret: 8 }]]), tuning, n => n.pos);
  assert.ok(rejected.error); assert.deepEqual(rejected.changes, []);
  const chord = pair(); chord.push({ id: 'sibling', start: 0, end: 1, pitch: 47, pos: { string: 0, fret: 4 } });
  assert.ok(hammerPositionPlan({ notes: chord }, new Map([[chord[1], { string: 0, fret: 8 }]]), tuning, n => n.pos).error);
});
test('batch edits move the incoming source of every selected hammer destination', () => {
  const first = pair(), second = pair(4), notes = [...first, ...second];
  const plan = sharedPositionPlan({ notes }, new Set([first[1], second[1]]), [first[1]],
    new Map([[first[1], { string: 0, fret: 8 }]]), tuning, n => n.pos);
  assert.equal(plan.error, null); assert.equal(plan.changes.length, 4);
  assert.ok(plan.changes.every(c => c.pos.string === 0));
});
