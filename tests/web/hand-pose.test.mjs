import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASS_HAND_PROFILE, chordColumns, fingerSplayCost, fingeringOptions, handForShape, voiceNotesFingered, scoreShapesAsDecided } from '../../web/voicing-core.js';

const project = JSON.parse(readFileSync(new URL('../../examples/chord-showcase/project.json', import.meta.url)));
const notes = project.editLanes[0].notes.filter(note => note.start < 96);
const tuning = [64, 59, 55, 50, 45, 40];
const bars = Array.from({ length: 25 }, (_, i) => i * 4);

const contact = (finger, ...strings) => ({ finger, members: strings.map(string => ({ string })) });
const pinky = contact(4, 0), ring = contact(3, 5), middle = contact(2, 5);
assert.ok(fingerSplayCost(ring, pinky) > fingerSplayCost(middle, pinky), 'finger identity changes wide-span tension');
assert.equal(fingerSplayCost(contact(3, 1), pinky), 0, 'adjacent contacts do not receive a blanket ring/pinky penalty');
assert.ok(fingerSplayCost(ring, pinky) > fingerSplayCost(contact(3, 3), pinky), 'larger lateral separation costs more');
assert.equal(fingerSplayCost(pinky, ring), fingerSplayCost(ring, pinky));
assert.ok(fingerSplayCost(ring, pinky, BASS_HAND_PROFILE) > fingerSplayCost(ring, pinky), 'actual string spacing changes tension');
assert.equal(fingerSplayCost(contact(1, 0, 1, 2, 3, 5), contact(3, 4)), 0, 'a note over a full barre does not span the barre width');

const playedG = voiceNotesFingered(notes, tuning, Infinity, { bars });
const gChord = notes.filter(note => note.start === 20);
assert.equal(playedG.fingers.get(gChord.find(note => note.pos.string === 5)), 2,
  'wide G uses the middle finger on low E, avoiding ring/pinky tension');
assert.equal(playedG.fingers.get(gChord.find(note => note.pos.string === 0)), 3, 'G is 2-1-0-0-0-3, one finger per fret');

for (const input of [notes, notes.filter(n => n.start === 84), notes.filter(n => n.start === 92)]) {
  const played = voiceNotesFingered(input, tuning, Infinity, { bars });
  for (const start of [84, 92]) {
    const chord = input.filter(n => n.start === start);
    if (!chord.length) continue;
    const barre = chord.filter(n => n.pos.fret === 5);
    assert.ok(barre.every(n => played.fingers.get(n) === 1), `case ${start / 4 + 1}: one index barre, not separate grips`);
    assert.ok(chord.every(n => played.seats.get(n) === 5), 'anchor belongs to the selected index barre');
  }
  for (const column of chordColumns(input)) {
    const fretted = column.notes.filter(n => played.voiced.get(n)?.fret > 0);
    for (const a of fretted) for (const b of fretted) {
      const pa = played.voiced.get(a), pb = played.voiced.get(b);
      const fa = played.fingers.get(a), fb = played.fingers.get(b);
      if (pa.fret === pb.fret)
        assert.ok((fa - fb) * (pa.string - pb.string) <= 0, `crossed fingers at ${column.t0}`);
      if (fa === 1) assert.equal(played.seats.get(a), pa.fret, `index and anchor disagree at ${column.t0}`);
    }
  }
}

// The renderer and alternative preview must receive the same physically valid hand.
const columns = chordColumns(notes);
for (const start of [68, 72, 84, 92]) {
  const index = columns.findIndex(c => c.t0 === start), chord = columns[index].notes;
  const shape = new Map(chord.map(n => [n, n.pos]));
  for (const pose of fingeringOptions(shape)) for (const a of pose.groups) for (const b of pose.groups) {
    if ((start === 68 || start === 72) && a.fret === b.fret)
      assert.ok((a.finger - b.finger) * (a.string - b.string) <= 0);
    if (a.finger === 1) assert.equal(pose.seat, a.fret);
  }
  const [offer] = scoreShapesAsDecided([shape], columns, index, tuning, { bars });
  assert.ok(offer.fingers.length > 0, 'alternative carries its actual fingers');
  if (start >= 84) assert.equal(offer.seat, 5);
}

// Do not confuse a tucked index (ordinary open A) with the blocked outer
// fingers above a planted index in D9. Valid alternatives remain available.
const aNotes = [3, 2, 1].map(string => ({ string }));
const aShape = new Map(aNotes.map(note => [note, { string: note.string, fret: 2 }]));
assert.ok(fingeringOptions(aShape).some(pose =>
  aNotes.map(note => pose.fingers.get(note)).join() === '2,1,3'));
const am7 = new Map(notes.filter(n => n.start === 92).map(note => [note, note.pos]));
const held = handForShape(am7, 5, undefined, new Map(), true);
assert.equal(held.seat, 5);
assert.ok([...am7].filter(([, pos]) => pos.fret === 5).every(([note]) => held.fingers.get(note) === 1));
const conflicting = handForShape(am7, 3, undefined, new Map(), true);
assert.equal(conflicting.seat, 5, 'an incompatible requested register must not invent an impossible hand');
// A muted note leading into a shift sits under the hand it shifts to, not the one it left.
{
  const bass = [43, 38, 33, 28];
  const at = (start, string, fret, fx) => ({ start, end: start + 0.2, pitch: bass[string] + fret, pos: { string, fret, scope: 'local' }, ...(fx ? { fx } : {}) });
  const run = [at(0, 3, 7), at(0.3, 3, 7), at(1, 3, 2, { dead: true }), at(1.2, 3, 2), at(1.6, 3, 4)];
  const { seats } = voiceNotesFingered(run, bass, Infinity, { instrument: 'bass' });
  assert.deepEqual(run.map(n => seats.get(n)), [7, 7, 2, 2, 2], 'the mute takes the hand that reaches its fret');
}
console.log('joint hand poses: barres, anatomy, anchors and alternatives passed');
