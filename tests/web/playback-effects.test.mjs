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
assert.equal(plan(n({ fx: { dead: true } }))[0].percussion, true, "dead notes use unpitched percussion");
assert.equal(plan(n({ fx: { staccato: true } }))[0].duration, 0.18);
assert.equal(plan(n({ fx: { palmMute: true } }))[0].duration, 0.04);
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
assert.equal(source.stopped, 10.1);
assert.equal(source.fadeOut, 0.44);
assert.equal(filters[0].options.type, "lowpass");
source.onended(); assert.ok(filters[0].disposed);
assert.equal(synth.attack, 0);
playSampleEvent(synth, plan(n({ whammy: "dip" }))[0], 11, 11.02, 1);
assert.ok(calls.some((c) => c.curve?.length > 2));
console.log("playback effects OK");

// Dip returns its finger markers to full strength along the same pitch curve.
const { whammyGripStyle } = await import("../../web/whammy.js");
const dip = n({ whammy: "dip" });
assert.deepEqual(whammyGripStyle(dip, 1), { size: 1, opacity: 1 });
const bottom = whammyGripStyle(dip, 1.5);
assert.ok(bottom.size < 1 && bottom.opacity < 1);
assert.deepEqual(whammyGripStyle(dip, 1.25), whammyGripStyle(dip, 1.75));
assert.deepEqual(whammyGripStyle(dip, 2), { size: 1, opacity: 1 });
assert.deepEqual(whammyGripStyle(n({ whammy: "dive" }), 1.5), whammyGripStyle(dip, 1.25));

const { strikeTime, strumOffset, tremoloStep, hammerDirections } = await import("../../web/articulations.js");
const repeating = n({ tremPick: "16" });
const tremEvents = plan(repeating);
const mark = { note: repeating, start: repeating.start, tremoloStep: tremoloStep(repeating) };
for (const event of tremEvents) assert.equal(strikeTime(mark, event.start + 0.01), event.start);
assert.equal(strikeTime(mark, 0.99), null);
for (const stroke of ["up", "down"]) {
  const chord = [45, 52, 57].map((pitch) => n({ pitch, stroke }));
  for (const event of playbackEvents(chord))
    assert.equal(event.start, event.note.start + strumOffset(event.note, chord));
}
const sequence = [n({ end: 2, fx: { hammer: true } }),
  n({ start: 2, end: 3, pitch: 64, fx: { hammer: true } }),
  n({ start: 3, end: 4, pitch: 62, fx: { hammer: true } })];
const tags = hammerDirections(sequence);
assert.equal(tags.get(sequence[1]), "H"); assert.equal(tags.get(sequence[2]), "P");
assert.equal(playbackEvents([n({ fx: { dead: true } }), sequence[1]]).filter(e => !e.percussion).length, 1,
  "a dead source cannot swallow a following live hammer note");
const pm = plan(n({ fx: { palmMute: true } }))[0];
assert.ok(pm.release > pm.duration, "palm mute decays gradually after its short attack");

const rawBuffers = [], deadSources = [];
synth.context = { sampleRate: 48000, rawContext: { createBuffer(channels, length) {
  const data = new Float32Array(length); rawBuffers.push(data);
  return { getChannelData: () => data };
} } };
Tone.ToneBufferSource = class {
  constructor(options) { this.options = options; deadSources.push(this); }
  connect(output) { this.output = output; }
  start(when, offset, duration, velocity) { this.when = when; this.velocity = velocity; }
  stop(when) { this.stopped = when; }
};
const attacksBefore = calls.length;
playSampleEvent(synth, plan(n({ fx: { dead: true } }))[0], 20, 20.02);
playSampleEvent(synth, plan(n({ pitch: 80, fx: { dead: true } }))[0], 21, 21.02);
assert.equal(calls.length, attacksBefore, "no pitched sampler attacks for a dead note");
assert.equal(rawBuffers.length, 1, "noise buffer is reused within the audio context");
assert.equal(deadSources[0].options.url, deadSources[1].options.url, "dead-note timbre is independent of pitch");
assert.equal(deadSources[0].output, synth.output, "percussion follows lane volume and mute");
assert.equal(synth._activeSources.get(-1).length, 2, "pause/releaseAll owns the percussion sources");
deadSources[0].onended(); assert.equal(synth._activeSources.get(-1).length, 1);
assert.ok(rawBuffers[0].some(v => v !== 0));
const { popAmount } = await import("../../web/articulations.js");
const pop = { start: 1, note: n({ slap: "pop" }) };
assert.equal(popAmount(pop, 1), 0); assert.equal(popAmount(pop, 1.08), 1);
assert.equal(popAmount(pop, 1.2), 0);
