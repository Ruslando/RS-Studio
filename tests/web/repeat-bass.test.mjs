import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareCopy, copyOrigin, findRepeats, groupsFromRepeats, normalizeRepeatGroups, resolveRepeatGroups } from '../../web/repeats-core.js';
const rows = JSON.parse(readFileSync(new URL('./fixtures/kroi-bass-notes.json', import.meta.url))).notes;
const notesOf = () => rows.map(([pitch, start, end], i) => ({ id: `bass${i}`, pitch, start, end }));
const membership = groups => groups.map(g => g.copies.map(c => c.notes.map(e => e.note.id)));
const starts = [[2, 18], [34, 594], [66, 402, 626], [98, 130], [126, 462], [162, 178], [194, 530], [198, 230, 534], [244, 580],
  [274, 282, 290, 298, 306, 322, 338, 354, 378], [314, 330, 346, 362], [370, 386], [466], [514], [658]];
const lengths = [12, 32, 32, 28, 4, 16, 4, 10, 14, 6, 6, 8, 32, 16];

test('bass groups hold the recurring passages with every interior note', () => {
  const notes = notesOf(), original = structuredClone(notes), groups = findRepeats(notes);
  assert.deepEqual(groups.map(g => g.copies.length), starts.map(s => s.length));
  groups.forEach((g, i) => g.copies.forEach((c, j) => {
    const origin = copyOrigin(c);
    assert.ok(Math.abs(origin - starts[i][j]) < .01);
    if (i < lengths.length) assert.equal(c.phraseLength, lengths[i]);
    const expected = notes.filter(n => n.start >= origin - .06 && n.start < origin + c.phraseLength - .06);
    assert.deepEqual(c.notes.map(e => e.note.id), expected.map(n => n.id));
  }));
  const ids = membership(groups).flat(2);
  assert.equal(new Set(ids).size, ids.length, 'no shared notes between full phrases and their smaller components');
  assert.equal(groups[1].copies.at(-1).notes.length, 49, 'the anticipated final sustain belongs to the outro');
  assert.equal(groups.at(-1).copies[0].notes.length, 1, 'a final held cadence can stand alone');
  assert.deepEqual(notes, original);
});

test('one-off fills leave their group, and the riff they interrupt is one group across passages', () => {
  const notes = notesOf(), groups = findRepeats(notes);
  const grouped = new Set(groups.flatMap(g => g.copies.flatMap(c => c.notes.map(e => e.note.id))));
  const riff = groups[9];
  assert.equal(riff.copies.length, 9, 'the riff opening both the verse and the bridge phrases');
  assert.ok(riff.copies.every(c => c.notes.length >= 4 && c.notes.every(e => e.beat < 6 - .06)));
  // Each riff phrase ends on its own fill; none of them recurs.
  for (const origin of [274, 282, 290, 306, 322, 338, 354])
    assert.ok(notes.filter(n => n.start >= origin + 6.4 && n.start < origin + 8 - .06).every(n => !grouped.has(n.id)), `fill after ${origin}`);
  const ids = groups.flatMap(g => g.copies.flatMap(c => c.notes.map(e => e.note.id)));
  assert.equal(new Set(ids).size, ids.length);
});

test('bass families survive transposition, shuffled notes, moved origin and a different tempo', () => {
  const notes = notesOf(), expected = membership(findRepeats(notes));
  const changed = notes.toReversed().map(n => ({ ...n, pitch: n.pitch + 17,
    start: 12.375 + n.start * .63, end: 12.375 + n.end * .63 }));
  assert.deepEqual(membership(findRepeats(changed, t => (t - 12.375) / .63)), expected);
  const shifted = notes.map(n => ({ ...n, start: n.start + 3.375, end: n.end + 3.375 }));
  assert.deepEqual(membership(findRepeats(shifted)), expected, 'no absolute timestamp or fixed phase selects a passage');
});

test('saving and live resolution preserve phrase boundaries, late entries and interior additions', () => {
  const notes = notesOf(), groups = findRepeats(notes), saved = groupsFromRepeats(groups);
  assert.deepEqual(normalizeRepeatGroups(JSON.parse(JSON.stringify(saved)), notes), saved);
  const lane = { notes, repeatGroups: saved };
  const resolved = resolveRepeatGroups(lane);
  assert.deepEqual(membership(resolved), membership(groups));
  const chorus = resolved[8], last = chorus.copies[1];
  assert.ok(Math.abs(last.notes[0].beat - .5) < .01, 'late first attack does not move the phrase origin');
  assert.ok(Math.abs(copyOrigin(last) - 580) < .01);
  const comparison = compareCopy(chorus.copies[0], last);
  assert.ok(comparison.missing.some(e => Math.abs(e.beat) < .01), 'the absent opening attack stays inside the comparison');
  const added = { id: 'new-opening', pitch: 32, start: 580.0002, end: 580.4 };
  notes.push(added);
  const filled = resolveRepeatGroups(lane)[8].copies[1];
  assert.ok(filled.notes.some(e => e.note === added), 'filling the missing opening is reflected without rescanning');
  assert.ok(Math.abs(copyOrigin(filled) - 580) < .01);
  assert.equal(groupsFromRepeats(groups, saved)[0].id, saved[0].id, 'rescans keep group identity');
  // A group that splits on a rescan leaves its generated name behind; names stay unique.
  const earlier = saved.map((g, i) => ({ ...g, name: i === 1 ? 'Group I' : i === 2 ? 'Verse end' : g.name }));
  const names = groupsFromRepeats(groups, earlier).map(g => g.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names[1], 'Group B', 'a generated name follows the group\'s place');
  assert.equal(names[2], 'Verse end', 'a name the user gave is kept');
  assert.deepEqual(resolveRepeatGroups({ notes, repeatGroups: earlier }).map(g => g.name).filter(n => n.startsWith('Group')).length,
    names.length - 1, 'saved duplicates are renumbered without a rescan');
});

test('the worker carries inferred origins across its ID-only message boundary', async () => {
  const original = globalThis.self;
  try {
    let result;
    globalThis.self = { postMessage: data => { result = data; } };
    await import('../../web/repeats-worker.js');
    const notes = notesOf();
    self.onmessage({ data: notes });
    assert.equal(result.length, 15);
    assert.equal(result[8].phraseLength, 14);
    assert.ok(Math.abs(result[8].offsets[1] - .5) < .01);
    assert.equal(result.at(-1).copies[0].length, 1);
  } finally { globalThis.self = original; }
});

test('unrelated accompaniment phrases retain their full changing-root cycles with different fills', () => {
  let id = 0;
  const a = [[0, 2], [4, 5], [7, 9], [11, 2]], b = [[2, 7], [6, 9], [1, 4], [5, 10]];
  const notes = [a, b, a, b, a].flatMap((pattern, occurrence) => pattern.flatMap((roots, tile) => {
    const start = occurrence * 32 + tile * 8;
    return [0, .75, 1.5, 2, 2.75, 3.5, 4, 4.75, 5.5, 6, 6.75, 7.5].map((offset, k) => ({
      id: `unrelated${++id}`, start: start + offset, end: start + offset + .5,
      pitch: 36 + roots[k < 6 ? 0 : 1] + [0, 0, 0, 12, 7, occurrence % 2 ? 3 : 0][k % 6],
    }));
  }));
  const groups = findRepeats(notes);
  assert.deepEqual(groups.map(g => g.copies.map(c => copyOrigin(c))), [[0, 64, 128], [32, 96]]);
  assert.ok(groups.every(g => g.phraseLength === 32));
  assert.ok(groups.every(g => g.copies.every(c => c.notes.length === 48)));
});
