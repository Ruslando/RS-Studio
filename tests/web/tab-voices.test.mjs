// Run: node tests/web/tab-voices.test.mjs
// Two notes overlapping on one string need a second voice in their bar. alphaTab
// chains voices bar to bar, so the bars around it must carry that voice too, or
// the tab preview dies with "Cannot read properties of undefined (reading 'beats')".
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendCreatedLanes } from "../../web/guitar-pro-edit.js";

const alphaTab = createRequire(import.meta.url)("../../web/vendor/alphatab/alphaTab.min.js");
const score = new alphaTab.model.Score();
for (let i = 0; i < 4; i++) score.addMasterBar(new alphaTab.model.MasterBar());

const pin = (string, fret) => ({ string, fret, scope: "local" });
const lane = {
  name: "Lead", tuning: "E2 A2 D3 G3 B3 E4", fingeringMode: "exact", notes: [
    // bar 2 (2s..4s at 120 bpm): both on the D string, the second starts inside the first
    { id: 1, start: 2.0, end: 3.0, pitch: 52, pos: pin(3, 2) },
    { id: 2, start: 2.5, end: 3.5, pitch: 53, pos: pin(3, 3) },
    { id: 3, start: 6.0, end: 6.5, pitch: 52, pos: pin(3, 2) },
  ],
};
appendCreatedLanes(alphaTab, score, [lane], [0, 2, 4, 6]);   // threw before the fix

const counts = score.tracks[0].staves[0].bars.map((bar) => bar.voices.length);
assert.ok(counts[1] >= 2, "the overlap should have needed a second voice");
assert.equal(new Set(counts).size, 1, `every bar carries the same voices, got ${counts}`);
console.log("ok", counts.join(","));
