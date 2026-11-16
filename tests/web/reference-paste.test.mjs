import assert from 'node:assert/strict';
import { mockImport, mockEditor } from './mock-import.mjs';
import { occurrenceBox, spanAt } from '../../web/reference-core.js';
const noop = () => {};
class Button extends EventTarget { focus() {} }
const copy = new Button(), reference = new Button(), cancel = new Button(), backdrop = { hidden: true };
const group = { anchors: [0, 4], rt0: 0, rt1: 3, pLo: 60, pHi: 65 };
const lane = { id: 'guitar', active: true, visible: true, refBoxes: { 1: group }, notes: [] };
const S = { state: { duration: 12, lanes: [lane] }, clipboard: [{ start: .5, end: 1, pitch: 60 }],
  clipboardRef: { lane, ref: 1 }, clipboardSrc: [], selection: new Set(), undoStack: [], voicingRevision: 0 };
const clock = { beatAt: t => t, timeAt: b => b };
const bounds = notes => ({ t0: Math.min(...notes.map(n => n.start)), t1: Math.max(...notes.map(n => n.end)),
  pLo: Math.min(...notes.map(n => n.pitch)), pHi: Math.max(...notes.map(n => n.pitch)) });
const savedWindow = globalThis.window; const messages = []; let id = 0, snapTo = t => t;
try {
  globalThis.window = new EventTarget();
  const { doPaste } = await mockEditor({
    './marker-clipboard.js': { deleteMarkers: () => false, cutMarkers: () => false, hasMarkerSelection: () => false, hasMarkerClip: () => false, forgetMarkerClip: () => {}, clearMarkerSelection: () => false, markerSelectClick: () => false },
    './store.js': { S, setSelection: value => { S.selection = value; } },
    './dom.js': { pasteBackdrop: backdrop, pasteCopyBtn: copy, pasteAsRefBtn: reference, pasteCancelBtn: cancel, undoMI: {}, redoMI: {} },
    "./grid-read.js": { snap: t => snapTo(t), snapNote: (start, end) => ({ start, end }), snapStrayNotes: noop },
    "./grid-controls.js": { currentGridState: noop, gridOffset: () => 0 },
    "./references.js": { wholeBoxOf: () => ({ lane, ref: 1 }), noteBounds: bounds, spanAt, boxOfNote: note => note.box ?? null, lockedReferenceSnapshot: () => [], lockedReferenceFault: () => null, reconcileReferences: noop, overlapsRefBox: (target, box) => Object.values(target.refBoxes).some(g => g.anchors.some((_, i) => {
        const b = occurrenceBox(g, i, clock);
        return box.t0 < b.t1 && box.t1 > b.t0 && box.pLo <= b.pHi && box.pHi >= b.pLo;
      })) },
    "./reference-clock.js": { laneClock: () => clock },
    './lanes.js': { laneOf: () => lane, targetLane: () => lane, activeLane: () => lane, editLanes: () => [lane], renderLanes: noop, refreshCounts: noop },
    './timing.js': { timingSnapshot: noop, eachTiming: noop },
    './note-effects.js': { copyEffects: (source, target) => target, FX_KEYS: [], FX_LABELS: {} }, './ids.js': { nid: () => ++id },
    './note-motion.js': { animateNoteChanges: noop }, './repaint.js': { draw: noop },
    './save-state.js': { refreshSaveState: noop }, './notify.js': { toast: message => messages.push(message) },
    './lane-fingering.js': { laneFingering: async target => { target.handAnchorVersion = 1; target.handHolds = []; } },
  }, { './constants.js': true, './util.js': true, './shapes.js': true });
  await doPaste({ at: 1.5 });
  assert.equal(backdrop.hidden, true, 'pasting inside the source reference never opens a prompt');
  assert.equal(lane.notes.length, 1);
  assert.equal(lane.notes[0].start, 1.5);
  assert.deepEqual(group.anchors, [0, 4]);
  await doPaste({ at: 5 });
  assert.equal(lane.notes.length, 2, 'another occurrence also receives an ordinary copy');
  await doPaste({ at: 1.5, mode: 'reference' });
  assert.equal(lane.notes.length, 2, 'explicit reference paste cannot nest references');
  assert.ok(messages.at(-1).includes('cannot overlap'));
  // A short pasted selection fits in the gap, but its linked reference's full
  // extent would overlap the next occurrence. The complete box is checked.
  await doPaste({ at: 3.2, mode: 'reference' });
  assert.equal(lane.notes.length, 2);
  const pending = doPaste({ at: 9 });
  assert.equal(backdrop.hidden, false, 'outside references the choice remains available');
  cancel.dispatchEvent(new Event('click')); await pending;
  assert.equal(lane.notes.length, 2);
  // An anchor that sits after its first note (the notes were snapped without it)
  // keeps that distance in the paste: the box frames the notes as the original
  // does and fits a gap exactly its length.
  Object.assign(group, { anchors: [0.1, 6.1], rt0: -0.1, rt1: 2.9, rb0: -0.1, rb1: 2.9 });
  S.clipboard = [{ start: 0, end: 1, beat0: 0, beat1: 1, pitch: 60 }]; snapTo = Math.round;
  S.clipboardSrc = [{ start: 0, end: 1, pitch: 60, box: { lane, group, i: 0 } }];
  await doPaste({ at: 3.1, mode: 'reference' });
  assert.equal(lane.notes.length, 3, messages.at(-1));
  assert.equal(lane.notes[2].start, 3, 'the first note lands on the grid');
  assert.deepEqual(group.anchors.map(a => +a.toFixed(9)), [0.1, 6.1, 3.1]);
} finally { globalThis.window = savedWindow; }
console.log('Pasting into references skips invalid reference choices and prevents nesting');
