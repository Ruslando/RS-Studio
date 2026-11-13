import assert from 'node:assert/strict';
import { voiceNotesFingered } from '../../web/voicing-core.js';

// A hand anchor reaches forward only: the hand before it stays where Auto had it.
const tuning = [40, 45, 50, 55, 59, 64];
const frets = [7, 8, 10, 8, 7, 5, 7, 8];
const notes = frets.map((fret, i) => ({ id: `n${i}`, pitch: 64 + fret, start: i * .5, end: i * .5 + .45,
  pos: { string: 5, fret, scope: 'local' } }));
const seats = holds => {
  const { seats } = voiceNotesFingered(notes, tuning, Infinity, { holds });
  return notes.map(n => seats.get(n));
};
const auto = seats([]);
assert.deepEqual(auto, [5, 5, 5, 5, 5, 5, 5, 5], 'Auto stands at 5 for the whole run, ready for the 5th fret');
for (const fret of [3, 4]) {
  const held = seats([{ t: notes[5].start, fret }]);
  assert.deepEqual(held.slice(0, 5), auto.slice(0, 5), `a hand put at ${fret} leaves the notes before it alone`);
  assert.equal(held[5], fret);
}
// With two anchors, the later one changes nothing before it either.
const first = seats([{ t: notes[2].start, fret: 7 }]), both = seats([{ t: notes[2].start, fret: 7 }, { t: notes[5].start, fret: 4 }]);
assert.deepEqual(both.slice(0, 5), first.slice(0, 5));

