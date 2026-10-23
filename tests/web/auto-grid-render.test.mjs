import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { autoGridStep } from '../../web/auto-grid.js';

const segment = { t: 0, bpm: 120, tsNum: 4, tsDen: 4 };
const S = { pxPerSec: 120, state: { duration: 10 } };
const lines = [];
const { drawGrid } = await mockImport(new URL('../../web/note-render.js', import.meta.url), {
  './store.js': { S },
  './dom.js': { scroll: { scrollLeft: 0, clientWidth: 600 }, sctx: {} },
  './geometry.js': { contentH: () => 300, timeAt: x => x / S.pxPerSec, xOf: t => t * S.pxPerSec },
  './grid.js': { gridAt: () => segment, gridSegments: () => [segment],
    displayGridStep: seg => autoGridStep(seg, S.pxPerSec) },
  './timeline-paint.js': { paintTimeGridLine: (...args) => lines.push(args) },
}, { './auto-grid.js': true });
drawGrid();
assert.ok(lines.length > 1, 'grid rendering completes');
assert.equal(lines[1][1] - lines[0][1], 15, 'drawn line spacing matches adaptive snapping');
lines.length = 0; S.pxPerSec = 30;
drawGrid();
assert.equal(lines[1][1] - lines[0][1], 15, 'spacing adapts after zoom');
console.log('auto grid rendering: line spacing follows zoom');
