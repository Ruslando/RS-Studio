import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { soundingColumns } from '../../web/voicing-core.js';

// Exercise the live selection writer without loading the canvas/DOM graph.
const source = readFileSync(new URL('../../web/fretboard.js', import.meta.url), 'utf8');
const select = source.match(/function selectPlayheadNotes\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(select);
// a is held while the chord b+c starts over it: two columns, not one chord.
const a = { start: 0, end: 2, pitch: 52 };
const b = { start: 1, end: 2, pitch: 55 };
const c = { start: 1, end: 2, pitch: 59 };
const later = { start: 4, end: 5, pitch: 52 };
const lane = { notes: [a, b, c, later] };
function run(t, overrides = {}) {
  let selection = new Set([later]);
  const env = { currentLane: () => lane, visible: true, editing: true,
    transportPlaying: () => false, canEditLane: () => true, soundingColumns,
    boardTime: () => t, setSelection: next => { selection = next; }, ...overrides };
  new Function(...Object.keys(env), `${select}; selectPlayheadNotes();`)(...Object.values(env));
  return selection;
}
assert.deepEqual([...run(1)], [b, c], 'only the latest onset column is selected; held notes are another voice');
assert.deepEqual([...run(0.5)], [a], 'a lone held note is selected');
assert.equal(run(2).size, 0, 'released notes are not selected');
assert.equal(run(3).size, 0, 'rests clear the previous edit target');
assert.deepEqual([...run(4)], [later], 'seeking retargets the edit selection');
for (const guard of [{ visible: false }, { editing: false },
  { transportPlaying: () => true }, { canEditLane: () => false }]) {
  assert.deepEqual([...run(1, guard)], [later], 'preview/playback/read-only states preserve explicit selection');
}
assert.deepEqual(soundingColumns(lane.notes, 1.5).map(col => col.notes), [[a], [b, c]], 'sounding columns run low to high');
