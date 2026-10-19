import assert from 'node:assert/strict';
import { adjacentMarkerTime } from '../../web/marker-navigation-core.js';

const markers = [{ t: 12 }, { t: 4 }, { t: 0 }, { t: 12 }, { t: 6 }, { t: NaN }, { t: -1 }, { t: 30 }];
assert.equal(adjacentMarkerTime(markers, 0, 1, 20), 4);
assert.equal(adjacentMarkerTime(markers, 5, -1, 20), 4);
assert.equal(adjacentMarkerTime(markers, 12, -1, 20), 6);
assert.equal(adjacentMarkerTime(markers, 6, 1, 20), 12, 'coincident kinds are one navigation stop');
assert.equal(adjacentMarkerTime(markers, 12 + 1e-7, -1, 20), 6, 'seek rounding must not revisit the current marker');
assert.equal(adjacentMarkerTime(markers, 0, -1, 20), null);
assert.equal(adjacentMarkerTime(markers, 12, 1, 20), null, 'no wrap and no markers beyond the song');
assert.equal(adjacentMarkerTime([], 5, 1), null);
assert.equal(adjacentMarkerTime(markers, NaN, 1), null);
console.log('marker navigation: ok');
