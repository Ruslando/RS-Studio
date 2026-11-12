import assert from 'node:assert/strict';
import { boundRepeat, compareCopy, findRepeats, groupsFromRepeats, resolveRepeatGroups } from '../../web/repeats-core.js';
const pitches = Array.from({ length: 16 }, (_, i) => 40 + i);
let id = 0;
const at = (start, values = pitches) => values.map((pitch, i) => ({ id: `boundary${++id}`, pitch, start: start + i / 2, end: start + i / 2 + .4 }));
const passage = notes => ({ notes: notes.map(note => ({ note, beat: note.start - notes[0].start })) });

// Kroi Lead's failure: three notes of the model continue after the other copy
// ends. A high overall similarity must not claim that unrelated trailing music.
{
  const core = at(0), trailing = at(9, [65, 77, 77]), other = at(20);
  const notes = [...core, ...trailing, ...other], unchanged = structuredClone(notes);
  const found = findRepeats(notes);
  const repeat = found.find(group => group.copies.some(copy => copy.notes[0].note === core[0]));
  assert.ok(repeat);
  assert.deepEqual(repeat.copies.map(copy => copy.notes.length), [16, 16]);
  assert.ok(repeat.copies.every(copy => copy.notes.every(entry => !trailing.includes(entry.note))));
  assert.equal(compareCopy(repeat.copies[0], repeat.copies[1]).missing.length, 0);
  assert.deepEqual(notes, unchanged, 'trimming group membership never deletes or edits song notes');

  // Existing saved groups receive the same correction without requiring the
  // caller to paint-clip markers or overwrite a project on disk.
  const legacy = { id: 'repeat_2', name: 'Group 2', copies: [[...core, ...trailing].map(n => n.id), other.map(n => n.id)] };
  const lane = { notes, repeatGroups: [legacy] }, saved = structuredClone(lane.repeatGroups);
  const resolved = resolveRepeatGroups(lane);
  assert.deepEqual(resolved[0].copies.map(copy => copy.notes.length), [16, 16]);
  assert.equal(compareCopy(resolved[0].copies[0], resolved[0].copies[1]).missing.length, 0);
  assert.deepEqual(lane.repeatGroups, saved, 'resolving legacy groups is read-only');
  const rescanned = groupsFromRepeats(found, lane.repeatGroups);
  assert.equal(rescanned[0].name, 'Group A');
  assert.ok(rescanned[0].copies.every(copy => trailing.every(note => !copy.includes(note.id))), 'rescans persist only the shared passage');
}
// One common opening and ending across ALL copies, with a genuine gap inside.
{
  const a = at(0), b = at(20), c = at(40, pitches.slice(0, 14));
  const missing = c.splice(5, 1)[0];
  const repeat = boundRepeat({ copies: [passage(a), passage(b), passage(c)] });
  assert.deepEqual(repeat.copies.map(copy => copy.notes.length), [14, 14, 13]);
  const comparison = compareCopy(repeat.copies[0], repeat.copies[2]);
  assert.deepEqual(comparison.missing.map(entry => entry.note.pitch), [missing.pitch]);
  assert.ok(comparison.missing.every(entry => entry.beat >= 0 && entry.beat <= repeat.copies[2].notes.at(-1).beat));
  assert.ok(repeat.copies.slice(0, 2).every(copy => copy.notes.every(e => e.note.pitch <= 53)));
  const discovered = findRepeats([...a, ...b, ...c]);
  const shared = discovered.find(group => group.copies.some(copy => copy.notes[0].note === a[0]));
  assert.deepEqual(shared.copies.map(copy => copy.notes.length), [14, 14, 13], 'detection also intersects the boundaries across all three occurrences');

}
// A leading prefix and trailing tail are not mistaken for interior gaps.
{
  const a = at(0), b = at(20);
  const prefix = { id: 'prefix', start: -1, end: -.5, pitch: 80 }, suffix = { id: 'suffix', start: 9, end: 10, pitch: 81 };
  const model = { notes: [prefix, ...a, suffix].map(note => ({ note, beat: note.start })) };
  const bounded = boundRepeat({ copies: [model, passage(b)] });
  assert.deepEqual(bounded.copies[0].notes.map(e => e.note.id), a.map(n => n.id));
  assert.equal(compareCopy(model, passage(b)).missing.length, 0);
}
// A changed edge pitch is still a played note; a missing chord tone is still an
// interior difference at the shared attack, including at a pitch-range edge.
{
  const a = at(0), b = at(20);
  b[0].pitch = 30; b.at(-1).pitch = 80;
  const bounded = boundRepeat({ copies: [passage(a), passage(b)] });
  assert.deepEqual(bounded.copies.map(copy => copy.notes.length), [16, 16]);
  assert.equal(compareCopy(...bounded.copies).changes.length, 2);
  const chordA = { notes: [40, 44, 47, 80].map((pitch, i) => ({ note: { id: `a${i}`, start: 0, end: 1, pitch }, beat: 0 })) };
  const chordB = { notes: [40, 44, 47].map((pitch, i) => ({ note: { id: `b${i}`, start: 10, end: 11, pitch }, beat: 0 })) };
  assert.equal(compareCopy(chordA, chordB).missing[0].note.pitch, 80, 'a missing pitch at a common onset remains in the passage');
}
console.log('Repeat boundaries exclude outside tails and preserve interior omissions');

{
  const a = at(0), b = at(20), tail = at(10, [80, 81, 82, 83]), tailAgain = at(40, [80, 81, 82, 83]);
  const found = findRepeats([...a, ...tail, ...b, ...tailAgain]);
  assert.ok(found.some(group => group.copies.length === 2 && group.copies.every(copy => copy.notes.length === 16)));
  assert.ok(found.some(group => group.copies.some(copy => copy.notes[0].note === tail[0]) && group.copies.length === 2),
    'excluded trailing notes remain available to form their own repeated passage');
}

// Manual drawing, replacement, deletion and undo all resolve from live notes.
{
  const a = at(0), b = at(20), omitted = b.splice(5, 1)[0];
  const lane = { notes: [...a, ...b], repeatGroups: [{ id: 'live', name: 'Live', copies: [a.map(n => n.id), b.map(n => n.id)] }] };
  const saved = structuredClone(lane.repeatGroups);
  const compare = () => { const group = resolveRepeatGroups(lane)[0]; return compareCopy(...group.copies); };
  assert.equal(compare().missing.length, 1);
  const replacement = { ...omitted, id: 'manually-drawn' };
  lane.notes.push(replacement);
  assert.equal(compare().missing.length, 0, 'a manually added note fills the missing slot without rescanning');
  replacement.pitch++;
  assert.equal(compare().missing.length, 0);
  assert.ok(compare().changes.some(change => change.to === replacement), 'edits to the new note remain comparable');
  const outside = { ...replacement, id: 'outside-live', start: 19, end: 19.4 };
  lane.notes.push(outside);
  assert.ok(!resolveRepeatGroups(lane)[0].copies.some(copy => copy.notes.some(e => e.note === outside)));
  lane.notes = lane.notes.filter(note => note !== replacement);
  assert.equal(compare().missing.length, 1, 'deleting the replacement restores the missing status');
  lane.notes.push(replacement);
  assert.equal(compare().missing.length, 0, 'undo restores live membership');
  assert.deepEqual(lane.repeatGroups, saved, 'live resolution does not rewrite saved groups');
}
