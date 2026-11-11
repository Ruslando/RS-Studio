import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { applyNoteCounterpart } from '../../web/repeat-change-details.js';
const noop = () => {};
const lane = { id: 'edit', name: 'Bass', kind: 'edit', visible: true, notes: [
  { id: 'a', start: .31, end: 1, pitch: 40, motifId: 'motif_v2_1' },
  { id: 'b', start: 7.21, end: 8, pitch: 40, shapeId: 'shape_1', shapeKind: 'handshape' },
], refBoxes: { 1: { locked: true, anchors: [.31, 7.21] } } };
const S = { state: { job: 'test', duration: 10, stems: [], editLanes: [lane], lanes: [lane], metadata: {}, grid: {} },
  selection: new Set(), undoStack: [], redoStack: [], voicingRevision: 0 };
const globals = { window: globalThis.window, CustomEvent: globalThis.CustomEvent, fetch: globalThis.fetch };
try {
  globalThis.window = new EventTarget();
  globalThis.CustomEvent = class extends Event { constructor(type) { super(type); } };
  const edit = await mockImport(new URL('../../web/edit.js', import.meta.url), {
    './store.js': { S }, './dom.js': { undoMI: null, redoMI: null },
    './note-effects.js': { FX_KEYS: [] },
    './lanes.js': { activeLane: () => lane, editLanes: () => [lane], refreshCounts: noop, renderLanes: noop, applyLaneVolume: noop },
    './grid.js': { currentGridState: () => ({}), gridOffset: () => 0, restoreGridState: noop },
    './timing.js': { timingSnapshot: () => ({}), restoreTimingSnapshot: noop },
    './references.js': { lockedReferenceSnapshot: () => [{ lane: lane.id }], lockedReferenceFault: () => null, reconcileReferences: noop },
    './note-motion.js': { animateNoteChanges: noop, clearNoteMotion: noop },
    './tracing.js': { clearMatches: noop }, './repaint.js': { draw: noop },
    './project.js': { refreshSaveState: noop }, './tablature.js': { refreshTabIfOpen: noop },
  }, { './util.js': true });
  const original = structuredClone(lane.notes);
  const groups = [{ id: 'repeat_1', name: 'Verse', copies: [['a'], ['b']], phraseLength: 2, offsets: [0, .5],
    variationMode: 'manual', variations: [{ id: 'variation_1', name: 'Variation A', copies: ['a'] },
      { id: 'variation_2', name: 'Variation B', copies: ['b'] }] }];
  const prev = edit.snapshotEdit();
  lane.repeatGroups = structuredClone(groups);
  edit.commitStructure(prev, { preserveTiming: true });
  assert.deepEqual(lane.notes, original, 'annotating never snaps or mirrors reference contents');
  assert.equal(S.undoStack.length, 1);
  edit.undo(); assert.deepEqual(lane.repeatGroups, [], 'undo removes grouping');
  edit.redo(); assert.deepEqual(lane.repeatGroups, groups, 'redo restores grouping');
  const rename = edit.snapshotEdit();
  lane.repeatGroups[0].name = 'Chorus';
  edit.commitStructure(rename, { preserveTiming: true });
  edit.undo(); assert.equal(lane.repeatGroups[0].name, 'Verse', 'nested group state is independently snapshotted');
  assert.deepEqual(lane.notes, original);

  const fieldEdit = edit.snapshotEdit();
  applyNoteCounterpart('fx.palmMute', { fx: { palmMute: true } }, lane.notes[1]);
  edit.commit(fieldEdit, undefined, null, { preserveTiming: true });
  assert.equal(lane.notes[1].fx.palmMute, true);
  edit.undo(); assert.equal(lane.notes[1].fx, undefined, 'undo restores one applied difference');
  edit.redo(); assert.equal(lane.notes[1].fx.palmMute, true, 'redo reapplies the individual difference');
  edit.undo();

  lane.notes[0].whammy = lane.notes[1].whammy = 'dip';
  lane.notes[0].whammyPoints = [[0, 0], [.4, -1], [1, 0]];
  lane.notes[1].whammyPoints = [[0, 0], [.7, -1], [1, 0]];
  const curveEdit = edit.snapshotEdit(), priorCurve = structuredClone(lane.notes[1].whammyPoints);
  applyNoteCounterpart('whammyPoints', lane.notes[0], lane.notes[1]);
  edit.commit(curveEdit, undefined, null, { preserveTiming: true });
  assert.deepEqual(lane.notes[1].whammyPoints, lane.notes[0].whammyPoints);
  edit.undo(); assert.deepEqual(lane.notes[1].whammyPoints, priorCurve, 'undo restores the individual curve points');
  edit.redo(); assert.deepEqual(lane.notes[1].whammyPoints, lane.notes[0].whammyPoints, 'redo reapplies the common curve');
  edit.undo();
  for (const note of lane.notes) { delete note.whammy; delete note.whammyPoints; }

  let payload;
  globalThis.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true }; };
  const project = await mockImport(new URL('../../web/project.js', import.meta.url), {
    './icons.js': { icon: () => '' },
    './store.js': { S }, './constants.js': { instrKey: () => 'bass', INSTRUMENTS: { bass: { tuning: 'standard' } } },
    './dom.js': { speedSel: { value: '1' } },
    './metadata.js': { metadataPayload: x => x, projectName: () => 'Test' },
    './marker-rails.js': { normalizedLaneFields: () => ({}) },
    './timing.js': { SONG: 'song', timingIdOf: () => 'song', timingData: () => ({ grid: {} }), timingsForSave: () => ({}) },
    './section-marker-core.js': { normalizeSectionMarkers: () => [] },
    './comments.js': { normalizeComments: () => [] },
    './volume.js': { normMix: () => ({}) },
    './tablature.js': { isValidTuningKey: () => true },
    './layer-role.js': { inferTablatureEnabled: () => true },
    './tone-marker-core.js': { withStartTone: () => [] },
  }, { './util.js': true, './motifs.js': true, './repeats-core.js': true });
  await project.saveToServer();
  assert.deepEqual(payload.editLanes[0].repeatGroups, groups, 'save payload includes group names and memberships');
  const reopened = project.mapLane(payload.editLanes[0]);
  assert.deepEqual(reopened.repeatGroups, groups, 'load retains saved groups');
  assert.deepEqual(reopened.notes.map(n => [n.id, n.start, n.end, n.motifId, n.shapeId]),
    original.map(n => [n.id, n.start, n.end, n.motifId, n.shapeId]), 'load retains imported timing and existing markings');
} finally { Object.assign(globalThis, globals); }
console.log('Repeat groups: undo, redo, save and reopen passed');
