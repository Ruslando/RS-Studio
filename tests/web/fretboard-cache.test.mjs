import assert from "node:assert/strict";
import { fretboardHandKey } from "../../web/fretboard-cache.js";
import { chordColumns, voiceNotesFingered, writeColumnOverride } from "../../web/voicing-core.js";

const tuning = [64, 59, 55, 50, 45, 40];
const lane = { id: "edit", tuning: "guitar6", notes: [
  { id: "n1", start: 0, end: .8, pitch: 52,
    pos: { string: 3, fret: 2, scope: "local", influencePrevious: false,
      influenceNext: false, adaptPrevious: false, adaptNext: false } },
  { id: "n2", start: 1, end: 1.8, pitch: 55 },
] };
const key = l => fretboardHandKey(l, 4, "0:60");
const oldKey = key(lane);
assert.equal(key(lane), oldKey, "unchanged input reuses the fingering");

// Saving and reopening keeps ids, timing, count and revision, but replaces the
// objects. The old grip's note cannot be used by columnOf or reset in the new lane.
const restored = JSON.parse(JSON.stringify(lane));
assert.notEqual(key(restored), oldKey, "reload invalidates grips pointing at the old project");
assert.ok(!restored.notes.includes(lane.notes[0]), "old focus would not be editable after reload");
const { voiced } = voiceNotesFingered(restored.notes, tuning, Infinity, { bars: [0, 4] });
const column = chordColumns(restored.notes)[0];
assert.deepEqual(voiced.get(column.notes[0]), { string: 3, fret: 2 });
assert.ok(column.notes.some(n => n.pos), "the restored column exposes its override");
writeColumnOverride(restored.notes, column.notes, null, {});
assert.equal(restored.notes[0].pos, undefined, "the restored override can be reset");
assert.ok(lane.notes[0].pos, "reset acts on the current project only");

const beforeReplacement = key(restored);
restored.notes = structuredClone(lane.notes);
assert.notEqual(key(restored), beforeReplacement,
  "replacing a same-length note array also invalidates old grip targets");
assert.notEqual(fretboardHandKey(lane, 5, "0:60"), oldKey, "edits still invalidate grips");
assert.notEqual(fretboardHandKey(lane, 4, "0:90"), oldKey, "tempo changes still invalidate grips");
console.log("fretboard cache: reload, note replacement and restored override reset passed");
