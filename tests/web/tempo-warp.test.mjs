// Run: node tests/web/tempo-warp.test.mjs
// Detect tempo map replaces the grid; everything timed keeps its place between
// the beats, so a note on "3+" of a bar is on "3+" of that bar afterwards.
import assert from "node:assert/strict";
import { beatLines, beatWarp, warpTimes } from "../../web/bars.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const seg = (t, bpm) => ({ t, bpm, tsNum: 4, tsDen: 4 });

// Old grid: 120 BPM from 1 s. New grid: 125 BPM from 1.1 s, then a marker at
// 20 s that only moves the phase by 50 ms.
const oldBeats = beatLines([seg(1, 120)], 40);
const newBeats = beatLines([seg(1.1, 125), seg(20.05, 125)], 40);
close(oldBeats[1] - oldBeats[0], 0.5, "old beat");
const warp = beatWarp(oldBeats, newBeats);

// Beat 3 and the "+" after it, in bar 2 (old: 1 + 4*0.5 + 2*0.5 = 4 s).
close(warp(4), 1.1 + 6 * 0.48, "on a beat");
close(warp(4.25), 1.1 + 6.5 * 0.48, "halfway to the next beat");
// Before the first beat: shifted like the first beat.
close(warp(0.5), 0.6, "pickup");
// The old beat at 20 s lands on the phase marker's first beat.
close(warp(20), 20.05, "phase marker");

// Half tempo: two old beats share one new beat; the warp stays monotonic.
const half = beatWarp(beatLines([seg(0, 120)], 8), beatLines([seg(0, 60)], 8));
let last = -Infinity;
for (let t = 0; t < 8; t += 0.05) { assert.ok(half(t) >= last - 1e-9, "monotonic"); last = half(t); }

// Everything timed rides along; time 0 (the base tone) and the floor hold.
const lane = {
  notes: [{ start: 4, end: 4.25 }, { start: 0.2, end: 0.4 }],
  handHolds: [{ t: 4 }], toneMarkers: [{ t: 0 }, { t: 4 }], phraseBoundaries: [{ t: 4.25 }],
  refBoxes: { 1: { anchors: [4, 12], rt0: 0, rt1: 2 } },
};
const sections = [{ t: 4 }];
warpTimes([lane], sections, 40, 0.01, warp, 0.15);
close(lane.notes[0].start, warp(4), "note start");
close(lane.notes[0].end, warp(4.25), "note end");
assert.ok(lane.notes[1].start >= 0.15, "floor");
close(lane.handHolds[0].t, lane.notes[0].start, "hand hold follows its note");
assert.equal(lane.toneMarkers[0].t, 0, "base tone stays at 0");
close(lane.toneMarkers[1].t, warp(4), "tone switch");
close(lane.phraseBoundaries[0].t, warp(4.25), "phrase");
close(sections[0].t, warp(4), "section");
close(lane.refBoxes[1].anchors[1], warp(12), "reference anchor");
close(lane.refBoxes[1].rt1, warp(6) - warp(4), "reference length");
console.log("tempo-warp: ok");
