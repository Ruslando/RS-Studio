import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

class Surface {
  listeners = new Map(); style = {};
  addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
  emit(type, props = {}) {
    const event = { type, clientX: 100, clientY: 100, button: 0, target: { tagName: 'DIV' }, preventDefault() {}, ...props };
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}
const stage = new Surface(), win = new Surface();
const scroll = Object.assign(new Surface(), { scrollLeft: 0, scrollTop: 0 });
const note = { id: 'n', start: 1.031, end: 1.5, pitch: 64 };
const lane = { id: 'lane', active: true, visible: true, notes: [note] };
const S = { pxPerSec: 100, toolMode: 'pan', state: { projectStart: 0, duration: 10, lanes: [lane], tempoMap: [] },
  matches: [], selection: new Set(), detectRegion: null };
const noop = () => {}, commits = [];
const oldWindow = globalThis.window;
try {
  globalThis.window = win;
  const grid = await mockImport(new URL('../../web/grid.js', import.meta.url), {
    './store.js': { S }, './dom.js': {
      bpmInput: { value: '120' }, offsetInput: { value: '0' }, tsNumInput: { value: '4' },
      tsDenInput: { value: '4' }, subdivSel: { value: '8' }, subdivCustom: { value: '8' },
    },
  }, { './bars.js': true, './constants.js': true, './project-position-core.js': true, './auto-grid.js': true });
  const { init_interaction } = await mockImport(new URL('../../web/interaction.js', import.meta.url), {
    './store.js': { S, setSelection: value => { S.selection = value; } },
    './dom.js': { stage, scroll }, './repaint.js': { draw: noop }, './grid.js': grid,
    './lanes.js': { activeLane: () => lane, laneOf: () => lane, canEditLane: value => !!value?.visible },
    './geometry.js': { timeAt: x => x / 100, xOf: t => t * 100, pitchAt: () => 64, pitchAtExact: () => 64, yOf: () => 100 },
    './markers.js': { markerMouseDown: () => false }, './comments.js': { commentMouseDown: () => false }, './marker-rails.js': { markerRails: () => [] },
    './note-render.js': { regionEdgeAt: () => null, noteRibbon: () => null, slideFretsHandle: () => null }, './grace.js': { graceBefore: () => null },
    './references.js': { boxOfNote: () => null, refLockAt: () => null, refBadgeAt: () => null, refBoxEdgeAt: () => null },
    './playback.js': { auditionNote: noop },
    './note-motion.js': { beginNoteGesture: noop, updateNoteGesture: noop, finishNoteGesture: noop },
    './edit.js': { snapshotEdit: () => structuredClone(lane.notes), commit: (...args) => commits.push(args) },
  }, { './shapes.js': true, './constants.js': true, './util.js': true, './note-length.js': true, './note-merge.js': true, './bend.js': true,
    './project-position-core.js': true });
  init_interaction();
  stage.emit('mousedown', { clientX: 149 });
  win.emit('mousemove', { clientX: 182 });
  assert.equal(note.end, 1.875, 'normal resize uses the visible auto grid');
  assert.equal(note.start, 1.031, 'resize does not snap the fixed edge');
  win.emit('mouseup', { clientX: 182 });
  assert.equal(note.end, 1.875);
  assert.equal(commits.at(-1)[3].preserveTiming, true, 'commit preserves the resized edge');

  stage.emit('mousedown', { clientX: 186.5, altKey: true });
  assert.equal(S.drag.mode, 'resize', 'Alt on a note edge resizes instead of starting a range');
  win.emit('mousemove', { clientX: 204, altKey: true });
  assert.ok(Math.abs(note.end - 2.05) < 1e-9, 'Alt allows a position between grid lines');
  win.emit('keyup', { key: 'Alt' });
  assert.equal(note.end, 2, 'releasing Alt restores grid snapping without more pointer movement');
  win.emit('keydown', { key: 'Alt', altKey: true });
  assert.ok(Math.abs(note.end - 2.05) < 1e-9);
  win.emit('mouseup', { clientX: 204, altKey: true });
  assert.ok(Math.abs(note.end - 2.05) < 1e-9, 'mouse release retains the free placement');

  const before = { lane: structuredClone(lane.notes) };
  grid.snapStrayNotes([lane], before);
  assert.equal(note.start, 1.031, 'subsequent unrelated edits leave free timing intact');
  S.pxPerSec = 30;
  assert.equal(grid.displayGridStep(grid.gridAt(0)), .5);
  assert.equal(note.start, 1.031, 'zooming never modifies note data');
  assert.deepEqual(grid.snapNote(1.2, 1.2625), { start: 1, end: 1.0625 },
    'coarse zoom does not stretch a short note when moving it');
} finally { globalThis.window = oldWindow; }
console.log('resize grid: adaptive snapping, Alt, release, fixed edges and persistent free timing passed');
