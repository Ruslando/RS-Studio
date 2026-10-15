import assert from "node:assert/strict";
import { articulation, eventOffsetAt, harmonicOffset, playbackEvents, playSampleEvent } from "../../web/playback-effects.js";

const n = (extra = {}) => ({ start: 1, end: 2, pitch: 62, pos: { string: 2, fret: 7 }, ...extra });
const plan = (note, bpm = 120) => playbackEvents([note], () => bpm);
const offset = (note, sec) => eventOffsetAt(plan(note)[0], sec);
assert.equal(offset(n({ whammy: "dip" }), 0.5), -2);
assert.equal(offset(n({ whammy: "dip" }), 1), 0);
assert.equal(offset(n({ whammy: "dive" }), 1), -2);
assert.equal(offset(n({ trill: "whole" }), 0.125), 2);
assert.equal(offset(n({ trill: "half" }), 0.25), 0);
assert.equal(eventOffsetAt(plan(n({ trill: "half" }), 60)[0], 0.25), 1);
for (const [rate, count] of [["8", 4], ["16", 8], ["32", 16]]) {
  assert.equal(plan(n({ tremPick: rate })).length, count);
  assert.equal(plan(n({ tremPick: rate }), 60).length, count / 2);
}
const grace = plan(n({ grace: "whole" }));
assert.equal(grace.length, 2);
assert.equal(grace[0].pitch, 60);
assert.equal(grace[0].start + grace[0].duration, 1);
assert.equal(plan(n({ start: 0, grace: "half" })).length, 1, "no negative playback times");
assert.equal(plan(n({ fx: { dead: true } }))[0].duration, 0.045);
assert.equal(plan(n({ fx: { staccato: true } }))[0].duration, 0.18);
assert.equal(plan(n({ fx: { palmMute: true } }))[0].duration, 0.16);
assert.ok(articulation(n({ fx: { ghost: true } })).velocity < articulation(n()).velocity);
assert.ok(articulation(n({ fx: { accent: true } })).velocity > articulation(n()).velocity);
const ring = n({ fx: { letRing: true } });
assert.equal(playbackEvents([ring, n({ start: 3, end: 4 })])[0].duration, 2);
assert.equal(playbackEvents([ring], undefined, 2.5)[0].duration, 1.5);
assert.equal(harmonicOffset(n({ harmonic: "natural", pos: { fret: 12 } })), 0);
assert.equal(harmonicOffset(n({ harmonic: "natural", pos: { fret: 5 } })), 19);
assert.equal(harmonicOffset(n({ harmonic: "pinch" })), 12);
for (const stroke of ["up", "down"]) {
  const chord = [45, 52, 57].map((pitch) => n({ pitch, stroke }));
  const events = playbackEvents(chord);
  assert.equal(events[0].pitch, stroke === "up" ? 57 : 45);
  assert.ok(events[2].start > events[0].start);
}
const hammer = playbackEvents([n(), n({ start: 2, end: 3, pitch: 64, fx: { hammer: true } })]);
assert.equal(hammer.length, 1, "hammer/pull-off carries the source without a new pick");
assert.equal(hammer[0].duration, 2);
assert.equal(eventOffsetAt(hammer[0], 1.1), 2);
const slide = playbackEvents([n({ slide: "legato" }), n({ start: 2, end: 3, pitch: 64 })]);
assert.equal(slide.length, 1);
assert.equal(eventOffsetAt(slide[0], 1.1), 2);
assert.equal(eventOffsetAt(plan(n({ bend: "full", whammy: "dip" }))[0], 0.5), 0);

// A minimal sampler double verifies source-local automation and pause ownership.
const calls = [], filters = [];
globalThis.Tone = {
  Frequency: (pitch) => ({ toNote: () => pitch, toFrequency: () => 440 * 2 ** ((pitch - 69) / 12) }),
  Filter: class {
    constructor(options) { this.options = options; filters.push(this); }
    connect() {} dispose() { this.disposed = true; }
  },
};
const synth = { attack: 0, output: {}, _activeSources: new Map(),
  triggerAttack(pitch, when, velocity) {
    calls.push({ pitch, when, velocity, attack: this.attack });
    const src = { playbackRate: { value: 1, setValueAtTime() {}, setValueCurveAtTime(curve, at, dur) {
      calls.push({ curve, at, dur });
    } }, disconnect() {}, connect() {}, stop(at) { this.stopped = at; }, onended() {} };
    this._activeSources.set(pitch, [src]);
  },
};
playSampleEvent(synth, plan(n({ fx: { palmMute: true } }))[0], 10, 10.02, 0.5);
const source = synth._activeSources.get(62)[0];
assert.equal(source.stopped, 10.34);
assert.equal(source.fadeOut, 0.07);
assert.equal(filters[0].options.type, "lowpass");
source.onended(); assert.ok(filters[0].disposed);
assert.equal(synth.attack, 0);
playSampleEvent(synth, plan(n({ whammy: "dip" }))[0], 11, 11.02, 1);
assert.ok(calls.some((c) => c.curve?.length > 2));
console.log("playback effects OK");
