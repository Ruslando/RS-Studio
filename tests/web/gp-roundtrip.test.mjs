// Run: node tests/web/gp-roundtrip.test.mjs
// Import a Guitar Pro file, add a note, export: every original note keeps its string
// and fret, and the added note is fingered around them. With and without a capo.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { convertGpScore } from "../../web/guitar-pro-core.js";
import { appendCreatedLanes, applyImportedProjection } from "../../web/guitar-pro-edit.js";
import { voiceNotes } from "../../web/voicing-core.js";

const alphaTab = createRequire(import.meta.url)("../../web/vendor/alphatab/alphaTab.min.js");
const settings = new alphaTab.Settings();
const open = [64, 59, 55, 50, 45, 40];                // app order: string 0 = high E
const load = (data) => alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, settings);
const write = (score) => new alphaTab.exporter.Gp7Exporter().export(score, settings);
const key = (n) => `${n.start.toFixed(3)}:${n.pitch}`;
const at = (p) => `${p.string}:${p.fret}`;

function roundTrip(capo) {
  // Frets count from the capo; positions the automatic fingering would not pick.
  const note = (id, start, string, fret) =>
    ({ id, start, end: start + 0.5, pitch: open[string] + capo + fret, pos: { string, fret, scope: "local" } });
  const source = new alphaTab.model.Score();
  for (let i = 0; i < 2; i++) source.addMasterBar(new alphaTab.model.MasterBar());
  appendCreatedLanes(alphaTab, source, [{
    name: "Guitar", customTuning: "E4 B3 G3 D3 A2 E2", gmProgram: 25, capo, notes: [
      note(1, 0.0, 5, 5), note(2, 0.0, 4, 7),           // power chord at 5/7
      note(3, 0.5, 5, 8), note(4, 1.0, 4, 5), note(5, 2.0, 3, 5),
    ],
  }], [0, 2, 4]);
  const bytes = write(source);

  const imported = convertGpScore(load(bytes), [0]);
  const lane = imported.editLanes[0];
  assert.equal(lane.capo, capo);
  const tuning = open.map((pitch) => pitch + capo);     // laneFretTuning
  const original = new Map(lane.notes.map((n) => [key(n), at(n.pos)]));
  assert.equal(original.size, 5);
  for (const n of lane.notes) assert.equal(tuning[n.pos.string] + n.pos.fret, n.pitch, "imported pitch = open + capo + fret");

  // Add a note into the opening chord, then finger the lane the way the app does.
  const added = { id: "added", start: lane.notes[0].start, end: lane.notes[0].end, pitch: open[2] + capo + 7 };
  lane.notes.push(added);
  const voiced = voiceNotes(lane.notes, tuning, Infinity, { capo });
  for (const n of lane.notes) if (n !== added) assert.equal(at(voiced.get(n)), original.get(key(n)), `capo ${capo}: imported ${key(n)} kept`);
  assert.ok(voiced.get(added), "the added note is placed");
  const played = { ...lane, notes: lane.notes.map((n) => ({ ...n, pos: { ...n.pos, ...voiced.get(n), scope: "local" } })) };

  const again = convertGpScore(load(write(applyImportedProjection(alphaTab, load(bytes), [played], [0]))), [0]).editLanes[0];
  assert.equal(again.capo, capo, "the export keeps the capo");
  for (const [k, pos] of original) {
    const n = again.notes.find((m) => key(m) === k);
    assert.ok(n, `exported ${k} exists`);
    assert.equal(at(n.pos), pos, `capo ${capo}: exported ${k} keeps its string and fret`);
  }
  assert.equal(at(again.notes.find((m) => key(m) === key(added)).pos), at(voiced.get(added)),
    "the export writes the added note where the fretboard shows it");
}

roundTrip(0);
roundTrip(2);

// A capo shortens the neck: on capo 5, fret 18 above it is the 23rd fret — off a 22.
{
  const high = { start: 0, end: 0.5, pitch: open[0] + 5 + 18 };
  assert.equal(voiceNotes([high], open.map((p) => p + 5), Infinity, { capo: 5 }).get(high), undefined);
  assert.ok(voiceNotes([high], open.map((p) => p + 5), Infinity, { capo: 0 }).get(high), "without the capo it fits");
}
console.log("gp-roundtrip: ok");
