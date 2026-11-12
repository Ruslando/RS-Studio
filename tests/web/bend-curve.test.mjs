import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

// A bend only goes up; a whammy goes anywhere; a note's curve comes from the menu (edit.js).
const noop = () => {};
const lane = { id: 'edit', visible: true, notes: [] };
const S = { state: { duration: 10, stems: [], editLanes: [lane], lanes: [lane] },
  selection: new Set(), undoStack: [], redoStack: [], voicingRevision: 0 };
const { setBendCurve, addBendPoint } = await mockImport(new URL('../../web/edit.js', import.meta.url), {
  './store.js': { S }, './dom.js': { undoMI: null, redoMI: null },
  './lanes.js': { activeLane: () => lane, editLanes: () => [lane], laneOf: () => lane,
    canEditLane: () => true, refreshCounts: noop },
  './grid.js': { currentGridState: () => ({}), gridOffset: () => 0 },
  './timing.js': { timingSnapshot: () => ({}), eachTiming: noop },
  './references.js': { lockedReferenceSnapshot: () => [], lockedReferenceFault: () => null, reconcileReferences: noop },
  './note-motion.js': { animateNoteChanges: noop }, './tracing.js': { clearMatches: noop },
  './repaint.js': { draw: noop }, './save-state.js': { refreshSaveState: noop },
  './note-effects.js': { FX_KEYS: [] },
}, { './util.js': true, './bend.js': true, './whammy.js': true });

const plain = { id: 1, pitch: 64, start: 1, end: 2 };
lane.notes = [plain];
addBendPoint(plain, 0.5);
assert.equal(plain.bend, undefined, 'a note without a curve gets none from a point');

const bent = { id: 2, pitch: 64, start: 2, end: 3, bend: 'half' };
setBendCurve(bent, [[0, 0], [0.5, -1], [1, 1]]);
assert.deepEqual(bent.bendPoints, [[0, 0], [0.5, 0], [1, 1]], 'a bend stops at the fretted note');
assert.equal(bent.whammy, undefined, 'and never turns into a whammy');

const dipped = { id: 3, pitch: 64, start: 3, end: 4, whammy: 'dive' };
setBendCurve(dipped, [[0, 0], [0.5, -1], [1, 0]], 'whammy');
assert.deepEqual(dipped.whammyPoints, [[0, 0], [0.5, -1], [1, 0]]);
assert.equal(dipped.whammy, 'dip');
console.log('bend curve: no curve from a point, bends stay up, whammy free passed');
