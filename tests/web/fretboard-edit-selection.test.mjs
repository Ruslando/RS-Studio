import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the live selection writer without loading the canvas/DOM graph.
const source = readFileSync(new URL('../../web/fretboard.js', import.meta.url), 'utf8');
const select = source.match(/function selectPlayheadNotes\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(select);
const a = { start: 0, end: 2, pitch: 52 };
const b = { start: 1, end: 2, pitch: 55 };
const c = { start: 1, end: 2, pitch: 59 };
const later = { start: 4, end: 5, pitch: 52 };
const lane = { notes: [a, b, c, later] };
function run(t, overrides = {}) {
  let selection = new Set([later]);
  const env = { currentLane: () => lane, visible: true, editing: true,
    transportPlaying: () => false, canEditLane: () => true,
    boardTime: () => t, setSelection: next => { selection = next; }, ...overrides };
  new Function(...Object.keys(env), `${select}; selectPlayheadNotes();`)(...Object.values(env));
  return selection;
}
assert.deepEqual([...run(1)], [a, b, c], 'all overlapping notes become real selection members');
const extended = run(1);
extended.add(later);
assert.deepEqual([...extended], [a, b, c, later], 'additive selection retains the notes at the playhead');
assert.equal(run(2).size, 0, 'released notes are not selected');
assert.equal(run(3).size, 0, 'rests clear the previous edit target');
assert.deepEqual([...run(4)], [later], 'seeking retargets the edit selection');
for (const guard of [{ visible: false }, { editing: false },
  { transportPlaying: () => true }, { canEditLane: () => false }]) {
  assert.deepEqual([...run(1, guard)], [later], 'preview/playback/read-only states preserve explicit selection');
}
