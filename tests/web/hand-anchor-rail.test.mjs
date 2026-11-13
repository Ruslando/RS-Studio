import assert from 'node:assert/strict';
import { seatChanges } from '../../web/hand-anchor-core.js';

// The rail flags every seat change, automatic or chosen; open strings keep the hand.
const notes = [0, 1, 2, 3, 4].map(t => ({ start: t }));
const seats = new Map([[notes[0], 5], [notes[1], 5], [notes[3], 7], [notes[4], 5]]);
assert.deepEqual(seatChanges(notes, seats), [{ t: 0, fret: 5 }, { t: 3, fret: 7 }, { t: 4, fret: 5 }]);
