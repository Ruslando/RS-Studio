import assert from 'node:assert/strict';
import { automaticHandSeat } from '../../web/hand-anchor-core.js';
import { voiceNotesFingered } from '../../web/voicing-core.js';

const tuning = [64, 59, 55, 50, 45, 40];
const notes = [
  { id: 'a', start: 0, end: 1, pitch: 83, pos: { string: 0, fret: 19, scope: 'local' } },
  { id: 'b', start: 2, end: 3, pitch: 81, pos: { string: 0, fret: 17, scope: 'local' } },
];
const holds = [{ t: 0, fret: 16 }, { t: 1.5, fret: 14 }];
const options = { instrument: 'electric', holds };
const saved = JSON.stringify({ notes, holds });
assert.equal(voiceNotesFingered(notes, tuning, Infinity, options).seats.get(notes[0]), 16);
const withoutFirst = voiceNotesFingered(notes, tuning, Infinity, { ...options, holds: [holds[1]] });
assert.equal(automaticHandSeat(notes, tuning, 0, options), withoutFirst.seats.get(notes[0]),
  'Auto ignores the current override and preserves later anchors');
const withoutSecond = voiceNotesFingered(notes, tuning, Infinity, { ...options, holds: [holds[0]] });
assert.equal(automaticHandSeat(notes, tuning, 1.5, options), withoutSecond.seats.get(notes[1]),
  'an anchor between notes belongs to the next column');
assert.equal(automaticHandSeat(notes, tuning, 4, options), null);
assert.equal(JSON.stringify({ notes, holds }), saved, 'preview never rewrites the project');
assert.equal(automaticHandSeat([notes[0]], tuning, 0, { instrument: 'electric', holds: [holds[0]] }), 19,
  'Auto must not repeat the overridden position 16');
console.log('hand-anchor auto: ok');
