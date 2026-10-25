import assert from 'node:assert/strict';
import { GUITAR, fretDistance, placeAt } from '../../web/fretboard-core.js';

// Pointer → string and fret: strings 10 px apart, fret spaces from the scale.
const yOf = (i) => 100 + i * 10;
const mid = (n, s = GUITAR) => (fretDistance(n - 1, s.scale) + fretDistance(n, s.scale)) / 2;
assert.deepEqual(placeAt(mid(3), 120, yOf, GUITAR, 22), { string: 2, fret: 3 });
assert.deepEqual(placeAt(mid(1), 104, yOf, GUITAR, 22), { string: 0, fret: 1 });
assert.deepEqual(placeAt(-1, 150, yOf, GUITAR, 22), { string: 5, fret: 0 }, 'behind the nut is open');
assert.equal(placeAt(mid(3), 170, yOf, GUITAR, 22), null, 'off the strings');
const capo2 = { ...GUITAR, capo: 2 };
assert.deepEqual(placeAt(mid(3), 100, yOf, capo2, 20), { string: 0, fret: 1 }, 'frets count from the capo');
assert.deepEqual(placeAt(mid(1), 100, yOf, capo2, 20), { string: 0, fret: 0 }, 'under the capo is open');
console.log('fretboard place lookup passed');
