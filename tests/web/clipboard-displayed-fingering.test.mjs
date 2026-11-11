import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { arrangedNotes, chordColumns, isChosenFinger, keepVoicing, voiceNotesFingered } from '../../web/voicing-core.js';
const noop = () => {};
const source = { id: 'source', instrument: 'bass', tuning: 'bass4', visible: true, notes: [49, 51, 49, 44].map((pitch, i) => ({
  id: `s${i}`, pitch, start: i, end: i + .9, pos: { string: 1, fret: pitch - 38 },
})) };
const target = { id: 'target', instrument: 'bass', tuning: 'bass4', visible: true, notes: [
  { id: 'context', pitch: 31, start: 0, end: 7.9 },
] };
const lanes = [source, target];
const S = { state: { editLanes: lanes, lanes, metadata: {}, grid: {} }, selection: new Set(source.notes),
  clipboard: [], clipboardSrc: [], undoStack: [], redoStack: [], voicingRevision: 0 };
const clock = { beatAt: t => t, timeAt: b => b };
let solves = 0, id = 0;
const saved = { window: globalThis.window, CustomEvent: globalThis.CustomEvent };
try {
  globalThis.window = new EventTarget(); globalThis.CustomEvent = class extends Event {};
  const tab = await mockImport(new URL('../../web/tablature.js', import.meta.url), {
    './store.js': { S }, './song-bars.js': { songBarStarts: () => [0, 4, 8, 12, 16] },
    './timing.js': { onLiveTiming: () => true }, './project.js': { withoutDirtying: write => write(noop) },
    './voicing.js': { arrangedNotes, chordColumns, isChosenFinger, keepVoicing, voiceNotesFingered: (...args) => {
      solves++; return voiceNotesFingered(...args);
    } },
  }, { './constants.js': true, './tunings.js': true, './util.js': true, './fretboard-cache.js': true });
  const shown = await tab.laneFingering(source), count = solves, before = structuredClone(source);
  assert.ok(source.notes.every(n => n.finger == null));
  assert.equal(source.handHolds, undefined, 'the visible hand is generated, not authored');
  const edit = await mockImport(new URL('../../web/edit.js', import.meta.url), {
    './store.js': { S, setSelection: set => { S.selection = set; } }, './dom.js': { undoMI: null, redoMI: null },
    './tablature.js': { ...tab, refreshTabIfOpen: noop },
    './lanes.js': { editLanes: () => lanes, activeLane: () => target, targetLane: () => target,
      laneOf: n => lanes.find(l => l.notes.includes(n)), renderLanes: noop, refreshCounts: noop, applyLaneVolume: noop },
    './grid.js': { currentGridState: () => ({}), gridOffset: () => 0, restoreGridState: noop, snap: t => t, snapStrayNotes: noop },
    './timing.js': { timingSnapshot: () => ({}), restoreTimingSnapshot: noop, eachTiming: (lanes, cb) => cb(lanes) },
    './references.js': { wholeBoxOf: () => null, laneClock: () => clock, lockedReferenceSnapshot: () => [],
      lockedReferenceFault: () => null, reconcileReferences: noop },
    './marker-clipboard.js': { hasMarkerSelection: () => false, hasMarkerClip: () => false, forgetMarkerClip: noop, clearMarkerSelection: noop },
    './note-motion.js': { animateNoteChanges: noop, clearNoteMotion: noop }, './tracing.js': { clearMatches: noop },
    './repaint.js': { draw: noop }, './project.js': { refreshSaveState: noop }, './ids.js': { nid: () => `new${++id}` },
  }, { './util.js': true, './note-effects.js': true, './shapes.js': true, './clipboard-fingering.js': true });
  edit.doCopy();
  assert.equal(solves, count, 'Copy takes the already displayed answer');
  assert.deepEqual(source, before, 'copying does not author fingers or hand anchors on the source');
  assert.deepEqual(S.clipboard.map(c => c.finger), source.notes.map(n => shown.fingers.get(n)));
  assert.deepEqual(S.clipboard.map(c => c.handAnchor), source.notes.map(n => shown.seats.get(n)));
  await edit.doPaste({ mode: 'copy', at: 8 });
  const pasted = [...S.selection], result = await tab.laneFingering(target);
  for (let i = 0; i < pasted.length; i++) {
    assert.deepEqual(result.voiced.get(pasted[i]), shown.voiced.get(source.notes[i]));
    assert.equal(result.fingers.get(pasted[i]), shown.fingers.get(source.notes[i]), 'the re-solved copy displays the same finger');
    assert.equal(result.seats.get(pasted[i]), shown.seats.get(source.notes[i]), 'the re-solved copy displays the same hand');
  }
  edit.undo(); assert.equal(target.notes.length, 1); assert.deepEqual(target.handHolds, []);
  edit.redo(); assert.equal(target.notes.length, 5); assert.equal(target.handHolds.length, 4);
} finally { Object.assign(globalThis, saved); }
console.log('Clipboard captures the actual displayed automatic fingers and hand, and preserves them after solving the paste');
