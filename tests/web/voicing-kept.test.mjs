// Run: node tests/web/voicing-kept.test.mjs
// Once voiced, a note keeps its position (note.pos), however it got it: adding a note
// voices only the new one, around the rest. The hand is planned anew every time.
import assert from "node:assert/strict";
import { keepVoicing, moveCapo, voiceNotesFingered } from "../../web/voicing-core.js";

const tuning = [64, 59, 55, 50, 45, 40];              // app order: string 0 = high E
const note = (start, pitch) => ({ start, end: start + 0.2, pitch });
const voice = (notes) => voiceNotesFingered(notes, tuning, Infinity, { bars: [0, 2, 4, 6, 8] });
const where = (found, notes, hand = true) => notes.map((n) => {
  const p = found.voiced.get(n);
  return p ? `${p.string}:${p.fret}` + (hand ? `@${found.seats.get(n)}` : "") : "-";
});

// A minor pentatonic around fret 5, then a high A (fret 17 on the high E) in the middle.
const run = [45, 48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 67, 64, 62, 60, 57]
  .map((pitch, i) => note(i * 0.25, pitch));
const first = voice(run);
assert.equal(keepVoicing(run, first, tuning), true, "the first solve is kept");
assert.equal(keepVoicing(run, first, tuning), false, "keeping it again changes nothing");
const before = where(first, run, false);

const high = note(2.1, 81);
const lane = [...run, high];
const second = voice(lane);
assert.deepEqual(where(second, run, false), before, "no kept note moves");
assert.equal(tuning[second.voiced.get(high).string] + second.voiced.get(high).fret, 81, "the new note is placed");
keepVoicing(lane, second, tuning);
assert.deepEqual(where(voice(lane), lane), where(second, lane), "solving again is stable");

// A note that changes pitch no longer fits its kept place and is voiced again.
{
  const moved = run[4];
  moved.pitch += 1;
  const p = voice(lane).voiced.get(moved);
  assert.equal(tuning[p.string] + p.fret, moved.pitch, "re-voiced at its new pitch");
  moved.pitch -= 1;
}

// A note joining a kept one makes a chord: the column is voiced as a whole again.
{
  const solo = note(10, 57), lone = [solo];
  keepVoicing(lone, voice(lone), tuning);
  const partner = note(10, 64), chord = [solo, partner];
  const found = voice(chord);
  const strings = chord.map((n) => found.voiced.get(n).string);
  assert.equal(new Set(strings).size, 2, "two notes, two strings");
}

// A position set by hand is a position like any other: kept, and not rewritten.
{
  const n = note(20, 57), notes = [n];
  n.pos = { string: 2, fret: 2, scope: "local" };          // A3 on the G string, fret 2
  const found = voice(notes);
  assert.equal(found.voiced.get(n).string, 2);
  assert.equal(keepVoicing(notes, found, tuning), false, "nothing to write");
  delete n.pos;                                            // Recalculate positions
  keepVoicing(notes, voice(notes), tuning);
  assert.ok(n.pos, "placed again and kept");
}

// A note moved onto another one's onset keeps its position: both stay where they were.
{
  const a = note(40, 57), b = note(41, 60), notes = [a, b];
  keepVoicing(notes, voice(notes), tuning);
  const was = [a.pos, b.pos];
  b.start = a.start; b.end = a.end;
  const found = voice(notes);
  if (was[0].string !== was[1].string)
    assert.deepEqual(notes.map((n) => found.voiced.get(n)), was.map(({ string, fret }) => ({ string, fret })));
}

// What is stored is what is played: a position overruled after the solve (a reference
// plays its first occurrence's) is written over. `before` runs once, ahead of it.
{
  const n = { ...note(60, 57), pos: { string: 4, fret: 12 } }, m = { ...note(61, 57), pos: { string: 2, fret: 2 } };
  let calls = 0;
  const found = { voiced: new Map([[n, { string: 2, fret: 2 }], [m, { string: 2, fret: 2 }]]) };
  assert.equal(keepVoicing([n, m], found, tuning, () => calls++), true);
  assert.deepEqual(n.pos, { string: 2, fret: 2 });
  assert.equal(calls, 1);
  assert.equal(keepVoicing([n, m], found, tuning, () => calls++), false);
  assert.equal(calls, 1, "no write, no call");
}

// Moving the capo moves a position with the strings.
{
  const n = { ...note(30, 57), pos: { string: 3, fret: 7 } };
  moveCapo({ capo: 0, notes: [n] }, 2);
  assert.deepEqual(n.pos, { string: 3, fret: 5 });
}

console.log("voicing-kept: ok");
