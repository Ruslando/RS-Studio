import assert from 'node:assert/strict';
import { voiceNotesFingered } from '../../web/voicing-core.js';
import { changedHandAnchor, handAnchorAt, initialHandAnchors, movedHandAnchor, nearestHandStart, normalizeHandAnchors } from '../../web/hand-anchor-state.js';
import { noteHandAnchors, pasteHandAnchors } from '../../web/clipboard-fingering.js';
import { mirrorReferenceHands, referenceHands } from '../../web/reference-hands.js';

const tuning = [64, 59, 55, 50, 45, 40];
const notes = [5, 5, 7].map((fret, i) => ({ id: `n${i}`, pitch: 64 + fret, start: [.13, .77, 1.49][i],
  end: [.6, 1.2, 2][i], pos: { string: 0, fret } }));
const raw = notes.map((n, i) => ({ id: `a${i}`, t: n.start, fret: [3, 3, 5][i] }));
const anchors = normalizeHandAnchors(notes, raw);
assert.deepEqual(anchors.map(h => [h.t, h.fret]), [[.13, 3], [1.49, 5]]);
const changed = changedHandAnchor(notes, anchors, .13, 4);
assert.deepEqual(notes.map(n => handAnchorAt(changed, n.start).fret), [4, 4, 5]);
const solve = holds => voiceNotesFingered(notes, tuning, Infinity, { holds, anchorChanges: true });
const found = solve(changed);
assert.deepEqual(notes.map(n => found.seats.get(n)), [4, 4, 5], 'a changed anchor owns the full range');
assert.deepEqual(notes.map(n => found.voiced.get(n)), notes.map(n => n.pos), 'hand edits never move placed notes');
assert.equal(found.handConflicts.size, 0);
assert.deepEqual(initialHandAnchors(notes, solve(anchors).seats, raw), anchors, 'migration captures only actual changes');
assert.deepEqual(normalizeHandAnchors(notes, JSON.parse(JSON.stringify(changed))), changed);

const removed = changedHandAnchor(notes, changed, 1.49, null);
assert.deepEqual(notes.map(n => handAnchorAt(removed, n.start).fret), [4, 4, 4]);
assert.deepEqual(changedHandAnchor(notes, removed, .13, null), removed, 'the initial value cannot be removed');
assert.deepEqual(movedHandAnchor(notes, changed, changed[0].id, 1.49), changed, 'the initial value cannot move');
assert.equal(nearestHandStart(notes, .83), .77, 'dragging uses actual off-grid onsets');
const moved = movedHandAnchor(notes, changed, changed[1].id, .83);
assert.deepEqual(moved.map(h => [h.t, h.fret]), [[.13, 4], [.77, 5]]);
assert.deepEqual(movedHandAnchor(notes, moved, moved[1].id, .13), moved, 'dragging cannot replace the initial value');
const occupied = [...anchors, { id: 'later', t: .77, fret: 2 }].sort((a, b) => a.t - b.t);
assert.deepEqual(movedHandAnchor(notes, occupied, 'a2', .77).map(h => [h.id, h.t, h.fret]),
  [['a0', .13, 3], ['a2', .77, 5]], 'a dragged flag replaces the occupied destination');
assert.deepEqual(normalizeHandAnchors([], anchors), []);
const duplicateIds = normalizeHandAnchors(notes, raw.map(h => ({ ...h, id: 'old-duplicate' })));
assert.equal(new Set(duplicateIds.map(h => h.id)).size, duplicateIds.length, 'legacy duplicate ids cannot make two flags move or delete together');
assert.deepEqual(normalizeHandAnchors(notes, duplicateIds), duplicateIds);

const unreachable = changedHandAnchor(notes, anchors, .13, 15);
const invalid = solve(unreachable);
assert.deepEqual(notes.map(n => invalid.seats.get(n)), [15, 15, 5], 'an unreachable hand cannot silently choose another anchor');
assert.equal(invalid.handConflicts.size, 2);
const longReach = { ...notes[0], pitch: tuning[0] + 10, pos: { string: 0, fret: 10 } };
const extended = voiceNotesFingered([longReach], tuning, Infinity, {
  holds: [{ t: longReach.start, fret: 1 }], anchorChanges: true,
});
assert.equal(extended.seats.get(longReach), 1, 'a reach beyond six frets preserves the chosen hand');
assert.equal(extended.handConflicts.size, 0, 'long reaches are no longer rejected by the six-fret policy');
notes[0].finger = 1;
const typed = solve(changed);
assert.equal(typed.seats.get(notes[0]), 4);
assert.equal(typed.fingers.get(notes[0]), 1);
assert.ok(typed.handConflicts.has(notes[0]), 'an explicit incompatible finger is reported');
delete notes[0].finger;
const open = { id: 'open', start: .77, end: 1.2, pitch: 64, pos: { string: 0, fret: 0 } };
const openFound = voiceNotesFingered([notes[0], open, notes[2]], tuning, Infinity, { holds: changed, anchorChanges: true });
assert.equal(openFound.seats.get(open), 4, 'open strings retain the active hand');

assert.deepEqual([...noteHandAnchors(notes, anchors, true).values()], [3, 3, 5], 'copies capture inherited hand values');
const target = { handAnchorVersion: 1, notes: [...notes, { ...notes[2], id: 'tail', start: 3, end: 4 }], handHolds: anchors };
let uid = 0;
pasteHandAnchors(target, [{ handAnchor: 6 }], [{ start: .77, end: 1.2 }], () => `p${++uid}`);
assert.deepEqual(target.handHolds.map(h => [h.t, h.fret]), [[.13, 3], [.77, 6], [1.49, 5]], 'pasting preserves later changes');
const within = { handAnchorVersion: 1, notes: target.notes, handHolds: [anchors[0]] };
pasteHandAnchors(within, [{ handAnchor: 4 }], [{ start: .77, end: 1.2 }], () => `p${++uid}`);
assert.deepEqual(within.handHolds.map(h => [h.t, h.fret]), [[.13, 3], [.77, 4], [1.49, 3]], 'the previous target hand resumes after a pasted range');

const clock = { beatAt: t => t, timeAt: t => t };
const lane = { handAnchorVersion: 1, notes: [0, 4, 8].map((start, i) => ({ id: `r${i}`, start, end: start + .8, pitch: 69 })),
  handHolds: [{ id: 'start', t: 0, fret: 3 }, { id: 'source', t: 4, fret: 5 }] };
const box = { t0: 8, t1: 9, pLo: 69, pHi: 69 };
const pattern = referenceHands(lane.notes, lane.handHolds, box, 8, clock, .1, true);
assert.equal(pattern[0].fret, 5);
assert.equal(pattern[0].inherited, true, 'a reference carries the hand active at its first note');
const group = { rt0: 0, rt1: 1, pLo: 69, pHi: 69, anchors: [0, 8] };
mirrorReferenceHands(lane, group, 1, [{ dt: 0, fret: 4 }], clock, .1, () => `r${++uid}`);
assert.equal(handAnchorAt(lane.handHolds, 8).fret, 4);
assert.equal(handAnchorAt(lane.handHolds, 4).fret, 5, 'editing an inherited reference value does not delete the preceding change');
console.log('hand changes: ranges, migration, off-grid moves, protected initial value, conflicts, clipboard and references passed');
