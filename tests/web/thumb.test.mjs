import assert from "node:assert/strict";
import { THUMB, NO_FINGER, assignFingers, fingeringChoices, handForShape, voiceNotesFingered } from "../../web/voicing-core.js";
import { fingerLabel } from "../../web/fretboard-core.js";

// Frets low E -> high e; a shape is Map(note -> {string, fret}) with string 0 = high e.
const tuning = [64, 59, 55, 50, 45, 40];
const shape = (frets) => new Map(frets.flatMap((fret, i) => fret == null ? [] : [[
  { pitch: tuning[5 - i] + fret, start: 0, end: 1 }, { string: 5 - i, fret }]]));
const lowE = (s) => [...s].find(([, p]) => p.string === 5)[0];
const thumbed = (s) => fingeringChoices(s).filter((c) => [...c.values()].includes(THUMB));

// Offered where EOF puts it: low E over the neck, A left out, on the lowest other fret.
for (const frets of [[2, null, 0, 2, 3, 2], [1, null, 3, 2, 1, 1], [3, null, 5, 4, 3, 3], [1, null, 1, 2, 3, 3], [1, null, 1, 2, 3, null]]) {
  const s = shape(frets), choices = thumbed(s);
  assert.ok(choices.length, `thumb offered for ${frets}`);
  assert.ok(choices.every((c) => c.get(lowE(s)) === THUMB && [...c.values()].filter((f) => f === THUMB).length === 1));
  assert.notEqual(assignFingers(s).get(lowE(s)), THUMB, `never the engine's own pick for ${frets}`);
  const chosen = choices[0];
  const held = handForShape(s, null, undefined, chosen).fingers;
  assert.ok([...chosen].every(([n, f]) => held.get(n) === f), "a chosen thumb holds");
}
// Not offered: the A string is played, the low E is above the other notes, or no other note is fretted.
for (const frets of [[1, 3, 3, 2, 1, 1], [3, 2, 0, 0, 0, 3], [3, null, 1, 2, null, null], [2, null, 0, 0, null, null], [null, 3, 2, 0, 1, 0]])
  assert.equal(thumbed(shape(frets)).length, 0, `no thumb for ${frets}`);

// Open strings carry no finger (-1), as in Rocksmith; 0 is only ever the thumb.
const d = shape([2, null, 0, 2, 3, 2]);
assert.equal(assignFingers(d).get([...d].find(([, p]) => p.fret === 0)[0]), NO_FINGER);
assert.deepEqual([fingerLabel(THUMB, ""), fingerLabel(NO_FINGER, ""), fingerLabel(3, "")], ["T", "", "3"]);

// A thumb chosen on a note (pos.finger 0) reaches the voiced result, which the export reads.
const notes = [...d].map(([n, p], i) => ({ ...n, id: `n${i}`, pos: { ...p, scope: "local", follow: "here" } }));
const choice = thumbed(d)[0], byString = new Map([...d].map(([n, p]) => [p.string, choice.get(n)]));
for (const n of notes) if (n.pos.fret > 0) n.pos.finger = byString.get(n.pos.string);
const played = voiceNotesFingered(notes, tuning);
assert.equal(played.fingers.get(notes.find((n) => n.pos.string === 5)), THUMB);
assert.equal(played.fingers.get(notes.find((n) => n.pos.fret === 0)), NO_FINGER);
console.log("thumb: a choice where EOF uses it, never automatic; open strings -1");
