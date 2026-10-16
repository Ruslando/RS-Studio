import assert from "node:assert/strict";
import { popPreparation, popThicknessAt, popLiftAt, fingerPulseAt, fingerLightAt, fingerWaveAt, bendSnapAt } from "../../web/string-techniques.js";
import { ringingMarksAt, releasedBendsAt, releasedStringsAt, stringContactAt, handAt, handColumns, bendLift, GUITAR, fretCentre } from "../../web/fretboard-core.js";
import { stringGlow } from "../../web/string-glow.js";
import { letRingEnd } from "../../web/articulations.js";

const pop = { start: 1, end: 2, slap: "pop" };
assert.equal(popPreparation(pop, 0.8), 0);
assert.ok(popPreparation(pop, 0.98) > popPreparation(pop, 0.93));
assert.ok(popPreparation(pop, 1.01) > popPreparation(pop, 1.07));
assert.equal(popPreparation(pop, 1.2), 0);
assert.equal(popPreparation({ start: 1 }, 0.98), 0);
assert.ok(popPreparation(pop, 1.025) < 0, "pop rebounds after release");
assert.ok(popThicknessAt(0.3, 0.3, 1) > popThicknessAt(0.1, 0.3, 1), "depth peaks at the pulling finger");
assert.equal(popThicknessAt(0, 0.3, 1), 1, "nut stays anchored");
assert.equal(popThicknessAt(1, 0.3, 1), 1, "bridge stays anchored");
assert.equal(popThicknessAt(0.2, 0.8, 1, 0.4), 1, "string behind the fretting finger stays unchanged");
assert.equal(popThicknessAt(0.4, 0.8, 1, 0.4), 1, "fretting finger anchors the pop");
assert.ok(popThicknessAt(0.8, 0.8, 1, 0.4) > popThicknessAt(0.6, 0.8, 1, 0.4),
  "string grows toward the picking hand near the body");
assert.ok(popThicknessAt(0.3, 0.3, popPreparation(pop, 1.025)) > 0, "rebound keeps a positive thickness");
assert.equal(fingerLightAt(0.1, 0.3, 0.048, "hammer"), 0, "hammer light never travels left");
assert.ok(fingerLightAt(0.5, 0.3, 0.048, "hammer") > 0.7, "hammer front travels right");
assert.ok(fingerLightAt(0.1, 0.3, 0.048, "tap") > 0.7, "tap travels left too");
assert.ok(Math.abs(fingerLightAt(0.1, 0.3, 0.048, "tap") - fingerLightAt(0.5, 0.3, 0.048, "tap")) < 1e-10);
assert.equal(fingerLightAt(0.5, 0.3, 0.048, "pull"), 0, "no pull-off pulse");
assert.equal(fingerLightAt(0.5, 0.3, -0.01, "tap"), 0);
assert.equal(fingerLightAt(0.5, 0.3, 0.25, "tap"), 0);
const peak = (age, kind) => Array.from({ length: 101 }, (_, i) => i / 100)
  .reduce((best, x) => Math.abs(fingerWaveAt(x, 0.3, age, kind)) > Math.abs(fingerWaveAt(best, 0.3, age, kind)) ? x : best, 0);
assert.ok(peak(0.04, "slap") > peak(0.14, "slap"), "slap travels from body toward the hand");
assert.equal(fingerWaveAt(0.2, 0.3, 0.04, "slap"), 0, "slap stops at fretted contact");
assert.equal(fingerWaveAt(0.3, 0.3, 0.04, "finger"), 0, "tapping keeps its contact fixed");
assert.equal(fingerWaveAt(0.5, 0.3, 0.04, "finger"), 0, "finger energy does not move the string");
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

// Fading chord markers must not freeze one string while another already snaps.
const chordFingers = [
  { ...bent, finger: 1, string: 1 },
  { ...bent, finger: 1, string: 2 },
  { ...bent, finger: 3, string: 4 },
];
const chord = handColumns([{ start: 0, end: 1, fingers: chordFingers }]);
for (const t of [1, 1.01, 1.035, 1.09, 1.17]) {
  const now = { t, at: handAt(chord, t, 0.5), releases: releasedStringsAt(chordFingers, t) };
  for (const finger of chordFingers) {
    const contact = stringContactAt(now, finger.string);
    assert.equal(contact.lift, bendLift(finger, 1, 6) * bendSnapAt(t - 1),
      "all chord strings snap on the same release clock, regardless of marker grouping");
  }
}
// Other held notes and previews cannot delay a released string's return.
const heldElsewhere = { ...bent, string: 5, note: { start: 0, end: 2 }, lift: 0 };
const fading = { ...bent, releasing: true, lift: 1 };
const preview = { ...bent, pressed: false, note: { start: 1.1, end: 2 }, lift: 0 };
for (const marks of [[fading, heldElsewhere], [preview, heldElsewhere]]) {
  const releases = releasedStringsAt([bent], 1.035);
  assert.equal(stringContactAt({ t: 1.035, at: { pressed: true, marks }, releases }, 2), releases[0]);
}
// Vibrato may finish above rest, and releases from that exact phase too.
const vibrato = { ...bent, note: { start: 0, end: 1, fx: { vibrato: true } } };
const displaced = bendLift(vibrato, 1, 6);
assert.ok(displaced > 0);
assert.equal(releasedStringsAt([vibrato], 1)[0].lift, displaced);
assert.ok(releasedStringsAt([vibrato], 1.035)[0].lift < 0);
assert.equal(releasedStringsAt([vibrato], 1.2).length, 0);
const restingVibrato = { ...vibrato, note: { ...vibrato.note, end: 2 / 5.5 } };
assert.ok(Math.abs(releasedStringsAt([restingVibrato], restingVibrato.note.end)[0].lift) < 1e-10);
// A new pressed note takes precedence over the previous string's release.
const active = { ...bent, start: 1, note: { start: 1, end: 2 }, lift: 0 };
assert.equal(stringContactAt({ t: 1.035, at: { pressed: true, marks: [active] },
  releases: releasedStringsAt([bent], 1.035) }, 2), active);
// Ordinary and let-ring strings also retain a contact during the light's release.
assert.equal(releasedStringsAt([{ ...bent, note: { start: 0, end: 1 } }], 1.05)[0].lift, 0);
assert.ok(stringGlow(releasedStringsAt([f], 3.16)[0], 3.16) > 0);
console.log("chord, vibrato and sustain releases OK");

// Pop depth spans the sounding segment; the fretted side never moves.
for (const amount of [1, -0.4]) {
  assert.equal(popLiftAt(0.2, 0.85, amount, 0.4), 0);
  assert.equal(popLiftAt(0.4, 0.85, amount, 0.4), 0);
  assert.equal(popLiftAt(1, 0.85, amount, 0.4), 0);
  for (const x of [0.45, 0.6, 0.8, 0.95])
    assert.ok(popLiftAt(x, 0.85, amount, 0.4) * amount > 0,
      "the whole segment lifts and rebounds with the pulling finger");
}
assert.ok(popPreparation(pop, 0.999) > 0.99, "lift is prepared before the strike");
assert.equal(popPreparation(pop, 1), 1, "release begins from the raised position");
assert.ok(popPreparation(pop, 1.018) < -0.39, "string strikes down promptly after release");
assert.ok(Math.abs(popPreparation(pop, 1.1)) < 0.03, "rebound settles quickly");
assert.equal(popPreparation(pop, 1.141), 0);

const hammerImpact = { start: 1, hammerMotion: "hammer", note: { start: 1, end: 2 } };
const tapImpact = { start: 1, note: { start: 1, end: 2, slap: "tap" } };
assert.equal(fingerPulseAt(hammerImpact, 1.05).rings, 1);
assert.equal(fingerPulseAt(tapImpact, 1.05).rings, 2);
assert.ok(fingerPulseAt(tapImpact, 1.2).radius > fingerPulseAt(hammerImpact, 1.2).radius);
for (const impact of [hammerImpact, tapImpact]) {
  assert.equal(fingerPulseAt(impact, 0.99), null);
  assert.equal(fingerPulseAt(impact, 1).strength, 1);
  assert.ok(fingerPulseAt(impact, 1.1).strength < fingerPulseAt(impact, 1.02).strength);
  assert.equal(fingerPulseAt(impact, 1.41), null);
  assert.equal(fingerPulseAt({ ...impact, releasing: true }, 1.02), null);
}
assert.equal(fingerPulseAt({ ...hammerImpact, hammerMotion: "pull" }, 1.02), null);
assert.equal(fingerPulseAt({ start: 1, note: { start: 1, end: 2 } }, 1.02), null,
  "ordinary picked notes do not get a marker pulse");
console.log("technique pulses and projected pop depth OK");
