// Run: node tests/web/voicing-partial-pin.test.mjs
// A note added to a chord whose other notes are pinned (an imported tab) must not
// move those notes; only the new note is placed, around them.
import assert from "node:assert/strict";
import { voiceNotes } from "../../web/voicing-core.js";

const tuning = [64, 59, 55, 50, 45, 40];              // app order: string 0 = high E
const note = (start, pitch, pos) => ({ start, end: start + 0.4, pitch, ...(pos ? { pos: { ...pos, scope: "local" } } : {}) });
const at = (voiced, n) => voiced.get(n) && `${voiced.get(n).string}:${voiced.get(n).fret}`;

// An A power chord played up at fret 5/7 (the automatic answer would be open A, D 2).
{
  const root = note(0, 45, { string: 5, fret: 5 });   // A2: low E, fret 5
  const fifth = note(0, 52, { string: 4, fret: 7 });  // E3: A string, fret 7
  const added = note(0, 57);                          // A3, no position yet
  const voiced = voiceNotes([root, fifth, added], tuning);
  assert.equal(at(voiced, root), "5:5", "pinned root stays");
  assert.equal(at(voiced, fifth), "4:7", "pinned fifth stays");
  const pos = voiced.get(added);
  assert.ok(pos, "the added note is placed");
  assert.ok(![5, 4].includes(pos.string), "the added note does not take a pinned string");
  assert.equal(tuning[pos.string] + pos.fret, 57, "the added note sounds its pitch");
}

// The added note's only free string is taken: the pins still win.
{
  const low = note(0, 40, { string: 5, fret: 0 });    // E2: open low E
  const added = note(0, 41);                          // F2: only playable on low E
  const voiced = voiceNotes([low, added], tuning);
  assert.equal(at(voiced, low), "5:0", "the pinned open note keeps its string");
  assert.equal(voiced.get(added), undefined, "the added note is left unplaced, not the pin");
}

console.log("voicing-partial-pin: ok");
