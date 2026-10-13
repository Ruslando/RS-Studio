// Run: node tests/web/capo-move.test.mjs
// Moving the capo keeps each note on its string; a pin behind the capo lapses and
// comes back when the capo moves back.
import assert from "node:assert/strict";
import { moveCapo, voiceNotes } from "../../web/voicing-core.js";
import { GUITAR, capoLine, dotCentre, fretCentre } from "../../web/fretboard-core.js";

const open = [64, 59, 55, 50, 45, 40];                // app order: string 0 = high E
const tuning = (capo) => open.map((p) => p + capo);
const at = (voiced, n) => voiced.get(n) && `${voiced.get(n).string}:${voiced.get(n).fret}`;

const fifth = { start: 0, end: 0.5, pitch: 45, pos: { string: 5, fret: 5, scope: "local" } };   // A2: low E 5
const low = { start: 1, end: 1.5, pitch: 41, pos: { string: 5, fret: 1, scope: "local" } };     // F2: low E 1
const lane = { capo: 0, notes: [fifth, low], handHolds: [{ t: 0, fret: 7 }] };

assert.equal(moveCapo(lane, 2), true);
let voiced = voiceNotes(lane.notes, tuning(2), Infinity, { capo: 2 });
assert.equal(at(voiced, fifth), "5:3", "same string, fret counted from the capo");
assert.equal(voiced.get(low), undefined, "F2 is behind a capo on 2: nowhere to play it");
assert.equal(low.pos.fret, -1, "its pin is kept, lapsed");
assert.equal(lane.handHolds[0].fret, 5, "the hand stays on the same wood");

moveCapo(lane, 0);
voiced = voiceNotes(lane.notes, tuning(0), Infinity, { capo: 0 });
assert.equal(at(voiced, fifth), "5:5");
assert.equal(at(voiced, low), "5:1", "moving the capo back restores the pin");
assert.equal(moveCapo(lane, 0), false);
// The board draws frets counted from the capo on the real neck.
{
  const s = { ...GUITAR, capo: 2 };
  assert.equal(fretCentre(3, s), dotCentre(5, GUITAR), "fret 3 above a capo on 2 is the 5th fret's space");
  assert.equal(fretCentre(0, s), capoLine(s), "an open string reads on the capo");
  assert.equal(fretCentre(0, GUITAR), -GUITAR.nutDepth / 2, "and on the nut without one");
}
console.log("capo-move: ok");
