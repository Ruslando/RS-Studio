import assert from "node:assert/strict";
import { loadNotePositions, keepVoicing, voiceNotesFingered, writeColumnOverride } from "../../web/voicing-core.js";
import { overrideResetPreview } from "../../web/override-reset.js";

const original = [
  { id: "a", pitch: 45, start: 0, end: 1, pos: { string: 5, fret: 5 } },
  { id: "b", pitch: 55, start: 0, end: 1, pos: { string: 3, fret: 5 } },
];
const voices = [{ pitch: 45 }, { pitch: 60 }];
const choice = { notes: voices, shape: new Map([[voices[0], { string: 4, fret: 0 }], [voices[1], { string: 2, fret: 5 }]]) };
const changed = writeColumnOverride(original, original, choice, {});
assert.ok(changed.column.every(n => !('written' in n)), 'a chosen shape stores no restoration snapshot');
// Old saves may still contain a snapshot; it must never become the current chord.
for (const note of changed.column) note.written = [{ id: 'old', pitch: 30, start: 0, end: 1 }];
const lane = { notes: changed.notes, handHolds: [{ t: 0, fret: 7 }, { t: 2, fret: 3 }] };
const before = structuredClone(lane);
const expected = changed.notes.map(({ pos, written, ...note }) => note);
const preview = overrideResetPreview(lane, changed.column, 0);
assert.deepEqual(preview.notes, expected, "preview clears positions and keeps the current tones");
assert.deepEqual(preview.handHolds, [{ t: 2, fret: 3 }]);
assert.deepEqual(lane, before, "preview must not change live state");
const reset = writeColumnOverride(lane.notes, changed.column, null, {});
assert.deepEqual(reset.notes, expected, "reset returns the same shape as its preview");
assert.strictEqual(reset.notes, lane.notes, 'recalculate retains the current note objects and ids');
const tuning = [64, 59, 55, 50, 45, 40];
keepVoicing(reset.notes, voiceNotesFingered(reset.notes, tuning), tuning);
assert.ok(reset.notes.every(n => n.pos), 'the newly calculated positions are stored');
assert.deepEqual(reset.notes.map(n => n.pitch), [45, 60], 'recalculate cannot revive the removed tone');
const saved = JSON.parse(JSON.stringify(reset.notes));
assert.deepEqual(loadNotePositions(saved).map(n => [n.id, n.pitch, n.pos.string, n.pos.fret]),
  saved.map(n => [n.id, n.pitch, n.pos.string, n.pos.fret]), 'save and reload retain the new positions');

const exact = [{ id: 'exact', start: 0, end: 1, pitch: 52, pos: { string: 3, fret: 2 } }];
const voice = { pitch: 52 };
const moved = writeColumnOverride(exact, exact, { notes: [voice], shape: new Map([[voice, { string: 4, fret: 7 }]]) }, {});
assert.strictEqual(moved.notes, exact, 'a position-only choice keeps the same notes');
assert.equal(moved.column[0].pos.string, 4);
assert.ok(!('written' in moved.column[0]), 'a position-only choice creates no restoration data either');
writeColumnOverride(exact, moved.column, null, {});
assert.equal(exact[0].pitch, 52);
assert.equal(exact[0].pos, undefined, 'recalculate forgets the position instead of restoring the earlier string');
console.log("override reset tests passed");
