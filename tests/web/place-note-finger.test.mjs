import assert from 'node:assert/strict';
import { placeNote } from '../../web/voicing-core.js';

// A typed finger belongs to the place it was typed at: moving the note drops it.
const moved = { pitch: 47, finger: 4, pos: { string: 2, fret: 14 } };
placeNote(moved, { string: 0, fret: 4, scope: 'local' });
assert.equal(moved.finger, undefined, 'moved from fret 14 to 4: the old pinky goes');
assert.deepEqual(moved.pos, { string: 0, fret: 4, scope: 'local' });
const kept = { pitch: 47, finger: 4, pos: { string: 2, fret: 14 } };
placeNote(kept, { string: 2, fret: 14, scope: 'local', follow: 'guided' });
assert.equal(kept.finger, 4, 'pinned where it already is: the finger stays');
console.log('place-note-finger: ok');
