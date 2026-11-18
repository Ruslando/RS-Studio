// Run: node tests/web/hand-planner.test.mjs
// The hand planner: the hand stays until the notes force it to move, moves as few
// times as it can, covers four frets (five with a stretch) and obeys hand changes
// and placed notes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voiceNotesFingered } from '../../web/voicing-core.js';

const BASS = [43, 38, 33, 28];   // app order: 0 = G
const GUITAR = [64, 59, 55, 50, 45, 40];
const at = (got, n) => `${'GDAE'[got.voiced.get(n).string]}${got.voiced.get(n).fret}`;

// A hand change moves the unplaced notes after it into its hand (Kroi bass, Reference #8:
// the hand set to 9 over a bar that was played at the 4th fret).
{
  const pitches = [44, 39, 42, 47, 39, 47, 37, 44];   // G#2 D#2 F#2 B2 D#2 B2 C#2 G#2
  const notes = pitches.map((pitch, i) => ({ pitch, start: i * .3, end: i * .3 + .28 }));
  const solve = holds => voiceNotesFingered(notes, BASS, Infinity, { instrument: 'bass', holds, anchorChanges: true });
  const nine = solve([{ t: 0, fret: 9 }]);
  assert.deepEqual(notes.map(n => at(nine, n)), ['A11', 'E11', 'A9', 'D9', 'E11', 'D9', 'E9', 'A11']);
  assert.equal(nine.handConflicts.size, 0, 'every note fits the hand at 9');
  const four = solve([{ t: 0, fret: 4 }]);
  assert.ok(notes.every(n => { const f = four.voiced.get(n).fret; return f === 0 || (f >= 4 && f <= 8); }),
    'the same notes under a hand at 4 stay at the 4th fret');
}

// The hand stays until it must move: a hand change keeps the passage there until a
// note cannot be played from it (override showcase, hand at 2 from 32 s).
{
  const project = JSON.parse(readFileSync(new URL('../../examples/override-showcase/project.json', import.meta.url)));
  const lane = project.editLanes[0];
  const options = { bars: Array.from({ length: 33 }, (_, i) => i * 4), holds: lane.handHolds, instrument: 'electric' };
  const run = start => lane.notes.filter(n => n.start >= start && n.start < start + 8);
  const held = voiceNotesFingered(lane.notes, GUITAR, Infinity, options);
  const free = voiceNotesFingered(lane.notes, GUITAR, Infinity, { ...options, holds: [] });
  assert.ok(run(32).every(n => held.seats.get(n) === 2), 'the hand change at 32 s keeps the passage at the 2nd fret');
  assert.ok(run(32).every(n => free.seats.get(n) === 12), 'without it the hand stays where it already was');
  assert.ok(run(56).every(n => held.seats.get(n) === 12), 'notes that cannot be played at 2 still move the hand');
  // Same answer every time, and solving never writes to the project.
  const saved = JSON.stringify(lane.notes);
  const again = voiceNotesFingered(JSON.parse(saved), GUITAR, Infinity, options);
  assert.deepEqual([...again.voiced.values()], [...held.voiced.values()]);
  assert.equal(JSON.stringify(lane.notes), saved);
}

// Four frets, plus one with a stretch; never six.
{
  const run = frets => frets.map((fret, i) => ({ pitch: BASS[2] + fret, start: i * .5, end: i * .5 + .45,
    pos: { string: 2, fret, scope: 'local' } }));
  const seats = notes => { const got = voiceNotesFingered(notes, BASS, Infinity, { instrument: 'bass' }); return notes.map(n => got.seats.get(n)); };
  assert.deepEqual(seats(run([5, 5, 9, 5])), [5, 5, 5, 5], 'five frets: the pinky stretches');
  assert.notEqual(seats(run([5, 10]))[1], 5, 'six frets: the hand moves');
}

// An open string is used when it saves a shift, not otherwise.
{
  const E = (fret, start) => ({ pitch: 40 + fret, start, end: start + .4, pos: { string: 5, fret, scope: 'local' } });
  const around = frets => { const notes = [E(frets[0], 0), { pitch: 45, start: .5, end: .9 }, E(frets[1], 1)];
    return voiceNotesFingered(notes, GUITAR, Infinity, {}).voiced.get(notes[1]); };
  assert.deepEqual(around([9, 10]), { string: 4, fret: 0 }, 'between the 9th and 10th fret, the open A saves a shift');
  assert.deepEqual(around([3, 4]), { string: 5, fret: 5 }, 'with the hand at 3, A2 is fretted at the 5th');
}

console.log('hand planner: hand changes, staying, the four-fret window and open strings passed');
