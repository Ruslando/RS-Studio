import assert from 'node:assert/strict';
import { mockImport, mockEditor } from './mock-import.mjs';
import { chordColumns, normalizeOverrideInfluence, overrideFlow, shapeFault, voiceNotes, voiceNotesFingered } from '../../web/voicing-core.js';
const noop = () => {};
const lane = { id: 'bass', instrument: 'bass', visible: true, notes: [
  { id: 'c', pitch: 49, start: .3, end: 1.3, pos: { string: 1, fret: 11 }, finger: 1, fx: { hammer: 'origin' } },
  { id: 'd', pitch: 51, start: 1.3, end: 2.3, pos: { string: 1, fret: 13 }, finger: 3, fx: { hammer: 'dest' } },
  { id: 'picked', pitch: 49, start: 2.3, end: 3.3, pos: { string: 1, fret: 11 } },
], refBoxes: {} };
const S = { state: { editLanes: [lane], lanes: [lane], metadata: {}, grid: {} }, selection: new Set(),
  undoStack: [], redoStack: [], voicingRevision: 0 };
let locked = null;
const saved = { window: globalThis.window, CustomEvent: globalThis.CustomEvent };
try {
  globalThis.window = new EventTarget();
  globalThis.CustomEvent = class extends Event {};
  const edit = await mockEditor({
    './store.js': { S, setSelection: selection => { S.selection = selection; } },
    './dom.js': { undoMI: null, redoMI: null }, './note-effects.js': { FX_KEYS: [] },
    './lanes.js': { activeLane: () => lane, editLanes: () => [lane], laneOf: note => lane.notes.includes(note) ? lane : null,
      canEditLane: l => !!l && !l.locked, refreshCounts: noop, renderLanes: noop, applyLaneVolume: noop },
    "./grid-controls.js": { currentGridState: () => ({}), gridOffset: () => 0, restoreGridState: noop },
    './timing.js': { timingSnapshot: () => ({}), restoreTimingSnapshot: noop },
    './references.js': { lockedReferenceSnapshot: () => [], lockedReferenceFault: () => null, reconcileReferences: noop,
      boxOfNote: n => n?.id === locked ? { group: { locked: true } } : null },
    './note-motion.js': { animateNoteChanges: noop, clearNoteMotion: noop },
    './tracing.js': { clearMatches: noop }, './repaint.js': { draw: noop }, './save-state.js': { refreshSaveState: noop },
    "./lane-tuning.js": { laneFretTuning: () => [43, 38, 33, 28], laneFretCount: () => 24 },
    "./tablature.js": { refreshTabIfOpen: noop },
    './voicing.js': { chordColumns, normalizeOverrideInfluence, overrideFlow, shapeFault, voiceNotes, voiceNotesFingered },
    './song-bars.js': { songBarStarts: () => [0, 4, 8] },
  }, { './util.js': true, './hammer-positions.js': true, './position-selection.js': true });
  const before = structuredClone(lane.notes);
  locked = 'c'; edit.setNotePosition(lane.notes[1], 0, 8);
  assert.deepEqual(lane.notes, before, 'a locked source prevents moving the whole connection');
  assert.equal(S.undoStack.length, 0);
  locked = null; edit.setNotePosition(lane.notes[1], 0, 8);
  assert.deepEqual(lane.notes.map(n => n.pos.fret), [6, 8, 11]);
  assert.deepEqual(lane.notes.map(n => n.pos.string), [0, 0, 1]);
  assert.equal(S.undoStack.length, 1, 'both notes move in one undo step');
  assert.deepEqual(lane.notes.map(n => [n.start, n.end, n.pitch, n.finger, n.fx]), before.map(n => [n.start, n.end, n.pitch, n.finger, n.fx]));
  edit.undo(); assert.deepEqual(lane.notes, before);
  edit.redo(); assert.deepEqual(lane.notes.map(n => n.pos.fret), [6, 8, 11]);
} finally { Object.assign(globalThis, saved); }
console.log('Hammer position edits: coupled movement, locking and undo passed');
