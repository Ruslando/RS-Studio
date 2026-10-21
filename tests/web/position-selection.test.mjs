import assert from 'node:assert/strict';
import { applySharedPositionPlan, positionEditTargets, positionSelection, resetSharedPositions, sharedPositionPlan } from '../../web/position-selection.js';
import { chordColumns, placementFault, placementLimits, voiceNotes } from '../../web/voicing-core.js';

const tuning = [64, 59, 55, 50, 45, 40];
const note = (start, pitch, extra = {}) => ({ start, end: start + .4, pitch, ...extra });
const flags = { follow: 'locked' };

// Edit highlighting follows every recipient, including occurrences away from
// the playhead, and never advertises edits for an invalid shared selection.
{
  const a = note(0, 52), b = note(8, 52), other = note(4, 55);
  const lane = { notes: [a, other, b] };
  assert.deepEqual([...positionEditTargets(positionSelection(lane, new Set([a, b])), [a])], [a, b]);
  assert.equal(positionEditTargets(positionSelection(lane, new Set([a, other])), [a]).size, 0);
  assert.deepEqual([...positionEditTargets(positionSelection(lane, new Set()), [other])], [other]);
  const chord = [note(0, 52), note(0, 55), note(0, 59)];
  const repeat = chord.map(n => note(12, n.pitch));
  const chords = { notes: [...chord, ...repeat] };
  assert.deepEqual([...positionEditTargets(positionSelection(chords, new Set(chords.notes)), chord)], chords.notes);
  assert.deepEqual([...positionEditTargets(positionSelection(chords, new Set([chord[0]])), chord)], chord);
}
const plan = (lane, selection, source, shape, maxFret = 22) => {
  const voiced = voiceNotes(lane.notes, tuning);
  return sharedPositionPlan(lane, selection, source, shape, tuning, n => voiced.get(n), maxFret);
};

// The focused occurrence's existing grip can be copied to differently placed
// selected occurrences, leaving an unselected occurrence of the same pitch alone.
{
  const a = note(0, 52, { pos: { string: 3, fret: 2 } });
  const b = note(2, 52, { pos: { string: 4, fret: 7 } });
  const c = note(4, 52, { pos: { string: 4, fret: 7 } });
  const lane = { notes: [a, b, c] };
  const accepted = plan(lane, new Set([a, b]), [a], new Map([[a, a.pos]]));
  assert.equal(accepted.error, null);
  applySharedPositionPlan(accepted);
  assert.equal(b.pos.string, 3);
  assert.equal(b.pos.fret, 2);
  assert.equal(c.pos.string, 4);
}

// Different effects are preserved; the intersection excludes open-string bends.
{
  const a = note(0, 64, { fx: { palmMute: true } });
  const b = note(2, 64, { bend: 'full', fx: { vibrato: true },
    pos: { string: 1, fret: 5, scope: 'local', ...flags } });
  const untouched = note(1, 55);
  const lane = { notes: [a, untouched, b], handHolds: [{ t: 0, fret: 2 }] };
  const selection = new Set([a, b]), original = JSON.stringify(lane);
  const rejected = plan(lane, selection, [a], new Map([[a, { string: 0, fret: 0 }]]));
  assert.match(rejected.error, /technique.*open string/);
  assert.equal(applySharedPositionPlan(rejected), false);
  assert.equal(JSON.stringify(lane), original, 'failed validation never partially edits the selection');
  const effects = [JSON.stringify(a.fx), JSON.stringify(b.fx), b.bend];
  const accepted = plan(lane, selection, [a], new Map([[a, { string: 1, fret: 5 }]]));
  assert.equal(accepted.error, null);
  assert.equal(applySharedPositionPlan(accepted), true);
  assert.deepEqual(a.pos, b.pos);
  assert.notEqual(a.pos, b.pos, 'pins never share mutable state');
  assert.ok([a, b].every(n => n.pos.follow === 'here'), 'a shared edit is only here');
  assert.deepEqual([JSON.stringify(a.fx), JSON.stringify(b.fx), b.bend], effects);
  assert.equal(untouched.pos, undefined);
  assert.deepEqual(lane.handHolds, [{ t: 0, fret: 2 }]);
  assert.equal(applySharedPositionPlan(accepted), false, 'reapplying the same local pins is a no-op');
  const reset = resetSharedPositions(lane, selection);
  assert.ok(reset.changed);
  assert.ok([...reset.selection].every(n => !n.pos));
  assert.ok(a.pos, 'reset preview does not mutate live notes');
  assert.equal(reset.notes[1], untouched, 'unselected identities are retained');
}

// Whole chords match pitch multiplicity, independently of note order or effects.
{
  const a = [52, 55, 59].map(p => note(0, p));
  const b = [59, 52, 55].map(p => note(2, p, { fx: { palmMute: true } }));
  const lane = { notes: [...a, ...b] }, selection = new Set(lane.notes);
  const shape = new Map(a.map((n, i) => [n, [{ string: 3, fret: 2 }, { string: 2, fret: 0 }, { string: 1, fret: 0 }][i]]));
  const accepted = plan(lane, selection, a, shape);
  assert.equal(accepted.error, null);
  applySharedPositionPlan(accepted);
  for (const n of a) assert.deepEqual(n.pos, b.find(m => m.pitch === n.pitch).pos);
  assert.ok(b.every(n => n.fx.palmMute));
  assert.match(positionSelection(lane, new Set([a[0], a[1], b[0], b[1]])).error, /all notes in each chord/);
  b[0].pitch++;
  assert.match(positionSelection(lane, selection).error, /same pitch|same notes/);
}

// Same pitch class in another octave is not the same pitch, nor is another lane.
{
  const a = note(0, 52), b = note(2, 64), lane = { notes: [a, b] };
  assert.match(positionSelection(lane, new Set([a, b])).error, /same pitch|same notes/);
  assert.match(positionSelection({ notes: [a] }, new Set([a, b])).error, /one layer/);
}

// Chord voices are not standalone notes; partial chords and mixed types are
// rejected before any effects or position changes are considered.
{
  const a = note(0, 64), otherA = note(0, 59);
  const b = note(2, 64), otherB = note(2, 60);
  const single = note(4, 64);
  const lane = { notes: [a, otherA, b, otherB, single] };
  const partial = new Set([a, b]);
  assert.match(positionSelection(lane, partial).error, /all notes in each chord/);
  for (const selected of [new Set([a, single]), new Set([a, otherA, single])]) {
    const before = JSON.stringify(lane);
    assert.match(positionSelection(lane, selected).error, /only single notes or only chords/);
    const rejected = plan(lane, selected, [a], new Map([[a, { string: 1, fret: 5 }]]));
    assert.equal(applySharedPositionPlan(rejected), false);
    assert.equal(JSON.stringify(lane), before);
    assert.equal(resetSharedPositions(lane, selected).changed, false);
  }
}

// Collision protection remains for manually entered invalid complete chord shapes.
{
  const a = [52, 55].map(p => note(0, p));
  const b = [52, 55].map(p => note(2, p));
  const lane = { notes: [...a, ...b] }, before = JSON.stringify(lane);
  const rejected = plan(lane, new Set(lane.notes), a,
    new Map([[a[0], { string: 3, fret: 2 }], [a[1], { string: 3, fret: 5 }]]));
  assert.match(rejected.error, /At 0.00 s: E3 and G3 would use the same string/);
  assert.equal(applySharedPositionPlan(rejected), false);
  assert.equal(JSON.stringify(lane), before);
}

// Linked selected notes are validated simultaneously at their proposed positions.
{
  const a = note(0, 57, { slide: 'legato' }), b = note(1, 57);
  const lane = { notes: [a, b] };
  const accepted = plan(lane, new Set([a, b]), [a], new Map([[a, { string: 3, fret: 7 }]]));
  assert.equal(accepted.error, null, 'both sides of the slide can move together');
  const source = note(0, 57, { pos: { string: 2, fret: 2 }, slide: 'legato' });
  const target = note(1, 59), other = note(3, 59);
  const conflict = plan({ notes: [source, target, other] }, new Set([target, other]),
    [target], new Map([[target, { string: 3, fret: 9 }]]));
  assert.match(conflict.error, /slid or hammered onto|cannot follow/);
}

// A pinned legato destination must be fretted, even on the matching string.
{
  const a = note(0, 76, { slide: 'legato' });
  const b = note(1, 64, { pos: { string: 0, fret: 0 } });
  const limits = placementLimits(chordColumns([a, b]), 0, tuning, () => null);
  assert.match(placementFault(limits.get(a), a.pitch, 0, tuning), /cannot follow/);
}

// A trill at the end of the neck can reject an otherwise identical placement.
{
  const a = note(0, 85), b = note(2, 85, { trill: 'whole' });
  const rejected = plan({ notes: [a, b] }, new Set([a, b]), [a], new Map([[a, { string: 0, fret: 21 }]]));
  assert.match(rejected.error, /trills past/);
}

console.log('shared positions: exact pitches, effects, atomicity, local flags, links and reset passed');
