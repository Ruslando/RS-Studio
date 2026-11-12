import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { noteHandAnchors } from '../../web/clipboard-fingering.js';
const noop = () => {};
const source = { id: 'source', visible: true, notes: [
  { id: 'a', pitch: 52, start: 1, end: 1.8, finger: 0, pos: { string: 3, fret: 2 } },
  { id: 'chord', pitch: 55, start: 1, end: 1.8, finger: 3, pos: { string: 2, fret: 0 } },
  { id: 'b', pitch: 54, start: 3, end: 3.8, finger: 2, pos: { string: 3, fret: 4 } },
  { id: 'outside', pitch: 57, start: 5, end: 5.8, finger: 4 },
], handHolds: [{ id: 'first', t: .9, fret: 5 }, { id: 'second', t: 2.8, fret: 7 }, { id: 'outside', t: 4.9, fret: 9 }] };
const target = { id: 'target', visible: true, notes: [], handHolds: [{ id: 'keep', t: 2, fret: 3 }] };
const lanes = [source, target], sourceClock = { beatAt: t => t, timeAt: b => b }, targetClock = { beatAt: t => t * 2, timeAt: b => b / 2 };
const S = { state: { editLanes: lanes, lanes, metadata: {}, grid: {} }, selection: new Set(source.notes.slice(0, 3)),
  clipboard: [], clipboardSrc: [], undoStack: [], redoStack: [], voicingRevision: 0 };
let id = 0;
const saved = { window: globalThis.window, CustomEvent: globalThis.CustomEvent };
try {
  globalThis.window = new EventTarget(); globalThis.CustomEvent = class extends Event {};
  const edit = await mockImport(new URL('../../web/edit.js', import.meta.url), {
    './store.js': { S, setSelection: set => { S.selection = set; } }, './dom.js': { undoMI: null, redoMI: null },
    './lanes.js': { editLanes: () => lanes, activeLane: () => target, targetLane: () => target, canEditLane: () => true,
      laneOf: n => lanes.find(l => l.notes.includes(n)), renderLanes: noop, refreshCounts: noop, applyLaneVolume: noop },
    './grid.js': { currentGridState: () => ({}), gridOffset: () => 0, restoreGridState: noop, snap: t => t, snapStrayNotes: noop },
    './timing.js': { timingSnapshot: () => ({}), restoreTimingSnapshot: noop, eachTiming: (lanes, cb) => cb(lanes) },
    './references.js': { wholeBoxOf: () => null, laneClock: lane => lane === source ? sourceClock : targetClock,
      lockedReferenceSnapshot: () => [], lockedReferenceFault: () => null, reconcileReferences: noop,
      dropFingering: n => { delete n.pos; delete n.arrangement; delete n.finger; } },
    './marker-clipboard.js': { hasMarkerSelection: () => false, hasMarkerClip: () => false, forgetMarkerClip: noop, clearMarkerSelection: noop },
    './note-motion.js': { animateNoteChanges: noop, clearNoteMotion: noop }, './tracing.js': { clearMatches: noop },
    './repaint.js': { draw: noop }, './save-state.js': { refreshSaveState: noop },
    './tablature.js': { refreshTabIfOpen: noop, laneFingeringNow: lane => ({ notes: lane.notes,
      voiced: new Map(lane.notes.filter(n => n.pos).map(n => [n, n.pos])),
      fingers: new Map(lane.notes.map(n => [n, n.finger])), seats: noteHandAnchors(lane.notes, lane.handHolds) }) },
    './notify.js': { toast: noop },
    './ids.js': { nid: () => `new${++id}` },
  }, { './util.js': true, './note-effects.js': true, './shapes.js': true, './clipboard-fingering.js': true });
  edit.doCopy();
  const clip = structuredClone(S.clipboard), original = structuredClone(source);
  assert.deepEqual(clip.map(n => n.finger), [0, 3, 2], 'thumb and explicit finger numbers enter the clipboard');
  assert.deepEqual(clip.map(n => n.handAnchor), [5, 5, 7], 'anchors in the preceding gap belong to their copied attack');
  // The clipboard is a snapshot, even if the original fingering changes later.
  source.notes[0].finger = 4; source.handHolds[0].fret = 11;
  await edit.doPaste({ mode: 'copy', at: 10 });
  assert.deepEqual(target.notes.map(n => [n.start, n.finger]), [[10, 0], [10, 3], [11, 2]]);
  assert.deepEqual(target.notes.map(n => n.pos), clip.map(n => n.pos));
  assert.ok(target.notes.every(n => !('handAnchor' in n)), 'anchor metadata stays on the lane, not the pasted notes');
  assert.deepEqual(target.handHolds.map(h => [h.t, h.fret]), [[2, 3], [10, 5], [11, 7]]);
  assert.equal(target.handHolds.length, 3, 'a chord receives one hand anchor');
  assert.ok(target.handHolds.slice(1).every(h => !original.handHolds.some(old => old.id === h.id)), 'pasted anchors have independent IDs');
  assert.notEqual(target.notes[0].pos, S.clipboard[0].pos);
  assert.equal(S.undoStack.length, 1);
  edit.undo(); assert.deepEqual(target.notes, []); assert.deepEqual(target.handHolds, [{ id: 'keep', t: 2, fret: 3 }]);
  edit.redo(); assert.deepEqual(target.handHolds.map(h => h.fret), [3, 5, 7]);
  await edit.doPaste({ mode: 'copy', at: 20 });
  assert.deepEqual(target.handHolds.map(h => [h.t, h.fret]), [[2, 3], [10, 5], [11, 7], [20, 5], [21, 7]]);
  const count = target.handHolds.length;
  await edit.doPaste({ mode: 'copy', at: 30, shift: 2 });
  assert.ok(target.notes.slice(-3).every(n => n.finger == null && n.pos == null), 'transposed notes keep the existing re-fingering behavior');
  assert.equal(target.handHolds.length, count);
  S.selection = new Set(source.notes.slice(0, 3));
  edit.sendSelectionToLane(target);
  assert.deepEqual(target.notes.slice(-3).map(n => n.finger), [4, 3, 2], 'copy to another layer also preserves fingers');
  assert.deepEqual(target.handHolds.filter(h => h.t === 1 || h.t === 3).map(h => [h.t, h.fret]), [[1, 11], [3, 7]]);
  assert.deepEqual(target.notes.slice(-3).map(n => n.pos), source.notes.slice(0, 3).map(n => n.pos));
} finally { Object.assign(globalThis, saved); }
console.log('Clipboard fingering: snapshot, beat placement, chords, repeated paste and undo passed');
