import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

let liveBars = [0, 4], ownBars = [0, 3], solves = 0;
const S = { voicingRevision: 1 };
const { laneFingering, laneFingeringKey } = await mockImport(new URL('../../web/tablature.js', import.meta.url), {
  './store.js': { S },
  './song-bars.js': { songBarStarts: timing => timing ? timing.bars : liveBars },
  './timing.js': { onLiveTiming: lane => !lane.timing, timingIdOf: lane => lane.timing,
    timingData: () => ({ bars: ownBars }) },
  './voicing.js': { arrangedNotes: notes => notes, isChosenFinger: () => false, voiceNotesFingered: (notes, tuning, limit, options) => {
    solves++;
    return { voiced: new Map(notes.map(note => [note, { string: 0, fret: options.bars[1] }])), fingers: new Map(), seats: new Map() };
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
console.log('Fingering cache identity and per-layer timing passed');
