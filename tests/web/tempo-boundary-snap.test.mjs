import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const S = { pxPerSec: 2000, state: { projectStart: 0, duration: 400, tempoMap: [] } };
const inputs = {
  bpmInput: { value: '120' }, offsetInput: { value: '0' }, tsNumInput: { value: '4' },
  tsDenInput: { value: '4' }, subdivSel: { value: '8' }, subdivCustom: { value: '8' },
};
const gridDependencies = {
  './store.js': { S }, './dom.js': inputs,
};
const gridReal = { './bars.js': true, './constants.js': true, './project-position-core.js': true, './auto-grid.js': true };
const controls = await mockImport(new URL('../../web/grid-controls.js', import.meta.url), gridDependencies, gridReal);
const grid = await mockImport(new URL('../../web/grid-read.js', import.meta.url), { ...gridDependencies, './grid-controls.js': controls }, gridReal);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

S.state.tempoMap = [{ t: 1.23, bpm: 60, tsNum: 4, tsDen: 4, subdiv: 8 }];
for (const pxPerSec of [30, 120, 2000]) {
  S.pxPerSec = pxPerSec;
  close(grid.snap(1.229), 1.23, 'last visible cell stops at the marker');
  close(grid.snap(1.231), 1.23, 'the next segment uses the identical boundary');
  close(grid.snap(1.23), 1.23, 'marker snaps exactly to itself');
}
S.pxPerSec = 2000;
close(grid.snapFine(1.134), 1.1328125, 'precision grid divides the 1/32 cell into eight 1/256 cells');
S.pxPerSec = 30;
close(grid.snapFine(1.134), 1.1328125, 'precision grid follows the authored setting rather than zoom');
S.pxPerSec = 2000;
close(grid.snapFine(1.229), 1.23, 'precision movement respects exact tempo boundaries');
close(grid.snap(1.13), 1.125, 'earlier regular grid points remain available');
close(grid.snap(1.36), 1.355, 'later grid points use the new tempo');
close(grid.snapNote(1.1875, 1.25).end, 1.23, 'moving a note cannot round its tail past the boundary');
close(grid.snapNote(1.1875, 1.22).end, 1.23, 'a short final cell can be shorter than the normal minimum');
close(grid.quantizeFine(1.1875, 1.25).end, 1.23, 'detected notes also respect the segment boundary');
assert.deepEqual(grid.quantizeFine(1.229, 1.354), { start: 1.23, end: 1.355 }, 'a start snapped onto the marker uses its new grid');
close(grid.snapNote(1, 1.98).end, 1.98, 'intentional sustain across the marker stays across it');
assert.ok(grid.quantizeFine(1, 1.98).end > 1.23, 'fine quantization retains deliberate crossing');
S.state.tempoMap[0].bpm = 240;
close(grid.snapNote(1.1875, 1.25).end, 1.23, 'final old-grid cell also stops when the new tempo is faster');
close(grid.quantizeFine(1.1875, 1.25).end, 1.23, 'fine quantization does not spill into a faster tempo');
assert.ok(grid.snapNote(1, 1.98).end > 1.23, 'longer notes can cross into a faster tempo');
S.state.tempoMap[0].bpm = 60;

// Marker drags snap against their starting grid, not the live moving markers.
const original = grid.gridSegments();
S.state.tempoMap[0].t = 1.4;
close(grid.snap(1.229, original), 1.23, 'an explicit grid snapshot owns its boundaries');

// The exact offset and tempo transition from Kroi - SPIN, without loading or editing it.
inputs.bpmInput.value = '146';
S.state.tempoMap = [
  { t: .8221780821917808, bpm: 146, tsNum: 4, tsDen: 4, subdiv: 8 },
  { t: 270.4040410958904, bpm: 80, tsNum: 2, tsDen: 4, subdiv: 8 },
];
const boundary = S.state.tempoMap[1].t;
for (const start of [269.1269726027397, 269.1783424657534]) {
  close(grid.snapNote(start, 270.4112191780822).end, boundary, 'old-grid tail snaps to the shared boundary');
}
close(grid.snap(boundary - .001), boundary, 'resizing reaches the exact transition');

// Regular single-tempo duration rounding and an unset grid retain their behavior.
S.state.tempoMap = [];
inputs.bpmInput.value = '120'; S.pxPerSec = 30;
assert.deepEqual(grid.snapNote(1.2, 1.2625), { start: 1, end: 1.0625 });
inputs.bpmInput.value = '';
close(grid.snapNote(1.031, 1.5).start, 1.031, 'an unset grid preserves the start');
close(grid.snapNote(1.031, 1.5).end, 1.5, 'an unset grid preserves the end');
console.log('tempo boundary snapping: shared endpoints, crossing sustains, snapshots and fine quantization passed');
