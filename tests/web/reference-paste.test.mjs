import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
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
const savedWindow = globalThis.window; const messages = []; let id = 0;
try {
  globalThis.window = new EventTarget();
  const { doPaste } = await mockImport(new URL('../../web/edit.js', import.meta.url), {
    './store.js': { S, setSelection: value => { S.selection = value; } },
    './dom.js': { pasteBackdrop: backdrop, pasteCopyBtn: copy, pasteAsRefBtn: reference, pasteCancelBtn: cancel, undoMI: {}, redoMI: {} },
    './grid.js': { snap: t => t, snapNote: (start, end) => ({ start, end }), currentGridState: noop, gridOffset: () => 0, snapStrayNotes: noop },
    './references.js': { wholeBoxOf: () => ({ lane, ref: 1 }), laneClock: () => clock, noteBounds: bounds, spanAt, lockedReferenceSnapshot: () => [], lockedReferenceFault: () => null,
      reconcileReferences: noop,
      overlapsRefBox: (target, box) => Object.values(target.refBoxes).some(g => g.anchors.some((_, i) => {
        const b = occurrenceBox(g, i, clock);
        return box.t0 < b.t1 && box.t1 > b.t0 && box.pLo <= b.pHi && box.pHi >= b.pLo;
      })) },
    './lanes.js': { laneOf: () => lane, targetLane: () => lane, activeLane: () => lane, editLanes: () => [lane], renderLanes: noop, refreshCounts: noop },
    './timing.js': { timingSnapshot: noop, eachTiming: noop },
    './note-effects.js': { copyEffects: (source, target) => target, FX_KEYS: [], FX_LABELS: {} }, './ids.js': { nid: () => ++id },
    './note-motion.js': { animateNoteChanges: noop }, './repaint.js': { draw: noop },
    './project.js': { refreshSaveState: noop }, './notify.js': { toast: message => messages.push(message) },
  }, { './constants.js': true, './util.js': true });
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
} finally { globalThis.window = savedWindow; }
console.log('Pasting into references skips invalid reference choices and prevents nesting');
