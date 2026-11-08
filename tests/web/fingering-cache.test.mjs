import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { chordColumns, isChosenFinger } from '../../web/voicing-core.js';

let liveBars = [0, 4], ownBars = [0, 3], solves = 0;
const S = { voicingRevision: 1 };
const { laneFingering, laneFingeringKey } = await mockImport(new URL('../../web/tablature.js', import.meta.url), {
  './store.js': { S },
  './song-bars.js': { songBarStarts: timing => timing ? timing.bars : liveBars },
  './timing.js': { onLiveTiming: lane => !lane.timing, timingIdOf: lane => lane.timing,
    timingData: () => ({ bars: ownBars }) },
  './voicing.js': { arrangedNotes: notes => notes, chordColumns, isChosenFinger, voiceNotesFingered: (notes, tuning, limit, options) => {
    solves++;
    return { voiced: new Map(notes.map((note, string) => [note, { string, fret: note.testFret ?? options.bars[1] }])),
      fingers: new Map(notes.map(note => [note, 3])), seats: new Map(notes.map(note => [note, 2])) };
  } },
}, { './fretboard-cache.js': true, './tunings.js': true, './constants.js': true });

const lane = { id: 'separate-timing', tuning: 'guitar6', timing: 'own', notes: [{ start: 0, end: 1, pitch: 64 }] };
const firstKey = laneFingeringKey(lane);
assert.equal((await laneFingering(lane)).voiced.get(lane.notes[0]).fret, 3);
await laneFingering(lane);
assert.equal(solves, 1, 'unchanged fingering is cached');
ownBars = [0, 5];
assert.notEqual(laneFingeringKey(lane), firstKey, 'the lane own timing invalidates label positions');
assert.equal((await laneFingering(lane)).voiced.get(lane.notes[0]).fret, 5);
const ownKey = laneFingeringKey(lane);
liveBars = [0, 7];
assert.equal(laneFingeringKey(lane), ownKey, 'another lane live timing does not invalidate this lane');
await laneFingering(lane);
assert.equal(solves, 2);
const oldNote = lane.notes[0];
lane.notes = structuredClone(lane.notes);
const result = await laneFingering(lane);
assert.equal(solves, 3, 'replacing notes invalidates cached positions even at the same revision');
assert.ok(result.voiced.has(lane.notes[0]));
assert.ok(!result.voiced.has(oldNote));

for (const chord of [false, true]) {
  const index = { start: 0, end: 1, pitch: 69, testFret: 5 };
  const companions = chord ? [
    { start: 0, end: 1, pitch: 66, testFret: 7 },
    { start: 0, end: 1, pitch: 55, testFret: 0 },
  ] : [];
  const later = { start: 2, end: 3, pitch: 69, testFret: 5 };
  const lane = { tuning: 'guitar6', notes: [index, ...companions, later] };
  const automatic = await laneFingering(lane), beforeSolves = solves;
  index.finger = 1;
  const chosen = await laneFingering(lane);
  assert.equal(chosen.fingers.get(index), 1);
  for (const note of [index, ...companions]) assert.equal(chosen.seats.get(note), 5,
    'a chosen index moves the entire column hand to its fret');
  assert.equal(chosen.seats.get(later), 2, 'another onset retains its hand');
  assert.deepEqual(chosen.voiced, automatic.voiced, 'finger changes move no notes');
  assert.equal(solves, beforeSolves, 'the index anchor requires no new voicing solve');
  delete index.finger;
  const reset = await laneFingering(lane);
  assert.equal(reset.fingers.get(index), 3);
  for (const note of lane.notes) assert.equal(reset.seats.get(note), 2,
    'reset/cancel restores the cached automatic hand');
  index.finger = 1;
  index.fx = { dead: true };
  assert.equal((await laneFingering(lane)).seats.get(index), 2, 'dead notes do not anchor the index');
  index.testFret = 0;
  // A fresh note array invalidates the mocked positional cache.
  lane.notes = [...lane.notes];
  delete index.fx;
  assert.equal((await laneFingering(lane)).seats.get(index), 2, 'open strings do not anchor the index');
}
console.log('Fingering cache identity and per-layer timing passed');
