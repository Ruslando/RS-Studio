import assert from 'node:assert/strict';
import { findRepeats, playLike, playsDifferently, compareCopy, normalizeRepeatGroups, groupsFromRepeats, resolveRepeatGroups } from '../../web/repeats-core.js';
const riff = [40, 43, 45, 47, 45, 43, 40, 38];
let uid = 0;
const at = (start, pitches = riff, offsets = pitches.map((_, i) => i * 0.5)) => pitches.map((pitch, i) => ({
  id: `n${++uid}`, start: start + offsets[i], end: start + offsets[i] + 0.4, pitch,
  pos: { string: 5, fret: pitch - 35 },
}));

// Arbitrary note boundaries, with a changed final note; no bar data is supplied.
const a = at(.3), b = at(9.7, [...riff.slice(0, 7), 36]), c = at(23.2);
a[0].motifId = 'motif_v2_1'; a[0].motifName = 'Intro';
b[1].shapeId = 'shape_2'; b[1].shapeKind = 'handshape';
const notes = [...a, ...b, ...c];
const before = structuredClone(notes);
const repeats = findRepeats(notes);
assert.equal(repeats.length, 1);
assert.deepEqual(repeats[0].copies.map(c => c.notes.length), [8, 8, 8]);
assert.deepEqual(repeats[0].copies.map(c => c.notes[0].note.start), [.3, 9.7, 23.2]);
assert.deepEqual(notes, before, 'detection never changes notes or their existing markings');
assert.equal(playsDifferently(repeats[0]), false, 'already consistent repeats are still grouped');
assert.equal(compareCopy(repeats[0].copies[0], repeats[0].copies[1]).vary, 1);
c[2].pos = { string: 4, fret: 0 }; c[2].finger = 1;
assert.equal(playsDifferently(repeats[0]), true);
assert.equal(playLike(repeats[0], repeats[0].copies[0]), 1);
assert.deepEqual(c[2].pos, a[2].pos);
assert.equal(c[2].finger, undefined);
assert.deepEqual(b[7].pos, before[15].pos, 'variation retains its own fingering');
c[3].finger = 4;
assert.equal(playsDifferently(repeats[0]), true, 'finger-only differences count');

// An empty stretch inside a phrase does not break discovery.
{
  const offsets = [0, .5, 1, 1.5, 9, 9.5, 10, 10.5];
  const found = findRepeats([...at(.1, riff, offsets), ...at(30.6, riff, offsets)]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].copies.map(c => c.notes.length), [8, 8]);
}
// Missing and inserted onsets remain variations rather than shifting the suffix.
{
  const source = at(.25), target = at(10.8);
  target.splice(3, 1);
  const found = findRepeats([...source, ...target]);
  assert.equal(found[0].copies.length, 2);
  assert.equal(compareCopy(found[0].copies[0], found[0].copies[1]).pairs.length, 7);
  const extra = { id: 'extra', start: 12.55, end: 12.7, pitch: 60 };
  const inserted = findRepeats([...source, ...at(10.8), extra]);
  assert.equal(inserted[0].copies.length, 2);
  assert.equal(compareCopy(inserted[0].copies[0], inserted[0].copies[1]).vary, 1);
}
// Chords are unordered pitches at a shared onset; grip-only helpers are excluded.
{
  const chord = [40, 45, 50, 55];
  const found = findRepeats([...at(0, chord, [0, 0, 0, 0]), ...at(5, chord.toReversed(), [0, 0, 0, 0]),
    { id: 'helper', start: 0, end: 1, pitch: 60, gripOnly: true }]);
  assert.deepEqual(found, [], 'a repeated chord alone is not a recurring phrase');
  const progression = [40, 45, 50, 55, 42, 47, 52, 57, 43, 48, 53, 58, 45, 50, 55, 60];
  const offsets = progression.map((_, i) => Math.floor(i / 4));
  const phrases = findRepeats([...at(0, progression, offsets), ...at(10, progression, offsets)]);
  assert.equal(phrases.length, 1); assert.deepEqual(phrases[0].copies.map(c => c.notes.length), [16, 16]);
}
// Tempo changes: matching uses each layer's beat clock, not absolute seconds.
{
  const source = at(0), target = at(10, riff, riff.map((_, i) => i * .25));
  const found = findRepeats([...source, ...target], t => t < 10 ? t : 10 + (t - 10) * 2);
  assert.equal(found[0].copies.length, 2);
}
// Repeated consecutive figures form one group of occurrences, with no overlaps.
{
  const notes = Array.from({ length: 20 }, (_, i) => at(i * 4)).flat();
  const found = findRepeats(notes);
  assert.equal(found.length, 1); assert.equal(found[0].copies.length, 20);
  assert.ok(found[0].copies.every(c => c.notes.length === 8));
  assert.equal(new Set(found.flatMap(r => r.copies.flatMap(c => c.notes.map(n => n.note.id)))).size, notes.length);
}
assert.deepEqual(findRepeats(at(0, [40, 41, 42, 43, 44, 45])), [], 'unrelated notes are left alone');
assert.deepEqual(findRepeats([]), []);
assert.deepEqual(findRepeats(at(0, [40, 40, 40])), [], 'too few notes');

{
  const found = findRepeats([...at(.3), ...at(10.6, [42, ...riff.slice(1)])]);
  assert.deepEqual(found[0].copies.map(c => c.notes.length), [8, 8], 'a changed leading note stays inside the repeated phrase');
  assert.equal(compareCopy(found[0].copies[0], found[0].copies[1]).vary, 1);
}

// Project/undo representation: stable ids resolve new note objects after restore.
{
  const saved = groupsFromRepeats(repeats);
  assert.equal(saved[0].name, 'Group A');
  saved[0].name = 'Verse riff';
  assert.deepEqual(groupsFromRepeats(repeats, saved), saved, 'rescan preserves names and ids');
  const lane = { notes: structuredClone(notes), repeatGroups: JSON.parse(JSON.stringify(saved)) };
  const resolved = resolveRepeatGroups(lane);
  assert.equal(resolved[0].name, 'Verse riff');
  assert.equal(resolved[0].copies.length, 3);
  assert.equal(resolved[0].copies[0].notes[0].note, lane.notes[0]);
  lane.notes.splice(0, 1);
  assert.equal(resolveRepeatGroups(lane)[0].copies[0].notes.length, 7, 'deleted notes disappear from membership');
  assert.deepEqual(normalizeRepeatGroups(saved, notes), saved);
  const malformed = [null, {}, { id: 'x', copies: [[notes[0].id, notes[0].id, 'gone'], null, [notes[1].id]], name: 5 }];
  assert.deepEqual(normalizeRepeatGroups(malformed, notes), [{ id: 'x', name: 'Group', copies: [[notes[0].id], [notes[1].id]] }]);
}
console.log('repeats-core: ok');

// A pitch substitution is not a missing note. Content, placement and finger
// changes remain separately inspectable, including simultaneous differences.
{
  const source = at(0), target = at(10);
  target[1].pitch = 99;
  target[3].pos = { string: 4, fret: 10 };
  target[4].fx = { palmMute: true };
  target[5].finger = 3; source[5].finger = 1;
  target.splice(6, 1);
  const copy = notes => ({ notes: notes.map(note => ({ note, beat: note.start - notes[0].start })) });
  const result = compareCopy(copy(source), copy(target));
  assert.equal(result.changes.length, 2, 'pitch and technique are changes to existing notes');
  assert.deepEqual(result.changes.map(c => c.fields), [['technique'], ['pitch']]);
  assert.equal(result.missing.length, 1, 'only the removed note is genuinely missing');
  assert.equal(result.missing[0].note, source[6]);
  assert.equal(result.added.length, 0, 'a pitch substitution is not an extra note');
  assert.equal(result.positionDifferences.length, 1);
  assert.equal(result.fingerDifferences.length, 1);
  assert.equal(result.playedDifferently, 3);
  assert.equal(result.differ, 2, 'legacy position application still sees either placement or finger changes');
  const extra = { id: 'added', pitch: 100, start: 10.75, end: 10.9 };
  assert.equal(compareCopy(copy(source), copy([...target, extra])).added.length, 1);
}
{
  const source = at(0), target = at(10, riff, riff.map((_, i) => i * .25));
  target.forEach(note => { note.end = note.start + .2; });
  const copy = notes => ({ notes: notes.map((note, i) => ({ note, beat: i * .5 })) });
  const beatAt = t => t < 10 ? t : 10 + (t - 10) * 2;
  assert.equal(compareCopy(copy(source), copy(target), beatAt).changes.length, 0, 'tempo-normalized durations compare equally');
  target[2].end += .25;
  target[4].fx = { palmMute: false };
  assert.deepEqual(compareCopy(copy(source), copy(target), beatAt).changes.map(c => c.fields), [['length']], 'duration changes count; disabled effects do not');
}

// Generated fingers use the same note ids as the fretboard's handed result.
{
  const source = at(0), target = at(10);
  const copy = notes => ({ notes: notes.map((note, i) => ({ note, beat: i / 2 })) });
  const a = copy(source), b = copy(target);
  const fingers = new Map([[source[2].id, 1], [target[2].id, 4]]);
  assert.equal(compareCopy(a, b, t => t, fingers).fingerDifferences.length, 1);
  assert.equal(playLike({ copies: [a, b] }, a, fingers), 1, 'applying the first occurrence includes its generated finger');
  assert.equal(target[2].finger, 1);
  delete target[2].finger;
  target[3].finger = -1;
  assert.equal(compareCopy(a, b).fingerDifferences.length, 0, 'absent and no-finger values mean the same thing');
}

// Navigation follows names rather than the persisted/discovery order.
{
  const copies = at(0), later = at(10);
  const lane = { notes: [...copies, ...later], repeatGroups: [
    { id: 'z', name: 'Group Z', copies: [copies.map(n => n.id)] },
    { id: 'a', name: 'Group A', copies: [later.map(n => n.id)] },
  ] };
  assert.deepEqual(resolveRepeatGroups(lane).map(g => g.name), ['Group A', 'Group Z']);
}
