import assert from "node:assert/strict";
import { popPreparation, fingerWaveAt, bendSnapAt } from "../../web/string-techniques.js";
import { ringingMarksAt, releasedBendsAt, GUITAR, fretCentre } from "../../web/fretboard-core.js";
import { stringGlow } from "../../web/string-glow.js";
import { letRingEnd } from "../../web/articulations.js";

const pop = { start: 1, end: 2, slap: "pop" };
assert.equal(popPreparation(pop, 0.8), 0);
assert.ok(popPreparation(pop, 0.98) > popPreparation(pop, 0.93));
assert.ok(popPreparation(pop, 1.01) > popPreparation(pop, 1.07));
assert.equal(popPreparation(pop, 1.2), 0);
assert.equal(popPreparation({ start: 1 }, 0.98), 0);
const peak = (age, kind) => Array.from({ length: 101 }, (_, i) => i / 100)
  .reduce((best, x) => Math.abs(fingerWaveAt(x, 0.3, age, kind)) > Math.abs(fingerWaveAt(best, 0.3, age, kind)) ? x : best, 0);
assert.ok(peak(0.04, "slap") > peak(0.14, "slap"), "slap travels from body toward the hand");
assert.equal(fingerWaveAt(0.2, 0.3, 0.04, "slap"), 0, "slap stops at fretted contact");
assert.equal(fingerWaveAt(0.3, 0.3, 0.04, "finger"), 0, "tapping keeps its contact fixed");
assert.notEqual(fingerWaveAt(0.5, 0.3, 0.04, "finger"), 0);
assert.equal(fingerWaveAt(0.5, 0.3, 0.3, "slap"), 0);
assert.equal(bendSnapAt(0), 1); assert.ok(bendSnapAt(0.035) < 0);
assert.equal(bendSnapAt(0.2), 0);

const note = { start: 0, end: 1, fx: { letRing: true } };
const f = { note, start: 0, strikeStart: 0, soundingEnd: 3.15, string: 2, fret: 7, finger: 1 };
const ringing = ringingMarksAt([f], 1.5)[0];
assert.ok(ringing.ringing); assert.equal(ringing.x, fretCentre(7));
assert.ok(stringGlow(ringing, 1.5) > 0, "ring brightness survives the authored end");
assert.equal(ringingMarksAt([f], 3.2).length, 0);
assert.equal(letRingEnd(note, 2), 2); assert.equal(letRingEnd(note), 3);
assert.equal(letRingEnd(note, undefined, 2.5), 2.5);
const bent = { ...f, soundingEnd: undefined, note: { start: 0, end: 1, bend: "prebend" } };
assert.ok(releasedBendsAt([bent], 1, GUITAR)[0].lift > 0);
assert.ok(releasedBendsAt([bent], 1.035, GUITAR)[0].lift < 0, "released tension snaps past rest briefly");
assert.equal(releasedBendsAt([bent], 1.2).length, 0);
console.log("string techniques OK");
