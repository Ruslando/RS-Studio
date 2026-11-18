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
// Frets 5 to 10 is six frets, one more than a hand stretches: Auto plays 7 to 10 from
// 7 and shifts once, when the 5th fret comes.
assert.deepEqual(auto, [7, 7, 7, 7, 7, 5, 5, 5], 'Auto shifts once, for the 5th fret');
for (const fret of [3, 4]) {
  const held = seats([{ t: notes[5].start, fret }]);
  assert.deepEqual(held.slice(0, 5), auto.slice(0, 5), `a hand put at ${fret} leaves the notes before it alone`);
  assert.equal(held[5], fret);
}
// With two anchors, the later one changes nothing before it either.
const first = seats([{ t: notes[2].start, fret: 7 }]), both = seats([{ t: notes[2].start, fret: 7 }, { t: notes[5].start, fret: 4 }]);
assert.deepEqual(both.slice(0, 5), first.slice(0, 5));

// Loading keeps one anchor per note or chord: the earliest, which is the one obeyed.
import { obeyedHolds } from '../../web/hand-anchor-core.js';
const stale = [{ t: 2.7, fret: 5 }, { t: 3, fret: 4 }, { t: 3.5, fret: 2 }, { t: 9, fret: 1 }];
assert.deepEqual(obeyedHolds(notes, stale), [stale[0], stale[2], stale[3]]);
const loaded = seats(obeyedHolds(notes, stale));
assert.deepEqual(loaded, seats(stale), 'dropping the shadowed anchors changes no hand');
