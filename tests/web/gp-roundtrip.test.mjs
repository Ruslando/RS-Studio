// Run: node tests/web/gp-roundtrip.test.mjs
// Import a Guitar Pro file, add a note, export: every original note keeps its string
// and fret, and the added note is fingered around them. With and without a capo.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { convertGpScore, packLaneSource, unpackLaneSource } from "../../web/guitar-pro-core.js";
import { appendCreatedLanes, applyImportedProjection, renumberScoreIds } from "../../web/guitar-pro-edit.js";
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
// An imported layer keeps its staff of the file: what the editor does not show
// (here lyrics) is still in the export after a note of the layer was edited, and
// a second file's layer joins the same score as its own track.
{
  const note = (id, start, string, fret) => ({ id, start, end: start + 0.5, pitch: open[string] + fret, pos: { string, fret, scope: "local" } });
  const make = (name) => {
    const score = new alphaTab.model.Score();
    for (let i = 0; i < 2; i++) score.addMasterBar(new alphaTab.model.MasterBar());
    appendCreatedLanes(alphaTab, score, [{ name, customTuning: "E4 B3 G3 D3 A2 E2", gmProgram: 25, notes: [note(1, 0, 5, 3), note(2, 1, 4, 5)] }], [0, 2, 4]);
    score.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics = ["la"];
    return load(write(score));
  };
  const lyric = (score) => score.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics?.[0];
  const [a, b] = [make("A"), make("B")];
  const laneA = convertGpScore(a, [0]).editLanes[0];
  const packed = await packLaneSource(JSON.parse(alphaTab.model.JsonConverter.scoreToJson(a)), 0, 0);
  const source = await unpackLaneSource(alphaTab, packed);
  assert.equal(lyric(source), "la");
  laneA.notes[1] = { ...laneA.notes[1], pitch: laneA.notes[1].pitch + 2, pos: { ...laneA.notes[1].pos, fret: 7 } };
  const edited = applyImportedProjection(alphaTab, source, [laneA], [0]);
  const other = await unpackLaneSource(alphaTab, await packLaneSource(JSON.parse(alphaTab.model.JsonConverter.scoreToJson(b)), 0, 0));
  edited.addTrack(other.tracks[0]);
  renumberScoreIds(edited);   // both files' notes start at the same ids
  edited.finish(settings);
  const out = load(write(edited));
  assert.deepEqual(out.tracks.map((t) => t.name), ["A", "B"]);
  assert.equal(lyric(out), "la", "the lyrics survive the edit");
  assert.ok(convertGpScore(out, [0]).editLanes[0].notes.some((n) => n.pos.fret === 7), "the edit is in the file");
}

// The file's instrument changes come in as tone switches naming no library preset
// (the user picks one), and its chord names ride on the chord's notes.
{
  const score = new alphaTab.model.Score();
  for (let i = 0; i < 2; i++) score.addMasterBar(new alphaTab.model.MasterBar());
  const chordNote = (string, fret) => ({ start: 0, end: 0.5, pitch: open[string] + fret, pos: { string, fret, scope: "local" } });
  appendCreatedLanes(alphaTab, score, [{ name: "G", customTuning: "E4 B3 G3 D3 A2 E2", gmProgram: 30,
    notes: [chordNote(5, 3), chordNote(4, 2), { start: 1.7, end: 2, pitch: open[0], pos: { string: 0, fret: 0, scope: "local" } }] }], [0, 2, 4]);
  const chord = new alphaTab.model.Chord(); chord.name = "G♯m";
  const staff = score.tracks[0].staves[0];
  staff.addChord("c1", chord); staff.bars[0].voices[0].beats[0].chordId = "c1";
  const clean = new alphaTab.model.Automation();
  clean.type = alphaTab.model.AutomationType.Instrument; clean.value = 27;
  staff.bars[1].voices[0].beats[0].automations.push(clean);
  const lane = convertGpScore(load(write(score)), [0]).editLanes[0];
  assert.deepEqual(lane.toneMarkers.map((m) => m.tone), ["guitar pro: Distortion Guitar", "guitar pro: Clean Guitar"]);
  assert.ok(lane.toneMarkers[1].t > 1.5, "the switch sits at the second bar");
  const named = lane.notes.filter((n) => n.chordName);
  assert.deepEqual(named.map((n) => n.chordName), ["G♯m", "G♯m"], "as the file spells it");
  assert.equal(named[0].chordNameFor, [open[5] + 3, open[4] + 2].sort((a, b) => a - b).join(","));
}

// What the editor holds of a file says everything the file says: imported, then
// written from the layer's notes alone (as "Tablature view as the editor sees it"
// does), every beat and note comes back as the file has it. Covers what the first
// real file showed was lost: effects on tied parts, a slide in and out of one note,
// triplets, a grace note, hammer-ons, whammy curves and a strum.
{
  const tex = `:4 5.3{sib sl} 7.3 r.2 | :2 5.2{v} :4 5.2{t sod} r |
    :8 3.1{tu 3} 5.1{tu 3} 3.1{tu 3} :4 2.2{gr} 5.2{h} 7.2 r |
    :4 5.4{tb (0 -4 0)} 5.4 5.4{t tb (0 -2 0)} (5.4 7.3){bu}`;
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, settings);
  const file = load(write(importer.readScore()));
  const lane = convertGpScore(file, [0]).editLanes[0];
  const at = (bar, fret) => lane.notes.find((n) => n.gp.bar === bar && n.pos.fret === fret);
  assert.equal(at(0, 5).slideIn, "inBelow"); assert.equal(at(0, 5).slide, "legato");
  assert.equal(at(1, 5).slide, "outDown", "a slide-out on the tied part");
  // The tied part is the last third; the slide moves in its last quarter, as alphaTab plays it.
  assert.ok(Math.abs(at(1, 5).slideStart - (2 / 3 + 0.75 / 3)) < 1e-6, "it starts where the player starts it");
  assert.deepEqual(lane.notes.filter((n) => n.gp.bar === 3 && n.whammy).map((n) => n.whammy), ["dip", "dip"],
    "the whammy on a tied part is the note's");
  assert.equal(lane.notes.filter((n) => n.stroke).length, 0, "strum direction is kept outside the editor");
  const shell = alphaTab.model.JsonConverter.jsonToScore(
    JSON.stringify({ ...JSON.parse(alphaTab.model.JsonConverter.scoreToJson(file)), tracks: [] }), settings);
  const seen = load(write(appendCreatedLanes(alphaTab, shell, [lane], [])));
  const beats = (score) => score.tracks[0].staves[0].bars.map((bar) => bar.voices[0].beats.map((b) =>
    `${b.absolutePlaybackStart}:${b.duration}${".".repeat(b.dots)}${b.tupletNumerator > 0 ? "t" : ""}${b.graceType ? "g" : ""}`
    + `${b.brushType ? "b" + b.brushType : ""}${JSON.stringify((b.whammyBarPoints || []).map((p) => [Math.round(p.offset), p.value]))}`
    + `[${b.notes.map((n) => `${n.string}/${n.fret}${n.isTieDestination ? "~" : ""}${n.isHammerPullOrigin ? "h" : ""}`
      + `${n.slideInType ? "i" + n.slideInType : ""}${n.slideOutType ? "o" + n.slideOutType : ""}${n.vibrato ? "v" : ""}`).sort().join(",")}]`).join(" "));
  assert.deepEqual(beats(seen), beats(file));
}

console.log("gp-roundtrip: ok");

// Newly supported techniques project into editor fields while the normal and
// rebuilt exports preserve the file's more specific notation.
{
  const { baseScore } = await import('../../tools/gp-audit/matrix.mjs');
  const { roundTrip } = await import('../../tools/gp-audit/harness.mjs');
  const notesOf = score => score.tracks[0].staves[0].bars.flatMap(b => b.voices[0].beats).flatMap(b => b.notes);
  const cases = [
    [n => { n.slideOutType = 5; }, n => n.slide === 'pickDown', n => n.slideOutType === 5],
    [n => { n.slideOutType = 6; }, n => n.slide === 'pickUp', n => n.slideOutType === 6],
    [n => { n.harmonicType = 2; }, n => n.harmonic === 'artificial', n => n.harmonicType === 2],
    [n => { n.isLeftHandTapped = true; }, n => n.slap === 'tap', n => n.isLeftHandTapped],
    [n => { n.ornament = 2; }, n => n.ornament === 'turn', n => n.ornament === 2],
    [n => { n.beat.deadSlapped = true; }, n => n.slap === 'slap' && n.fx?.dead, n => n.beat.deadSlapped],
  ];
  for (const [put, projected, retained] of cases) {
    const score = baseScore();
    put(notesOf(score).find(n => n.fret > 0 && !n.isTieOrigin && !n.isTieDestination));
    for (const mode of ['source', 'rebuilt', 'seen']) {
      const result = await roundTrip(score, 0, mode);
      assert.ok(result.lane.notes.some(projected), `editor projection in ${mode}`);
      assert.ok(notesOf(result.score).some(retained), `source notation retained in ${mode}`);
    }
  }
}
