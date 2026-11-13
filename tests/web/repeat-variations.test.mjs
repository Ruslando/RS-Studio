import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findRepeats, groupsFromRepeats, normalizeRepeatGroups, resolveRepeatGroups } from '../../web/repeats-core.js';
import { repeatVariations } from '../../web/repeat-variations.js';

test('recurring phrase versions are groups of their own; recurring single-note changes are variations', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/kroi-bass-notes.json', import.meta.url))).notes;
  const notes = rows.map(([pitch, start, end], i) => ({ id: `v${i}`, pitch, start, end }));
  const found = findRepeats(notes), saved = groupsFromRepeats(found);
  // The main passage has two endings and bar 3-4 rhythms, each played more than once.
  assert.deepEqual(found.slice(1, 3).map(g => g.copies.map(c => Math.round(c.notes[0].note.start))), [[34, 594], [66, 402, 626]]);
  assert.ok(found.slice(1, 3).every(g => g.phraseLength === 32));
  const riff = saved[9];
  assert.deepEqual(riff.variations.map(v => v.copies.map(key => riff.copies.findIndex(ids => ids[0] === key) + 1)), [[1, 7, 8], [3, 4, 5, 6], [2, 9]]);
  assert.deepEqual(normalizeRepeatGroups(JSON.parse(JSON.stringify(saved)), notes), saved);
  assert.deepEqual(resolveRepeatGroups({ notes, repeatGroups: saved })[9].variations, riff.variations);
  riff.variationMode = 'manual';
  const moved = riff.variations[0].copies.pop(); riff.variations[1].copies.push(moved);
  assert.deepEqual(groupsFromRepeats(found, saved)[9].variations, riff.variations, 'manual assignments survive rescanning');
});

test('variation detection ignores techniques and fingering, and leaves isolated mistakes within a variation', () => {
  const copy = (i, length = .5) => ({ ids: [`copy${i}`], notes: Array.from({ length: 8 }, (_, k) => ({ beat: k,
    note: { id: `${i}:${k}`, start: i * 10 + k, end: i * 10 + k + length, pitch: 40 + k,
      finger: i, pos: { string: i, fret: k }, fx: { vibrato: i % 2 === 0 }, handAnchor: i },
  })) });
  const copies = [copy(0), copy(1), copy(2), copy(3)];
  assert.equal(repeatVariations({ copies }).length, 0);
  copies[3].notes[2].note.pitch++;
  assert.equal(repeatVariations({ copies }).length, 0, 'a lone wrong note is a difference, not a recurring variation');
  copies[2] = copy(2, .9); copies[3] = copy(3, .9);
  assert.deepEqual(repeatVariations({ copies }).map(v => v.copies), [['copy0', 'copy1'], ['copy2', 'copy3']], 'repeated length changes define a different pattern');
});

test('unique patterns need no subgroups; recurring patterns collect singletons as other variations', () => {
  const copy = (id, pitch) => ({ ids: [id], notes: [{ beat: 0, note: { id, start: 0, end: 1, pitch } }] });
  const a = copy('a', 40), b = copy('b', 41), c = copy('c', 42);
  assert.deepEqual(repeatVariations({ copies: [a, b, c] }), []);
  assert.deepEqual(repeatVariations({ copies: [a, copy('a2', 40), b, c] }), [
    { id: 'variation_1', name: 'Variation A', copies: ['a', 'a2'] },
    { id: 'variation_other', name: 'Other variations', copies: ['b', 'c'] },
  ]);
});
