import assert from 'node:assert/strict';
import { autoGridStep, gridLineKind } from '../../web/auto-grid.js';

const segment = { t: .2, bpm: 120, tsNum: 4, tsDen: 4 };
assert.equal(autoGridStep(segment, 30), .5, 'zoomed out uses quarter notes');
assert.equal(autoGridStep(segment, 120), .125, 'normal zoom uses sixteenths');
assert.equal(autoGridStep(segment, 240), .0625, 'zooming in exposes thirty-seconds');
assert.equal(autoGridStep(segment, 5000), .0625, 'finest step is 1/32');
assert.equal(autoGridStep(segment, 12), 1, 'coarse zoom can use half notes');
assert.equal(autoGridStep(segment, 3), 4, 'very coarse zoom shows two-bar steps');
assert.equal(gridLineKind(.2, segment), 'bar');
assert.equal(gridLineKind(.7, segment), 'beat');
assert.equal(gridLineKind(.325, segment), 'sub');
assert.equal(autoGridStep({ ...segment, bpm: 0 }, 120), 0);
const compound = { t: 0, bpm: 120, tsNum: 6, tsDen: 8 };
for (const pixels of [3, 12, 30, 120, 500]) {
  const step = autoGridStep(compound, pixels);
  assert.ok(step * pixels >= 12, 'grid cells remain visibly separated');
  assert.ok(step >= .0625, 'meter does not create finer than 1/32');
}
console.log('auto grid: zoom, meter, subdivisions and visible labels passed');
