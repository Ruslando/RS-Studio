import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const noop = () => {};
const first = { id: 1, pitch: 64, start: 1, end: 2 };
const second = { id: 2, pitch: 65, start: 2, end: 3 };
const lane = { id: 'edit', visible: true, notes: [first, second] };
const S = { state: { duration: 10, stems: [], editLanes: [lane], lanes: [lane] },
  selection: new Set(), undoStack: [], redoStack: [], voicingRevision: 0, hoverNote: first };
let hover = second, tab = false;
const { doDelete } = await mockImport(new URL('../../web/edit.js', import.meta.url), {
  './interaction.js': { hoveredStageNote: () => hover },
  './store.js': { S }, './dom.js': { undoMI: null, redoMI: null },
  './lanes.js': { activeLane: () => lane, editLanes: () => [lane],
    canEditLane: lane => lane.visible && !lane.locked, refreshCounts: noop },
  './grid.js': { currentGridState: () => ({}), gridOffset: () => 0 },
  './timing.js': { timingSnapshot: () => ({}), eachTiming: noop },
  './references.js': { lockedReferenceSnapshot: () => [], lockedReferenceFault: () => null, reconcileReferences: noop },
  './note-motion.js': { animateNoteChanges: noop }, './tracing.js': { clearMatches: noop },
  './repaint.js': { draw: noop }, './project.js': { refreshSaveState: noop },
  './tablature.js': { tabViewOn: () => tab }, './note-effects.js': { FX_KEYS: [] },
}, { './util.js': true });

doDelete();
assert.equal(lane.notes.length, 2, 'menu deletion does not implicitly delete a hover target');
doDelete({ hovered: true });
assert.deepEqual(lane.notes, [first], 'keyboard deletion uses the fresh hover target, not cached hover');
assert.equal(S.undoStack.length, 1);
assert.deepEqual(S.undoStack[0].lanes.edit, [first, second], 'hover deletion records an undo snapshot');
lane.notes = [first, second];
S.selection = new Set([first]);
doDelete({ hovered: true });
assert.deepEqual(lane.notes, [second], 'selection takes priority over hover');
lane.notes = [first, second];
S.selection.clear();
S.drag = { mode: 'move' };
doDelete({ hovered: true });
assert.equal(lane.notes.length, 2, 'deleting cannot break an in-progress gesture');
S.drag = null; tab = true;
doDelete({ hovered: true });
assert.equal(lane.notes.length, 2, 'tablature cannot delete a stale spectrogram target');
tab = false; lane.locked = true;
doDelete({ hovered: true });
assert.equal(lane.notes.length, 2, 'locked lanes remain protected even if their hover was cached');
assert.equal(S.undoStack.length, 2, 'no-op deletions do not create undo entries');
console.log('Hover deletion, selection priority and undo passed');
