// Run: node tests/web/note-tools.test.mjs
// The small rules notes are edited by: slicing, bend curves, references, motifs, chord names.
import assert from "node:assert/strict";
import { BEND_PRESETS, bendAt, bendCurve, bendPeak, bendShape, normalizeCurve } from "../../web/bend.js";
import { analyzeChord, detectChord } from "../../web/chords.js";
import { effectSig, refOccurrences } from "../../web/reference-core.js";
import { markMotif, migrateMotifs, motifGroups, unmarkMotif, normalizeMotifIds, motifLabel, motifToExtend } from "../../web/motifs.js";
import { lineXAtRow, splitNote } from "../../web/slice.js";

// ---- slicing --------------------------------------------------------------
{
  const note = { id: 1, start: 0, end: 1, pitch: 50, slide: "shift", fx: { palmMute: true }, shapeId: "shape_1", bend: "full" };
  const { left, right } = splitNote(note, 0.5, 0.1, () => 2);
  assert.deepEqual([left.id, left.start, left.end], [1, 0, 0.5]);
  assert.deepEqual([right.id, right.start, right.end], [2, 0.5, 1]);
  assert.equal(left.slide, "shift");
  assert.equal(right.slide, undefined, "what happens at the attack stays with the first half");
  assert.deepEqual(right.fx, { palmMute: true });
  assert.notEqual(right.fx, note.fx, "the halves do not share one effects object");
  assert.ok(!("shapeId" in left) && !("shapeId" in right), "a cut note leaves its shape");
  // A full bend is up by the middle and held: the first half rises, the second holds.
  assert.deepEqual(left.bendPoints, [[0, 0], [1, 2]]);
  assert.deepEqual(right.bendPoints, [[0, 2], [1, 2]]);
  assert.equal(note.end, 1, "the note itself is not touched");

  assert.equal(splitNote(note, 0.05, 0.1, () => 2), null, "no piece shorter than a grid cell");
  assert.equal(splitNote(note, 0.95, 0.1, () => 2), null);
  assert.ok(splitNote(note, 0.1, 0.1, () => 2), "exactly one cell is enough");
  assert.equal(splitNote(note, NaN, 0.1, () => 2), null);

  // Where a drawn line crosses a note's row.
  const diagonal = { x0: 0, y0: 0, x1: 10, y1: 10 };
  assert.equal(lineXAtRow(diagonal, 5, 2), 5);
  assert.equal(lineXAtRow(diagonal, 20, 2), null, "the line never reaches that row");
  const flat = { x0: 0, y0: 5, x1: 10, y1: 5 };
  assert.equal(lineXAtRow(flat, 5.5, 2), 5);
  assert.equal(lineXAtRow(flat, 9, 2), null);
}

// ---- bends ----------------------------------------------------------------
{
  assert.equal(bendAt(BEND_PRESETS.full, 0.25), 1, "halfway up a full bend is a half step");
  assert.equal(bendAt(BEND_PRESETS.full, 0.75), 2);
  assert.equal(bendAt(BEND_PRESETS.release, 5), 0, "past the end is the last value");
  assert.equal(bendAt(BEND_PRESETS.prebend, -1), 2);
  assert.equal(bendPeak(BEND_PRESETS.onehalf), 3);
  assert.deepEqual(normalizeCurve([[1.5, 9], [-1, -9], [0.5, 1]]), [[0, -6], [0.5, 1], [1, 6]], "sorted and held inside the note and the range");
  assert.equal(normalizeCurve(Array.from({ length: 50 }, (_, i) => [i / 49, 1])).length, 32);
  assert.equal(bendCurve({}), null);
  assert.equal(bendCurve({ bend: "half" }), BEND_PRESETS.half);
  assert.equal(bendCurve({ bend: "not a preset" }), BEND_PRESETS.full);
  const own = [[0, 0], [1, 1]];
  assert.equal(bendCurve({ bend: "custom", bendPoints: own }), own);
  assert.deepEqual(["full", "release", "prebend", "prebendRelease", "bendReleaseBend"].map((name) => bendShape(BEND_PRESETS[name])),
    ["bend", "bendRelease", "prebend", "prebendRelease", "bendReleaseBend"]);
}

// ---- references -----------------------------------------------------------
{
  // The motif is two seconds long, pitches 40..50, played at 0 s and again at 4 s.
  const group = { anchors: [0, 4], rt0: 0, rt1: 2, pLo: 40, pHi: 50 };
  const first = { start: 0.5, end: 1, pitch: 45 }, second = { start: 4.5, end: 5, pitch: 45 };
  const edge = { start: 1.9, end: 2.5, pitch: 45 }, high = { start: 0.5, end: 1, pitch: 60 };
  const early = { start: 4.1, end: 4.4, pitch: 41 };
  assert.deepEqual(refOccurrences(group, [second, high, edge, first, early], 0.25), [[first], [early, second]],
    "a note barely inside the box, or outside its pitches, is not part of the motif");
  assert.deepEqual(refOccurrences({ anchors: [0] }, [first], 0.25), []);
  assert.deepEqual(refOccurrences(null, [first], 0.25), []);

  // Two notes are "the same" for a reference when their effects are; where they are fretted is not an effect.
  assert.notEqual(effectSig({ slide: "shift" }), effectSig({}));
  assert.notEqual(effectSig({ fx: { palmMute: true } }), effectSig({ fx: { vibrato: true } }));
  assert.equal(effectSig({ pos: { string: 1, fret: 2 } }), effectSig({}));
  assert.notEqual(effectSig({ pos: { string: 1, fret: 2 } }, { includePos: true }), effectSig({}, { includePos: true }));
  assert.equal(effectSig({ pos: { string: 1, fret: 2, adapt: true } }, { includePos: true }),
    effectSig({ pos: { string: 1, fret: 2, adaptNext: true, scope: "local" } }, { includePos: true }), "the old flag reads as the new one");
}

// ---- motifs: labels must not alter the music -------------------------------
{
  const notes = [{pitch: 45, start: 0, end: .4, pos: {string: 5, fret: 5}},
    {pitch: 88, start: 8, end: 9, arrangement: {notes: []}}];
  const before = structuredClone(notes);
  markMotif(notes, 'motif_1');
  assert.deepEqual(notes.map(({motifId, ...n}) => n), before, 'even an unplayable spread is only tagged');
  assert.equal(motifGroups(notes).get('motif_1').length, 2);
  assert.equal(motifGroups(notes.slice(0, 1)).get('motif_1').length, 1, 'a single marked note remains a motif');
  const {left, right} = splitNote(notes[0], .2, .1, () => 5);
  assert.equal(left.motifId, 'motif_1'); assert.equal(right.motifId, 'motif_1');
  unmarkMotif(notes, 'motif_1'); assert.deepEqual(notes, before);
  const legacy = [{pitch: 40, shapeId: 'shape_9', shapeSource: 'manual', pos: {string:5, fret:0}},
    {pitch:41, motifId:'motif_9'}, {pitch:42, motifId:'invalid'}];
  migrateMotifs(legacy);
  assert.equal(legacy[0].motifId, 'motif_legacy_9');
  assert.deepEqual(legacy[0].pos, {string:5,fret:0}, 'loading preserves authored fingering');
  assert.equal(motifGroups(legacy).size, 2, 'legacy and new markers cannot collide');
  assert.ok(legacy.every(note => !('shapeId' in note) && !('shapeSource' in note)));
}

// Extending a complete motif keeps its identity; ambiguous selections do not.
{
  const a = {motifId:'motif_v2_1'}, b = {motifId:'motif_v2_1'}, fresh = {};
  const other = {motifId:'motif_v2_2'}, notes = [a, b, fresh, other];
  assert.equal(motifToExtend(notes, [a, b, fresh]), 'motif_v2_1');
  assert.equal(motifToExtend(notes, [b, a]), 'motif_v2_1');
  assert.equal(motifToExtend(notes, [a, fresh]), null, 'partial motifs are not silently extended');
  assert.equal(motifToExtend(notes, [a, b, other]), null, 'multiple motifs have no implicit merge target');
  assert.equal(motifToExtend(notes, [fresh]), null);
  assert.equal(motifToExtend(notes, []), null);
}

// ---- chord names ----------------------------------------------------------
{
  const lanes = [{notes: [{id:'n17', motifId:'motif_18', written:[{motifId:'motif_18'}]},
    {motifId:'motif_18'}]}, {notes:[{motifId:'motif_23'}, {motifId:'motif_legacy_18'}]}];
  assert.equal(normalizeMotifIds(lanes), 4);
  assert.equal(motifLabel(lanes[0].notes[0].motifId), 'Motif #1', 'note ids do not determine motif names');
  assert.equal(lanes[0].notes[0].written[0].motifId, lanes[0].notes[1].motifId);
  assert.equal(motifLabel(lanes[1].notes[0].motifId), 'Motif #2');
  assert.equal(motifLabel(lanes[1].notes[1].motifId), 'Motif #3', 'old shape and motif identities stay distinct');
  lanes[0].notes = [];
  assert.equal(normalizeMotifIds(lanes), 4);
  assert.equal(motifLabel(lanes[1].notes[0].motifId), 'Motif #2', 'reopening does not renumber modern motifs');
  assert.equal(normalizeMotifIds([{notes:[{id:'n999'}]}]), 1, 'each project starts its own motif numbering');
}

{
  const name = (...pitches) => detectChord(pitches);
  assert.equal(name(48), "C");
  assert.equal(name(40, 47), "E5");
  assert.equal(name(48, 52, 55), "C");
  assert.equal(name(45, 52, 57, 60, 64), "Am");
  assert.equal(name(52, 55, 60), "C/E", "the lowest note names the bass");
  assert.equal(name(48, 52, 55, 58), "C7");
  assert.equal(name(48, 52, 58), "C7(no5)");
  assert.equal(name(50, 57, 62, 67), "Dsus4");
  assert.equal(name(48, 49, 50), "");
  assert.equal(analyzeChord([]), null);
  assert.deepEqual(analyzeChord([48, 52, 58]).missing.map((m) => m.pc), [7], "the fifth it left out is G");
}
console.log("note-tools: ok");
