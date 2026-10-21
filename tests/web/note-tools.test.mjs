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
  // A shifted occurrence's box sits at its own pitch: 12 up, the high note is inside it.
  const raised = { start: 4.5, end: 5, pitch: 60 };
  assert.deepEqual(refOccurrences({ ...group, transposable: true, shifts: [0, 12] }, [first, raised, second], 0.25), [[first], [raised]],
    "a transposed occurrence holds the notes at its own pitch");

  // Two notes are "the same" for a reference when their effects are; where they are fretted is not an effect.
  assert.notEqual(effectSig({ slide: "shift" }), effectSig({}));
  assert.notEqual(effectSig({ fx: { palmMute: true } }), effectSig({ fx: { vibrato: true } }));
  assert.equal(effectSig({ pos: { string: 1, fret: 2 } }), effectSig({}));
  assert.notEqual(effectSig({ pos: { string: 1, fret: 2 } }, { includePos: true }), effectSig({}, { includePos: true }));
  assert.notEqual(effectSig({ pos: { string: 1, fret: 2, follow: "locked" } }, { includePos: true }),
    effectSig({ pos: { string: 1, fret: 2 } }, { includePos: true }), "how an override carries on is part of it");
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
  // Real grips, written as a chord book writes them (low E string first, x = not
  // played), and the name each one is known by. Policy: docs/chord-engine.md.
  const STANDARD = [40, 45, 50, 55, 59, 64], DROP_D = [38, 45, 50, 55, 59, 64];
  const grip = (frets, tuning = STANDARD) => [...frets].flatMap((f, s) => (f === "x" ? [] : [tuning[s] + parseInt(f, 36)]));
  const named = (frets, tuning) => detectChord(grip(frets, tuning));
  const book = {
    // open and barre triads, flats where charts use them
    x32010: "C", x02220: "A", "320003": "G", "022100": "E", xx0232: "D", "133211": "F",
    x02210: "Am", "022000": "Em", xx0231: "Dm", x24432: "Bm", "244222": "F#m", x46654: "C#m",
    x13331: "Bb", "466544": "Ab", "244322": "F#", x68886: "Eb",
    // sevenths
    x02020: "A7", xx0212: "D7", "020100": "E7", "320001": "G7", x32310: "C7", x21202: "B7",
    x02010: "Am7", "022030": "Em7", xx0211: "Dm7", x35343: "Cm7",
    x32000: "Cmaj7", xx3210: "Fmaj7", x02120: "Amaj7", xx0222: "Dmaj7",
    x2323x: "Bm7b5", x3424x: "Cdim7", x2343x: "Bdim", x3211x: "Caug",
    // suspended and added
    xx0233: "Dsus4", xx0230: "Dsus2", x02200: "Asus2", x02230: "Asus4", "022200": "Esus4", x32030: "Cadd9",
    // power chords
    "022xxx": "E5", x022xx: "A5", "355xxx": "G5", x355xx: "C5",
    // extended and altered
    x3233x: "C9", "020102": "E9", x7678x: "E7#9", "3x3455": "G13",
    // inversions: the lowest note after the slash
    "332010": "C/G", "200232": "D/F#", x20003: "G/B",
  };
  for (const [frets, symbol] of Object.entries(book)) assert.equal(named(frets), symbol, frets);
  assert.equal(named("000xxx", DROP_D), "D5", "drop D power chord");

  // Spelled-out cases the old formula list got wrong or could not name.
  const name = (...pitches) => detectChord(pitches);
  assert.equal(name(48), "C", "one note names itself");
  assert.equal(name(48, 60), "C", "and so does its octave");
  assert.equal(name(43, 48), "C5/G", "an inverted power chord");
  assert.equal(name(48, 52), "", "a third alone is an interval, not a chord");
  assert.equal(name(48, 49, 50), "", "a cluster no reading explains");
  assert.equal(name(48, 52, 58), "C7", "a missing fifth is not written");
  assert.equal(name(48, 55, 58), "C7(no3)", "a missing third is");
  assert.equal(name(48, 52, 55, 58, 62, 65), "C11");
  assert.equal(name(48, 53, 55, 58, 62), "C9sus4");
  assert.equal(name(48, 50, 55, 58), "C7sus2");
  assert.equal(name(48, 52, 55, 58, 66), "C7#11");
  assert.equal(name(48, 52, 56, 59), "Cmaj7#5");
  assert.equal(name(48, 51, 55, 57, 62), "Cm6/9");
  assert.equal(name(48, 51, 54, 59), "Cdim(maj7)");
  assert.equal(name(48, 52, 56, 58, 61), "C7#5b9");
  assert.equal(name(48, 52, 58, 63, 69), "C13#9", "a 13 chord may have an altered ninth");
  assert.equal(name(48, 52, 55, 57, 62, 66), "C6/9#11", "not D11/C: a natural 11 clashes with a major third");
  assert.equal(name(48, 52, 62), "Cadd9");

  // Two names for the same tones: the root in the bass wins, the other is offered.
  const sixth = analyzeChord([48, 52, 55, 57]);
  assert.equal(sixth.symbol, "C6");
  assert.ok(sixth.alternatives.includes("Am7/C"));
  assert.equal(analyzeChord([45, 52, 55, 60, 64]).symbol, "Am7");
  assert.equal(analyzeChord([]), null);
}
console.log("note-tools: ok");
