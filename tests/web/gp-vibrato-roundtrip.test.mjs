import assert from 'node:assert/strict';
import { baseScore } from '../../tools/gp-audit/matrix.mjs';
import { alphaTab, asFile, roundTrip } from '../../tools/gp-audit/harness.mjs';
import { convertGpScore } from '../../web/guitar-pro-core.js';

const { None, Slight, Wide } = alphaTab.model.VibratoType;
const modes = ['source', 'rebuilt', 'seen', 'editor'];
const tiedParts = score => score.tracks[0].staves[0].bars[2].voices[0].beats.flatMap(beat => beat.notes);
function fileWithVibrato(origin, destination) {
  const score = baseScore(), parts = tiedParts(score);
  parts[0].vibrato = origin; parts[1].vibrato = destination;
  return asFile(score);
}
// Portable export may merge adjacent tied parts with identical effects. Compare
// the musical interval, rather than requiring the same rhythmic spelling.
function vibratoIntervals(score) {
  const bar = score.tracks[0].staves[0].bars[2], start = bar.masterBar.start;
  const duration = bar.masterBar.calculateDuration(), intervals = [];
  for (const beat of bar.voices[0].beats) for (const note of beat.notes) {
    if (!note.vibrato) continue;
    const from = (beat.absolutePlaybackStart - start) / duration;
    const to = from + beat.playbackDuration / duration;
    const last = intervals.at(-1);
    if (last && last[1] === from && last[2] === note.vibrato) last[1] = to;
    else intervals.push([from, to, note.vibrato]);
  }
  return intervals;
}

// A portable effect ending midway through a tie needs no hidden source fields.
for (const [origin, destination, expectedRange] of [
  [Slight, None, [0, .5]], [None, Slight, [.5, 1]], [Slight, Slight, [0, 1]],
]) {
  const file = fileWithVibrato(origin, destination);
  const projected = convertGpScore(file, [0]).editLanes[0].notes.find(note => note.gp?.tieSegments?.length);
  assert.equal(projected.fx.vibrato, true);
  assert.deepEqual([projected.vibratoStart ?? 0, projected.vibratoEnd ?? 1], expectedRange);
  for (const mode of modes) {
    const { score } = await roundTrip(file, 0, mode);
    assert.deepEqual(vibratoIntervals(score), [[...expectedRange, Slight]], `${mode} preserves the vibrato interval on tied notes`);
  }
}

const file = fileWithVibrato(Slight, None);
const projected = convertGpScore(file, [0]).editLanes[0].notes.find(note => note.gp?.tieSegments?.length);
const editTied = update => lane => update(lane.notes.find(note => note.start === projected.start && note.pitch === projected.pitch));
for (const mode of modes) {
  const extended = await roundTrip(file, 0, mode, editTied(note => { note.vibratoEnd = 1; }));
  assert.deepEqual(vibratoIntervals(extended.score), [[0, 1, Slight]], `${mode} extends vibrato across the tie`);
  const cleared = await roundTrip(file, 0, mode, editTied(note => {
    // Match the editor's immutable flag update: the imported source projection
    // must remain available to distinguish clearing an effect from no edit.
    const fx = { ...note.fx }; delete fx.vibrato;
    if (Object.keys(fx).length) note.fx = fx; else delete note.fx;
    delete note.vibratoStart; delete note.vibratoEnd;
  }));
  assert.deepEqual(vibratoIntervals(cleared.score), [], `${mode} clears vibrato from both parts`);
}

// Width belongs to the original notation; the portable editor only exposes on/off.
const wide = fileWithVibrato(Wide, None);
for (const mode of ['source', 'rebuilt', 'seen']) {
  assert.deepEqual(vibratoIntervals((await roundTrip(wide, 0, mode)).score), [[0, .5, Wide]], `${mode} retains the original vibrato width`);
}
console.log('Guitar Pro tied vibrato intervals, edits, removal and source width passed');
