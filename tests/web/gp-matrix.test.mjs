// Run: node tests/web/gp-matrix.test.mjs
// The Guitar Pro feature matrix (tools/gp-audit/matrix.mjs): every field alphaTab has,
// with every value real files use, put on a note, a beat, a bar or the track of a small
// score and taken through the app's import and export. What the app does with each
// must not change unnoticed: a case that gets worse is a regression, one that gets
// better (or a new field after an alphaTab update) is written into the expectation:
//   node tools/gp-audit/matrix.mjs <corpus .gp files…> --save tools/gp-audit/matrix-cases.json
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCases } from "../../tools/gp-audit/matrix.mjs";

const cases = JSON.parse(readFileSync(new URL("../../tools/gp-audit/matrix-cases.json", import.meta.url), "utf8"));
const rows = await runCases(cases);
const changed = rows.map((row, i) => [cases[i], row]).filter(([want, got]) => want.status !== got.status)
  .map(([want, got]) => `${want.kind}.${want.field} = ${JSON.stringify(want.value).slice(0, 40)} @ ${want.place}: `
    + `${want.status} → ${got.status}${got.rebuilt?.length ? "\n      " + got.rebuilt.slice(0, 3).join("\n      ") : ""}`);
assert.deepEqual(changed, [], `${changed.length} matrix cases changed:\n  ${changed.join("\n  ")}`);
assert.ok(!rows.some((row) => row.status === "lost after edits"), "an edit must never lose what the file had");
console.log(`gp-matrix: ok (${rows.length} cases)`);

// A file's fretting finger is the note's typed finger, and a finger typed in the
// editor is what the export writes.
{
  const { baseScore } = await import("../../tools/gp-audit/matrix.mjs");
  const { roundTrip } = await import("../../tools/gp-audit/harness.mjs");
  const score = baseScore();
  const fretted = () => score.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats).flatMap((b) => b.notes).find((n) => n.fret > 0);
  fretted().leftHandFinger = 3;
  const fingers = (out) => out.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats).flatMap((b) => b.notes)
    .filter((n) => n.leftHandFinger >= 0).map((n) => n.leftHandFinger);
  let imported;
  await roundTrip(score, 0, "source", (lane) => { imported = lane.notes.filter((n) => n.finger != null).map((n) => n.finger); });
  assert.deepEqual(imported, [3]);
  for (const mode of ["source", "editor"]) {
    const { score: out } = await roundTrip(score, 0, mode, (lane) => { lane.notes.find((n) => n.finger === 3).finger = 1; });
    assert.deepEqual(fingers(out), [1], `typed finger in ${mode} export`);
  }
  console.log("gp-matrix: fingers ok");
}

// The file's texts come in as song comments, over the beat's highest note.
{
  const { textComments } = await import("../../web/guitar-pro-core.js");
  const lane = { notes: [{ start: 1, pitch: 50 }, { start: 1, pitch: 57 }, { start: 3, pitch: 45 }],
    scoreText: [{ t: 1, text: "riff" }, { t: 2.8, text: "rest" }, { t: 4, chord: "Am" }] };
  const made = textComments([lane]);
  assert.deepEqual(made.map((c) => [c.t, c.pitch, c.text]), [[1, 57, "riff"], [2.8, 45, "rest"]]);
  assert.deepEqual(textComments([lane], made), [], "the same file again adds no copies");
  console.log("gp-matrix: text comments ok");
}

// Techniques the Rocksmith chart cannot show are warned at the note, until the editor's effect is changed.
{
  const { baseScore } = await import("../../tools/gp-audit/matrix.mjs");
  const { roundTrip, asFile } = await import("../../tools/gp-audit/harness.mjs");
  const { gpOnlyTechniques } = await import("../../web/note-issues.js");
  const cases = {
    pickSlide: (n) => { n.slideOutType = 5; }, harmonic: (n) => { n.harmonicType = 2; }, leftTap: (n) => { n.isLeftHandTapped = true; },
    ornament: (n) => { n.ornament = 2; }, barVibrato: (n) => { n.beat.vibrato = 1; }, golpe: (n) => { n.beat.golpe = 1; },
    rasgueado: (n) => { n.beat.rasgueado = 1; }, deadSlapped: (n) => { n.beat.deadSlapped = true; },
  };
  // On a note, and on a later part of a tied note (each part has its own); through a written .gp.
  for (const tied of [false, true]) for (const [kind, put] of Object.entries(cases)) {
    const base = baseScore(), notesOf = (s) => s.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats).flatMap((b) => b.notes);
    const target = notesOf(base).find((n) => tied ? n.isTieDestination : n.fret > 0 && !n.isTieOrigin && !n.isTieDestination);
    put(target);
    const score = asFile(base), id = notesOf(score).find((n) => n.id === target.id) ? target.id : null;
    let warned, after;
    await roundTrip(score, 0, "source", (lane) => {
      const n = tied ? lane.notes.find((x) => x.gp?.tieSegments) : lane.notes.find((x) => x.gp?.noteId === id);
      warned = gpOnlyTechniques(n);
      if (kind === "harmonic") { n.harmonic = "pinch"; after = gpOnlyTechniques(n); }
    });
    if (["pickSlide", "harmonic", "leftTap", "ornament", "deadSlapped"].includes(kind))
      assert.ok(!warned.includes(kind), `${kind} now has an editor projection (got ${warned})`);
    else assert.ok(warned.includes(kind), `${kind}${tied ? " on a tied part" : ""} warned (got ${warned})`);
    if (after) assert.ok(!after.includes(kind), "a harmonic chosen in the editor is no longer warned");
  }
  console.log("gp-matrix: Guitar Pro-only warnings ok");
}

// A beat's technique on a chord is one warning for the chord.
{
  const { laneIssues } = await import("../../web/note-issues.js");
  const gp = { editorEffects: {}, beatExtras: { rasgueado: 1 } };
  const lane = { notes: [40, 45, 50].map((pitch) => ({ start: 1, end: 2, pitch, gp })) };
  const found = laneIssues(lane, [40, 45, 50, 55, 59, 64], 24, 0).filter((i) => i.kind === "rasgueado");
  assert.deepEqual(found.map((i) => i.notes.length), [3]);
}
