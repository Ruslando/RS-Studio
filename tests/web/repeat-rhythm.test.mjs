import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findRepeats, groupsFromRepeats, normalizeRepeatGroups, resolveRepeatGroups } from '../../web/repeats-core.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kroi-rhythm-notes.json', import.meta.url)));
const notesOf = () => fixture.notes.map(([pitch, start, end], i) => ({ id: `rhythm${i}`, pitch, start, end }));
const membership = groups => groups.map(g => g.copies.map(c => c.notes.map(e => e.note.id)));

test('Kroi rhythm has complete progressions, bridge figures and a single whole outro', () => {
  const notes = notesOf(), original = structuredClone(notes), groups = findRepeats(notes);
  assert.deepEqual(groups.map(g => g.copies.length), [5, 4, 4, 2, 1]);
  const bounds = [
    [[34, 63], [66, 95], [402, 431], [594, 623], [626, 655]],
    [[194, 225.5], [226, 257.5], [530, 561.5], [562, 593.5]],
    [[306, 321], [322, 337], [338, 353], [354, 369]],
    [[370, 377], [386, 393]],
    [[657.992737, 692.233167]],
  ];
  groups.forEach((group, i) => group.copies.forEach((copy, j) => {
    assert.ok(Math.abs(copy.notes[0].note.start - bounds[i][j][0]) < .01);
    assert.ok(Math.abs(copy.notes.at(-1).note.start - bounds[i][j][1]) < .01);
    const inside = notes.filter(n => n.start >= copy.notes[0].note.start && n.start <= copy.notes.at(-1).note.start);
    assert.deepEqual(new Set(copy.notes.map(e => e.note.id)), new Set(inside.map(n => n.id)), 'all notes inside the passage belong, including every chord voice');
  }));
  assert.deepEqual(groups.map(g => g.copies.map(c => c.notes.length)), [
    [274, 274, 274, 274, 274], [274, 274, 274, 274], [19, 19, 19, 19], [10, 10], [479],
  ]);
  const ids = membership(groups).flat(2);
  assert.equal(new Set(ids).size, ids.length, 'groups never share notes');
  assert.deepEqual(notes, original, 'discovery does not edit project notes');
  const saved = groupsFromRepeats(groups);
  assert.deepEqual(normalizeRepeatGroups(saved, notes), saved, 'single-instance groups survive normalization');
  assert.deepEqual(membership(resolveRepeatGroups({ notes, repeatGroups: saved })), membership(groups), 'all memberships survive saving and live resolution');
});

test('rhythm grouping depends on notes rather than project pitches, order or time origin', () => {
  const notes = notesOf(), baseline = membership(findRepeats(notes));
  const transformed = notes.toReversed().map(n => ({ ...n, pitch: n.pitch + 5, start: 17 + n.start * .7, end: 17 + n.end * .7 }));
  assert.deepEqual(membership(findRepeats(transformed, t => (t - 17) / .7)), baseline);
});

let uid = 0;
const chord = (start, pitches, offsets) => offsets.flatMap(offset => pitches.map(pitch => ({
  id: `synthetic${++uid}`, pitch, start: start + offset, end: start + offset + .2,
})));
test('a new strumming groove stays a whole passage despite internal repeated chords', () => {
  const a = [40, 44, 47], b = [42, 46, 49], c = [45, 49, 52], d = [47, 51, 54];
  const groove = [0, .5, 2 / 3, 5 / 6, 1, 1.5, 2, 2.25, 2.5, 3, 3.5];
  const notes = [a, b, a, b, c, a, c, d].flatMap((pitches, i) => chord(i * 4, pitches, groove));
  const groups = findRepeats(notes);
  assert.deepEqual(groups.map(g => g.copies.length), [1]);
  assert.equal(groups[0].copies[0].notes.length, notes.length);
});

test('multiple one-off passages remain separate and do not absorb notes across rests', () => {
  const progression = [[40, 44, 47], [42, 46, 49], [40, 44, 47], [42, 46, 49],
    [45, 49, 52], [40, 44, 47], [45, 49, 52], [47, 51, 54]];
  const groove = [0, .5, 2 / 3, 5 / 6, 1, 1.5, 2, 2.25, 2.5, 3, 3.5];
  const first = progression.flatMap((pitches, i) => chord(i * 4, pitches, groove));
  const second = progression.flatMap((pitches, i) => chord(60 + i * 4, pitches.map(p => p + 1), groove));
  const isolated = [45, 120].map(start => ({ id: `isolated${start}`, pitch: 70, start, end: start + .2 }));
  const groups = findRepeats([...first, ...second, ...isolated]);
  assert.deepEqual(groups.map(g => g.copies.length), [1, 1]);
  assert.deepEqual(membership(groups), [[first.map(n => n.id)], [second.map(n => n.id)]]);
});

test('choosing phrase families keeps a progression whole despite an extra isolated half', () => {
  const a = [40, 44, 47], b = [42, 46, 49];
  const picked = (start, pitches) => [...chord(start, pitches, [0]), ...[0, 1, 2, 0].map((p, i) => ({
    id: `synthetic${++uid}`, pitch: pitches[p], start: start + [3, 4, 5.5, 7][i], end: start + 8,
  }))];
  const notes = [a, b, a, b, a, b, a, b, a].flatMap((pitches, i) => picked(i * 8, pitches));
  const groups = findRepeats(notes);
  assert.equal(groups.length, 1, 'an extra half does not justify splitting the recurring progression into two families');
  assert.deepEqual(groups[0].copies.map(c => c.notes[0].note.start), [0, 16, 32, 48]);
  assert.ok(groups[0].copies.every(c => c.notes.length === 14));
});
