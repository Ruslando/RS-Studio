// Run: node tests/web/gp-roundtrip.test.mjs
// Import a Guitar Pro file, add a note, export: every original note keeps its string
// and fret, and the added note is fingered around them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { convertGpScore } from "../../web/guitar-pro-core.js";
import { appendCreatedLanes, applyImportedProjection } from "../../web/guitar-pro-edit.js";
import { voiceNotes } from "../../web/voicing-core.js";

const alphaTab = createRequire(import.meta.url)("../../web/vendor/alphatab/alphaTab.min.js");
const settings = new alphaTab.Settings();
const pin = (string, fret) => ({ string, fret, scope: "local" });

// The source file: positions the automatic fingering would not pick on its own.
const source = new alphaTab.model.Score();
for (let i = 0; i < 2; i++) source.addMasterBar(new alphaTab.model.MasterBar());
appendCreatedLanes(alphaTab, source, [{
  name: "Guitar", tuning: "standard", customTuning: "E2 A2 D3 G3 B3 E4", gmProgram: 29, notes: [
    { id: 1, start: 0.0, end: 0.5, pitch: 45, pos: pin(5, 5) },   // A2 on low E, 5
    { id: 2, start: 0.0, end: 0.5, pitch: 52, pos: pin(4, 7) },   // E3 on A, 7
    { id: 3, start: 0.5, end: 1.0, pitch: 48, pos: pin(5, 8) },   // C3 on low E, 8
    { id: 4, start: 1.0, end: 1.5, pitch: 50, pos: pin(4, 5) },   // D3 on A, 5
    { id: 5, start: 2.0, end: 2.5, pitch: 55, pos: pin(3, 5) },   // G3 on D, 5
  ],
}], [0, 2, 4]);
const bytes = new alphaTab.exporter.Gp7Exporter().export(source, settings);
const load = (data) => alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, settings);

const imported = convertGpScore(load(bytes), [0]);
const lane = imported.editLanes[0];
const tuning = imported.guitarPro.selectedTracks[0].staves[0].tuning;
const key = (n) => `${n.start.toFixed(3)}:${n.pitch}`;
const original = new Map(lane.notes.map((n) => [key(n), `${n.pos.string}:${n.pos.fret}`]));
assert.equal(original.size, 5);

// Add A3 into the opening chord, then finger the lane the way the app does.
const added = { id: "added", start: lane.notes[0].start, end: lane.notes[0].end, pitch: 57 };
lane.notes.push(added);
const voiced = voiceNotes(lane.notes, tuning);
for (const n of lane.notes) if (n !== added)
  assert.equal(`${voiced.get(n).string}:${voiced.get(n).fret}`, original.get(key(n)), `imported ${key(n)} kept`);
assert.ok(voiced.get(added), "the added note is placed");
const played = { ...lane, notes: lane.notes.map((n) => ({ ...n, pos: { ...n.pos, ...voiced.get(n), scope: "local" } })) };

const out = applyImportedProjection(alphaTab, load(bytes), [played], [0]);
const again = convertGpScore(load(new alphaTab.exporter.Gp7Exporter().export(out, settings)), [0]).editLanes[0];
for (const [k, pos] of original) {
  const n = again.notes.find((m) => key(m) === k);
  assert.ok(n, `exported ${k} exists`);
  assert.equal(`${n.pos.string}:${n.pos.fret}`, pos, `exported ${k} keeps its string and fret`);
}
const back = again.notes.find((m) => key(m) === key(added));
assert.equal(`${back.pos.string}:${back.pos.fret}`, `${voiced.get(added).string}:${voiced.get(added).fret}`,
  "the export writes the added note where the fretboard shows it");
console.log("gp-roundtrip: ok");
