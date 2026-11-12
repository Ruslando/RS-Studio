import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockImport, mockEditor } from './mock-import.mjs';
import { EFFECT_FIELDS, copyEffects } from '../../web/note-effects.js';
import { effectSig, inRefBox, occurrenceBox, shiftOf } from '../../web/reference-core.js';
import { referenceHands, referenceHandSig, mirrorReferenceHands } from '../../web/reference-hands.js';
import { chordColumns, slideFingerGroup } from '../../web/voicing-core.js';
const noop = () => {};
const lane = { id: 'test', visible: true, notes: [
  { id: 'first', start: 0, end: .8, pitch: 52, finger: 1 },
  { id: 'second', start: 4, end: 4.8, pitch: 52, finger: 1 },
], refBoxes: { 1: { rt0: 0, rt1: 1, pLo: 52, pHi: 52, anchors: [0, 4] } } };
const S = { state: { editLanes: [lane], lanes: [lane], metadata: {}, grid: {} }, selection: new Set(),
  undoStack: [], redoStack: [], voicingRevision: 0 };
const clock = { beatAt: t => t, timeAt: t => t };
let uid = 0;
const source = readFileSync(new URL('../../web/references.js', import.meta.url), 'utf8');
const functions = ['relPattern', 'boxSig', 'mirrorBox', 'reconcileRefGroup', 'reconcileReferences',
  'lockedReferenceSnapshot', 'lockedReferenceFault'].map(name => {
  const at = source.indexOf(`function ${name}(`);
  return source.slice(at, source.indexOf('\n}', at) + 2);
}).join('\n');
const constants = ['lockShape', 'lockNotes', 'OCCURRENCE_FIELDS'].map(name => source.match(new RegExp(`const ${name} = [^\\n]+`))[0]).join('\n');
const refs = new Function('deps', `const { EFFECT_FIELDS, copyEffects, effectSig, shiftOf, laneClock, boxRect, notesInBox,
  noteOrder, dropFingering, nid, referenceHands, referenceHandSig, mirrorReferenceHands, boxMinIn, eachRefGroup, editLanes } = deps;
  ${constants}\n${functions}
  return { reconcileReferences, lockedReferenceSnapshot, lockedReferenceFault };`)({
  EFFECT_FIELDS, copyEffects, effectSig, shiftOf, referenceHands, referenceHandSig, mirrorReferenceHands,
  laneClock: () => clock, boxRect: occurrenceBox, notesInBox: (box, notes) => notes.filter(n => inRefBox(n, box, .1)),
  noteOrder: (a, b) => a.start - b.start || a.pitch - b.pitch,
  dropFingering: n => { delete n.pos; delete n.arrangement; delete n.finger; }, nid: () => `n${++uid}`, boxMinIn: () => .1,
  eachRefGroup: cb => { for (const [id, g] of Object.entries(lane.refBoxes)) cb(lane, +id, g); }, editLanes: () => [lane],
});
const saved = { window: globalThis.window, CustomEvent: globalThis.CustomEvent };
try {
  globalThis.window = new EventTarget(); globalThis.CustomEvent = class extends Event {};
  const edit = await mockEditor({
    './store.js': { S, setSelection: set => { S.selection = set; } }, './dom.js': { undoMI: null, redoMI: null },
    './note-effects.js': { FX_KEYS: [] }, './lanes.js': { activeLane: () => lane, editLanes: () => [lane],
      laneOf: n => lane.notes.includes(n) ? lane : null, canEditLane: l => !!l, refreshCounts: noop, renderLanes: noop, applyLaneVolume: noop },
    "./grid-controls.js": { currentGridState: () => ({}), gridOffset: () => 0, restoreGridState: noop },
    "./grid-read.js": { snapStrayNotes: noop },
    './timing.js': { timingSnapshot: () => ({}), restoreTimingSnapshot: noop, eachTiming: (lanes, cb) => cb(lanes) },
    './references.js': refs, './note-motion.js': { animateNoteChanges: noop, clearNoteMotion: noop },
    './voicing.js': { chordColumns, slideFingerGroup }, './tracing.js': { clearMatches: noop },
    './repaint.js': { draw: noop }, './save-state.js': { refreshSaveState: noop }, './tablature.js': { refreshTabIfOpen: noop },
    './ids.js': { nid: () => `hand${++uid}` }, './notify.js': { toast: noop },
  }, { './util.js': true });
  const draft = new Map(); edit.draftNoteFinger(draft, lane.notes[1], 3); edit.settleFingerDraft(draft, true);
  assert.deepEqual(lane.notes.map(n => n.finger), [3, 3], 'a finger entered in the later occurrence mirrors backwards');
  assert.equal(S.undoStack.length, 1);
  edit.undo(); assert.deepEqual(lane.notes.map(n => n.finger), [1, 1]);
  edit.redo(); assert.deepEqual(lane.notes.map(n => n.finger), [3, 3]);
  edit.undo();
  edit.setHandAnchor(lane, 4, 7);
  assert.deepEqual(lane.handHolds.map(h => [h.t, h.fret]), [[0, 7], [4, 7]]);
  assert.ok(lane.notes.every(n => n.finger == null), 'choosing a shared hand clears its shared explicit fingers');
  edit.undo(); assert.deepEqual(lane.handHolds, []); assert.deepEqual(lane.notes.map(n => n.finger), [1, 1]);
  edit.redo(); assert.deepEqual(lane.handHolds.map(h => h.fret), [7, 7]);
  edit.setHandAnchor(lane, 4, null); assert.deepEqual(lane.handHolds, [], 'Auto clears the whole reference');
  edit.undo(); assert.deepEqual(lane.handHolds.map(h => h.fret), [7, 7]);
  lane.refBoxes[1].locked = true;
  const count = S.undoStack.length; edit.setHandAnchor(lane, 4, 9);
  assert.deepEqual(lane.handHolds.map(h => h.fret), [7, 7], 'locked references protect anchor-only edits too');
  assert.equal(S.undoStack.length, count);
} finally { Object.assign(globalThis, saved); }
console.log('Reference fingering and hand edits: mirroring, Auto, locks and undo passed');
