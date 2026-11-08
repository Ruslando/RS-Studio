import assert from 'node:assert/strict';
import { fretboardShapeFrames, shapeHandAt } from '../../web/fretboard-shapes.js';
import { GUITAR, handColumns, handAt, stringContactAt, barreGroups } from '../../web/fretboard-core.js';
import { stringGlow, fretStrikeAt } from '../../web/string-glow.js';
import { strikeTime } from '../../web/articulations.js';

function setup(kind = 'handshape', extra = []) {
  const notes = [0,1,2].map((string, index) => ({
    id: `n${index}`, start: 1 + index * .5, end: 1.2 + index * .5,
    pitch: 64 - string * 5, shapeId: 'grip', shapeKind: kind,
  })).concat(extra);
  const voiced = new Map(notes.map((note, index) => [note, {string: index, fret: index === 0 ? 3 : 5}]));
  const fingers = new Map(notes.map((note, index) => [note, index === 0 ? 1 : 3]));
  const seats = new Map(notes.map(note => [note, 3]));
  const columns = handColumns(notes.filter(note => !note.gripOnly).map(note => ({
    start: note.start, end: note.end, seat: 3,
    fingers: [{note, ...voiced.get(note), finger: fingers.get(note), start: note.start, strikeStart: note.start}],
  })));
  return {notes, voiced, fingers, seats, columns};
}

for (const kind of ['handshape', 'arpeggio']) {
  const data = setup(kind), before = JSON.stringify(data.notes);
  const frames = fretboardShapeFrames(data, data.columns);
  assert.equal(frames.length, 1);
  const first = shapeHandAt(frames, 1, handAt(data.columns, 1, 0, GUITAR), GUITAR);
  assert.equal(first.marks.length, 3, 'all grip positions appear from the shape start');
  assert.equal(first.marks.filter(mark => !mark.shapeHeld).length, 1, 'only the picked string is active');
  assert.equal(first.marks.find(mark => mark.string === 1).finger, 3, 'held fingers come from the solver');
  const gap = shapeHandAt(frames, 1.3, null, GUITAR);
  assert.ok(gap.marks.every(mark => mark.shapeHeld), 'grip remains held in the gap between picks');
  assert.ok(gap.anchor, 'the hand anchor remains held between picks');
  for (const mark of gap.marks) {
    assert.equal(strikeTime(mark, 1.3), null, 'held positions have no pick attack');
    assert.equal(stringGlow(mark, 1.3), 0, 'held positions do not light strings');
    assert.equal(fretStrikeAt(mark, 1.3), null, 'held positions do not pulse');
  }
  for (const animate of [true, false]) {
    const at = shapeHandAt(frames, 1.5, null, GUITAR, animate);
    assert.equal(at.marks.length, 3);
    const picked = stringContactAt({at, t: 1.5}, 1);
    assert.ok(!picked.shapeHeld);
    assert.ok(stringGlow(picked, 1.5) > 0, 'the next picked string lights normally');
  }
  const originalPose = {pressed: false, marks: []};
  assert.equal(shapeHandAt(frames, .9, originalPose, GUITAR), originalPose);
  assert.equal(shapeHandAt(frames, 2.2, originalPose, GUITAR), originalPose, 'shape releases at its end');
  assert.equal(JSON.stringify(data.notes), before, 'display never changes authored notes');
}

{
  const held = {id: 'held', start: 1, end: 2.3, pitch: 50, shapeId: 'grip', shapeKind: 'handshape', gripOnly: true};
  const data = setup('handshape', [held]);
  const frames = fretboardShapeFrames(data, data.columns);
  assert.equal(frames[0].events.length, 3, 'grip-only notes never enter the picked timeline');
  const at = shapeHandAt(frames, 1.5, null, GUITAR);
  const mark = at.marks.find(mark => mark.note === held);
  assert.equal(mark.shapeHeld, true);
  assert.equal(stringGlow(mark, 1.5), 0);
}

{
  const data = setup();
  data.notes[0].end = 2.2;
  const frames = fretboardShapeFrames(data, data.columns);
  const pose = shapeHandAt(frames, 1.5, null, GUITAR);
  assert.equal(pose.marks.filter(mark => !mark.shapeHeld).length, 2, 'earlier picked strings can sustain under later picks');
}

{
  const data = setup();
  const repeat = {...data.notes[0], id: 'repeat', start: 1.7, end: 1.9};
  data.notes.push(repeat); data.voiced.set(repeat, {string: 0, fret: 3});
  data.fingers.set(repeat, 1); data.seats.set(repeat, 3);
  data.columns.push({start: 1.7, end: 1.9, fingers: [{note: repeat, string: 0, fret: 3, finger: 1, start: 1.7, strikeStart: 1.7}]});
  const frames = fretboardShapeFrames(data, data.columns);
  assert.equal(frames[0].contacts.length, 3, 'repeated picks share a single grip contact');
  const at = shapeHandAt(frames, 1.7, null, GUITAR);
  assert.equal(at.marks.filter(mark => mark.string === 0).length, 1);
  assert.equal(at.marks.find(mark => mark.string === 0).note, repeat);
  const animated = {...at.marks.find(mark => mark.note === repeat), lift: .7};
  assert.equal(shapeHandAt(frames, 1.7, {marks: [animated]}, GUITAR).marks.find(mark => mark.note === repeat), animated,
    'existing note technique animation is retained');
  data.voiced.set(repeat, {string: 0, fret: 7});
  assert.equal(fretboardShapeFrames(data, data.columns).length, 0, 'conflicting frets cannot form a held grip');
}

{
  const data = setup();
  data.notes.push({id:'outside', start: 1.7, end: 1.9, pitch: 60});
  assert.equal(fretboardShapeFrames(data, data.columns).length, 0, 'an unrelated note inside a shape invalidates the grip');
}
{
  const data = setup();
  for (const note of data.notes) note.gripOnly = true;
  assert.equal(fretboardShapeFrames(data, []).length, 0, 'a shape containing only grip-only notes has no playable frame');
}
{
  // Ab minor: one index barre and two separate fingers at fret 6. Picking one
  // string at a time must never shorten, split or fade the full index barre.
  const notes = [4,4,4,6,6,4].map((fret, string) => ({
    id: `ab-${string}`, start: 1 + string * .3, end: 1.15 + string * .3,
    pitch: [64,59,55,50,45,40][string] + fret, shapeId: 'ab', shapeKind: 'handshape',
  }));
  const voiced = new Map(notes.map((note, string) => [note, {string, fret: [4,4,4,6,6,4][string]}]));
  const fingers = new Map(notes.map((note, string) => [note, [1,1,1,4,3,1][string]]));
  const seats = new Map(notes.map(note => [note, 4]));
  const columns = handColumns(notes.map(note => ({start: note.start, end: note.end, seat: 4,
    fingers: [{note, ...voiced.get(note), finger: fingers.get(note), start: note.start}]})));
  const frames = fretboardShapeFrames({notes, voiced, fingers, seats}, columns);
  let geometry;
  for (const time of [1,1.2,1.3,1.6,1.9,2.2,2.5]) {
    const at = shapeHandAt(frames, time, null, GUITAR);
    const groups = barreGroups(at.gripMarks, true);
    const index = groups.find(group => group[0].finger === 1);
    assert.deepEqual(index.map(mark => mark.string).sort(), [0,1,2,5], 'full barre remains connected across every pick and gap');
    const snapshot = at.gripMarks.map(({string, fret, finger, x, lift, opacity}) => ({string,fret,finger,x,lift,opacity}));
    if (geometry) assert.deepEqual(snapshot, geometry, 'grip geometry and opacity stay constant');
    geometry = snapshot;
    assert.ok(at.gripMarks.every(mark => mark.opacity === 1 && strikeTime(mark, time) == null));
  }
}
console.log('Fretboard shapes: full grips, held contacts, attacks, repeats, sustains and boundaries passed');
