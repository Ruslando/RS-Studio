import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { autoGridStep } from '../../web/auto-grid.js';

const segment = { t: 0, bpm: 120, tsNum: 4, tsDen: 4 };
const S = { pxPerSec: 120, mouseX: 150, state: { duration: 10 } };
const status = { textContent: '' }, lines = [], requested = [];
const savedDocument = globalThis.document;
try {
  globalThis.document = { getElementById: id => id === 'autoGridStatus' ? status : null };
  const { drawGrid } = await mockImport(new URL('../../web/note-render.js', import.meta.url), {
    './store.js': { S },
    './dom.js': { scroll: { scrollLeft: 0, clientWidth: 600 }, sctx: {} },
    './geometry.js': { contentH: () => 300, timeAt: x => x / S.pxPerSec, xOf: t => t * S.pxPerSec },
    './grid.js': { gridAt: time => { requested.push(time); return segment; }, gridSegments: () => [segment],
      displayGridStep: seg => autoGridStep(seg, S.pxPerSec) },
    './timeline-paint.js': { paintTimeGridLine: (...args) => lines.push(args) },
  }, { './auto-grid.js': true });
  drawGrid();
  assert.equal(status.textContent, 'Auto · 1/16');
  assert.equal(requested.at(-1), 1.25, 'readout converts the pointer position to song time');
  assert.ok(lines.length > 1, 'grid rendering completes with the readout present');
  assert.equal(lines[1][1] - lines[0][1], 15, 'drawn line spacing matches adaptive snapping');
  S.drag = { mode: 'resize', freeResize: true, resizeTime: 2.3 };
  drawGrid();
  assert.equal(status.textContent, 'Free · Alt');
  assert.equal(requested.at(-1), 2.3);
  S.drag = null; S.mouseX = null; S.pxPerSec = 30;
  drawGrid();
  assert.equal(status.textContent, 'Auto · 1/4', 'readout refreshes after zoom and resize');
} finally { globalThis.document = savedDocument; }
console.log('auto grid rendering: pointer conversion, line spacing, Alt and zoom passed');
