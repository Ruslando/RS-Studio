import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { soundingColumns } from '../../web/voicing-core.js';

// The column under the playhead, read without loading the canvas/DOM graph.
// Pausing no longer selects it; it is only the fallback focus of the board.
const source = readFileSync(new URL('../../web/fretboard.js', import.meta.url), 'utf8');
const fn = source.match(/function playheadColumnNote\(lane\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(fn);
assert.ok(!/setSelection/.test(source), 'the board never selects notes on its own');
// a is held while the chord b+c starts over it: two columns, not one chord.
const a = { start: 0, end: 2, pitch: 52 };
const b = { start: 1, end: 2, pitch: 55 };
const c = { start: 1, end: 2, pitch: 59 };
const later = { start: 4, end: 5, pitch: 52 };
const lane = { notes: [a, b, c, later] };
const at = (t) => new Function('soundingColumns', 'boardTime', 'lane', `${fn}; return playheadColumnNote(lane);`)(soundingColumns, () => t, lane);
assert.equal(at(1), b, 'only the latest onset column; held notes are another voice');
assert.equal(at(0.5), a, 'a lone held note');
assert.equal(at(2), null, 'released notes are not focused');
assert.equal(at(4), later);
assert.deepEqual(soundingColumns(lane.notes, 1.5).map(col => col.notes), [[a], [b, c]], 'sounding columns run low to high');
