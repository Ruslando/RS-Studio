import assert from 'node:assert/strict';
import { suggestionLane, suggestionDiffers } from '../../web/fretboard-suggestion.js';
const lane = { notes: [
  {id:'a',pitch:57,start:0,end:1,pos:{string:4,fret:12},auto:{string:2,fret:2},finger:2},
  {id:'b',pitch:57,start:2,end:3,pos:{string:4,fret:12},auto:{string:4,fret:12}},
], handHolds:[{t:0,fret:10},{t:2,fret:12}],refBoxes:{} };
const before = structuredClone(lane), preview = suggestionLane(lane, [lane.notes[0]]);
assert.equal(preview.notes[0].pos, undefined);
assert.equal(preview.notes[0].auto, undefined);
assert.equal(preview.notes[0].finger, undefined);
assert.deepEqual(preview.notes[1], lane.notes[1], 'other notes retain saved positions');
assert.notEqual(preview.notes[1], lane.notes[1], 'the worker receives detached data');
assert.deepEqual(preview.handHolds, [lane.handHolds[1]]);
assert.deepEqual(lane, before, 'requesting a suggestion never mutates the lane');
const grip = {seat:2,marks:[{pitch:57,string:2,fret:2}]};
assert.equal(suggestionDiffers(grip, structuredClone(grip)), false);
assert.equal(suggestionDiffers(grip, {...grip,seat:1}), true, 'a hand-only change is a suggestion');
assert.equal(suggestionDiffers(grip, {seat:2,marks:[{pitch:57,string:3,fret:7}]}), true);
assert.equal(suggestionDiffers(grip, null), false);
assert.equal(suggestionDiffers({...grip,seat:0}, {...grip,seat:null}), false, 'an absent hand has no differing position');
console.log('fretboard suggestions preserve live notes and compare both hand and note positions');
