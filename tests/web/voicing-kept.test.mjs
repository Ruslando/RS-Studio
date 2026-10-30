// Run: node tests/web/voicing-kept.test.mjs
// Once voiced, a note keeps its position (note.auto): adding a note voices only the
// new one, around the rest. The hand is planned anew every time.
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

// An override wins over a kept position; taking it off brings the kept one back.
{
  const n = note(20, 57), notes = [n];
  keepVoicing(notes, voice(notes), tuning);
  const kept = n.auto;
  n.pos = { string: 2, fret: 2, scope: "local" };          // A3 on the G string, fret 2
  const found = voice(notes);
  assert.equal(found.voiced.get(n).string, 2);
  keepVoicing(notes, found, tuning);
  assert.equal(n.auto, kept, "the kept answer waits under the override");
  delete n.pos;
  assert.equal(voice(notes).voiced.get(n).string, kept.string, "back to where it was");
}

// A note moved onto another one's onset joins its column: the chord is voiced anew.
{
  const a = note(40, 57), b = note(41, 60), notes = [a, b];
  keepVoicing(notes, voice(notes), tuning);
  b.start = a.start; b.end = a.end;
  const found = voice(notes);
  const fresh = voice(notes.map(({ auto, ...n }) => n));
  assert.deepEqual(where(found, notes), where(fresh, fresh.voiced.keys().toArray()), "voiced like a new chord");
  keepVoicing(notes, found, tuning);
  assert.equal(a.auto.n, 2, "kept as a chord of two");
}

// The hand is not kept: a stale stored hand is ignored and dropped on the next keep.
{
  const notes = run.slice(0, 8).map((n) => ({ ...n, start: n.start + 50, end: n.end + 50 }));
  const plain = voice(notes);
  keepVoicing(notes, plain, tuning);
  assert.equal(notes[3].auto.hand, undefined, "no hand is kept");
  const hand = plain.seats.get(notes[3]);
  notes.forEach((n) => { n.auto = { ...n.auto, hand: hand + 3, finger: 4 }; });   // an older project
  const again = voice(notes);
  assert.equal(again.seats.get(notes[3]), hand, "the stored hand decides nothing");
  assert.equal(keepVoicing(notes, again, tuning), true, "and is dropped");
  assert.equal(notes[3].auto.hand, undefined);
}

// Moving the capo moves a kept position with the strings.
{
  const n = { ...note(30, 57), auto: { string: 3, fret: 7 } };
  moveCapo({ capo: 0, notes: [n] }, 2);
  assert.deepEqual(n.auto, { string: 3, fret: 5 });
}

// A chord slides into a kept chord on other strings: the target follows the slide.
{
  const a = { ...note(70, 44), slide: "shift" }, b = { ...note(70, 58), slide: "shift" };
  a.auto = { string: 5, fret: 4, hand: 3, n: 2 }; b.auto = { string: 2, fret: 3, hand: 3, n: 2 };
  const c = note(70.5, 46), d = note(70.5, 61);
  c.auto = { string: 5, fret: 6, hand: 1, n: 2 }; d.auto = { string: 1, fret: 2, hand: 1, n: 2 };
  const found = voice([a, b, c, d]);
  assert.deepEqual([c, d].map((n) => found.voiced.get(n).string), [5, 2], "the slides keep their strings");
  assert.deepEqual([a, b].map((n) => found.voiced.get(n).string), [5, 2], "the source stays");
}

console.log("voicing-kept: ok");
