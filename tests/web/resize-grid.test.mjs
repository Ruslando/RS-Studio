import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { noteLength, hasFreeNoteLength } from '../../web/note-length.js';

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
const S = { pxPerSec: 100, toolMode: 'pan', state: { projectStart: 0, duration: 10, lanes: [lane], tempoMap: [], rowH: 10 },
  matches: [], selection: new Set(), detectRegion: null };
S.state.spec = {midi_low: 0, midi_high: 127};
const noop = () => {}, commits = [];
// A dip's end handles sit on the note's edges, on its row (y 100).
const endHandles = n => n.whammy ? [{ i: 0, kind: 'whammy', note: n, x: n.start * 100, y: 100 }, { i: 2, kind: 'whammy', note: n, x: n.end * 100, y: 100 },
  { i: 1, kind: 'whammy', note: n, x: (n.start + n.end) * 50, y: 300 }] : [];
const subdivision = { value: '8' };
const oldWindow = globalThis.window;
try {
  globalThis.window = win;
  const gridDependencies = {
    './store.js': { S }, './dom.js': {
      bpmInput: { value: '120' }, offsetInput: { value: '0' }, tsNumInput: { value: '4' },
      tsDenInput: { value: '4' }, subdivSel: subdivision, subdivCustom: { value: '8' },
    },
  };
  const gridReal = { './bars.js': true, './constants.js': true, './project-position-core.js': true, './auto-grid.js': true };
  const controls = await mockImport(new URL('../../web/grid-controls.js', import.meta.url), gridDependencies, gridReal);
  const grid = await mockImport(new URL('../../web/grid-read.js', import.meta.url), { ...gridDependencies, './grid-controls.js': controls }, gridReal);
  const dependencies = {
    './marker-clipboard.js': { deleteMarkers: () => false, cutMarkers: () => false, hasMarkerSelection: () => false, hasMarkerClip: () => false, forgetMarkerClip: () => {}, clearMarkerSelection: () => false, markerSelectClick: () => false },
    './store.js': { S, setSelection: value => { S.selection = value; } },
    './dom.js': { stage, scroll }, './repaint.js': { draw: noop }, './grid-read.js': grid, './grid-controls.js': controls,
    './lanes.js': { activeLane: () => lane, targetLane: () => lane, laneOf: () => lane, canEditLane: value => !!value?.visible, refreshCounts: noop,
      setLaneNotePitch: (lane, note, pitch) => {note.pitch = pitch;} },
    './geometry.js': { timeAt: x => x / 100, xOf: t => t * 100, pitchAt: () => 64, pitchAtExact: () => 64, yOf: () => 100 },
    './markers.js': { markerMouseDown: () => false, markerCursorAt: () => null }, './comments.js': { commentMouseDown: () => false, commentAt: () => null }, './marker-rails.js': { markerRails: () => [] },
    './ids.js': { nid: () => 'new-boundary-note' },
    './note-render.js': { regionEdgeAt: () => null, noteRibbon: () => null, slideFretsHandle: () => null, curveHandles: endHandles }, './grace.js': { graceBefore: () => null },
    './references.js': { boxOfNote: () => null, refLockAt: () => null, refBadgeAt: () => null, refBoxEdgeAt: () => null },
    './playback.js': { auditionNote: noop },
    './note-motion.js': { beginNoteGesture: noop, updateNoteGesture: noop, finishNoteGesture: noop },
    './edit-history.js': { snapshotEdit: () => structuredClone(lane.notes), commit: (...args) => commits.push(args) },
    './edit.js': {
      curveOf: n => n.whammyPoints || [[0, 0], [0.5, -2], [1, 0]], setBendCurve: (n, pts) => { n.whammyPoints = pts; } },
  };
  const real = { './shapes.js': true, './constants.js': true, './util.js': true, './note-length.js': true, './note-merge.js': true, './bend.js': true, './whammy.js': true,
    './project-position-core.js': true };
  const hitTesting = await mockImport(new URL('../../web/stage-hit-test.js', import.meta.url), dependencies, real);
  const { init_interaction } = await mockImport(new URL('../../web/interaction.js', import.meta.url), { ...dependencies, './stage-hit-test.js': hitTesting }, real);
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
  assert.equal(note.end, 2.046875, 'Alt snaps to eighths of the authored grid cell');
  win.emit('keyup', { key: 'Alt' });
  assert.equal(note.end, 2, 'releasing Alt restores grid snapping without more pointer movement');
  win.emit('keydown', { key: 'Alt', altKey: true });
  assert.equal(note.end, 2.046875);
  win.emit('mouseup', { clientX: 204, altKey: true });
  assert.equal(note.end, 2.046875, 'mouse release retains the fine-grid placement');

  // A whammy note: its end handle is on the right edge. Sideways it resizes the
  // note, up and down it moves the curve's end.
  note.whammy = 'dip';
  stage.emit('mousedown', { clientX: 205 });
  assert.equal(S.drag.mode, 'bendPoint');
  win.emit('mousemove', { clientX: 240 });
  assert.equal(S.drag.mode, 'resize', 'a sideways drag on an end handle resizes');
  assert.equal(note.end, 2.375);
  win.emit('mouseup', { clientX: 240 });
  stage.emit('mousedown', { clientX: 237.5 });
  win.emit('mousemove', { clientX: 237.5, clientY: 120 });
  assert.equal(S.drag.mode, 'bendPoint', 'an up/down drag stays on the point');
  assert.deepEqual(note.whammyPoints.at(-1), [1, -1.5]);
  win.emit('mouseup', { clientX: 237.5, clientY: 120 });
  assert.equal(note.end, 2.375);
  // A middle point's time lands on the grid (1.70 s -> 1.75 s).
  stage.emit('mousedown', { clientX: 170.3, clientY: 300 });
  win.emit('mousemove', { clientX: 170, clientY: 300 });
  assert.ok(Math.abs(note.whammyPoints[1][0] - (1.75 - 1.031) / (2.375 - 1.031)) < 1e-9, 'a dragged point snaps to the grid');
  win.emit('mouseup', { clientX: 170, clientY: 300 });
  delete note.whammy; delete note.whammyPoints;

  // Normal resize leaves one visible cell; Alt permits a shorter precise span.
  for (const pxPerSec of [100, 2000]) {
    S.pxPerSec = pxPerSec;
    const minimum = grid.displayGridStep(grid.gridAt(1.031));
    for (const altKey of [false, true]) {
      const expectedMinimum = altKey ? Math.min(.05, minimum) : minimum;
      note.start = 1.031; note.end = 1.5;
      stage.emit('mousedown', { clientX: 149, altKey });
      win.emit('mousemove', { clientX: 103, altKey });
      assert.ok(Math.abs(note.end - note.start - expectedMinimum) < 1e-9, 'right edge respects normal or fine minimum');
      win.emit('mouseup', { clientX: 103, altKey });
      assert.ok(note.end - note.start >= expectedMinimum - 1e-9, 'release preserves minimum length');
      note.start = 1.031; note.end = 1.5;
      stage.emit('mousedown', { clientX: 104, altKey });
      win.emit('mousemove', { clientX: 150, altKey });
      assert.ok(Math.abs(note.end - note.start - expectedMinimum) < 1e-9, 'left edge respects normal or fine minimum');
      win.emit('mouseup', { clientX: 150, altKey });
    }
  }
  note.start = 1.031; note.end = 1.5;
  S.pxPerSec = 100;

  const before = { lane: structuredClone(lane.notes) };
  grid.snapStrayNotes([lane], before);
  assert.equal(note.start, 1.031, 'subsequent unrelated edits leave free timing intact');
  S.pxPerSec = 30;
  assert.equal(grid.displayGridStep(grid.gridAt(0)), .5);
  assert.equal(note.start, 1.031, 'zooming never modifies note data');
  assert.deepEqual(grid.snapNote(1.2, 1.2625), { start: 1, end: 1.0625 },
    'coarse zoom does not stretch a short note when moving it');

  note.start = 1; note.end = 1.237; S.selection = new Set([note]);
  const length = note.end - note.start;
  stage.emit('mousedown', {clientX: 112});
  assert.equal(S.drag.mode, 'move');
  win.emit('mousemove', {clientX: 165});
  assert.equal(note.start, 1.53125, 'free-length notes use eighth-cell snapping without a modifier');
  assert.ok(Math.abs(note.end - note.start - length) < 1e-9, 'moving preserves the exact free duration');
  win.emit('mouseup', {clientX: 165});
  assert.equal(note.start, 1.53125, 'release retains the fine-grid position');
  assert.equal(commits.at(-1)[3].preserveTiming, true, 'commit does not snap the free move afterward');
  assert.ok(Math.abs(note.end - note.start - length) < 1e-9, 'mouse release does not requantize the duration');
  const movedEnd = note.end;
  stage.emit('mousedown', {clientX: movedEnd * 100 - 1});
  win.emit('mousemove', {clientX: movedEnd * 100 + 25, altKey: true});
  win.emit('mouseup', {clientX: movedEnd * 100 + 25, altKey: true});
  assert.equal(note.end, 2.03125, 'Alt resizing retains the fine-grid endpoint on release');

  note.start = 1; note.end = 1.25;
  stage.emit('mousedown', {clientX: 112});
  win.emit('mousemove', {clientX: 165});
  assert.equal(note.start, 1.5, 'grid-length notes still snap during movement');
  win.emit('mouseup', {clientX: 165});
  assert.equal(note.start, 1.5);
  assert.equal(note.end, 1.75);

  // Zoom can display divisions finer than the authored grid. Normal resizing
  // must not turn a regular note into a precise/free-length one.
  subdivision.value = '4'; S.pxPerSec = 2000;
  note.start = 1; note.end = 1.5;
  stage.emit('mousedown', {clientX: 149});
  win.emit('mousemove', {clientX: 156});
  win.emit('mouseup', {clientX: 156});
  assert.equal(note.end, 1.5625, 'normal resize reaches visible 32nd divisions');
  assert.equal(hasFreeNoteLength(note, grid.gridSegments()), false, 'ordinary resize keeps the regular-length classification');
  stage.emit('mousedown', {clientX: 120});
  win.emit('mousemove', {clientX: 174});
  win.emit('mouseup', {clientX: 174});
  assert.equal(note.start, 1.5625, 'subsequent movement follows the visible grid');
  assert.equal(hasFreeNoteLength(note, grid.gridSegments()), false);
  stage.emit('mousedown', {clientX: note.end * 100 - 1, altKey: true});
  win.emit('mousemove', {clientX: note.end * 100 + 9, altKey: true});
  win.emit('mouseup', {altKey: true});
  assert.equal(hasFreeNoteLength(note, grid.gridSegments()), true, 'explicit Alt resizing still permits precise lengths');
  subdivision.value = '8'; S.pxPerSec = 100;

  // Mixed lengths and off-grid spacing move as one group, even at the bounds.
  note.start = 1; note.end = 1.237;
  const companion = {id: 'companion', start: 2.03, end: 2.28, pitch: 69};
  lane.notes = [note, companion]; S.selection = new Set(lane.notes);
  stage.emit('mousedown', {clientX: 112});
  win.emit('mousemove', {clientX: 164.6});
  assert.equal(note.start, 1.5234375, 'the group anchor snaps at eight times the authored precision');
  assert.ok(Math.abs(companion.start - note.start - 1.03) < 1e-9, 'mixed-length notes keep their original spacing');
  assert.ok(Math.abs(companion.end - companion.start - .25) < 1e-9);
  S.state.duration = 3;
  win.emit('mousemove', {clientX: 500});
  assert.equal(companion.end, 3, 'the group stops when its latest tail reaches the song end');
  assert.ok(Math.abs(companion.start - note.start - 1.03) < 1e-9, 'song-end clamping moves the group together');
  win.emit('mousemove', {clientX: -100});
  assert.equal(note.start, 0);
  assert.ok(Math.abs(companion.start - note.start - 1.03) < 1e-9, 'song-start clamping moves the group together');
  win.emit('mouseup', {clientX: -100});
  assert.ok(Math.abs(note.end - note.start - .237) < 1e-9, 'group release preserves each duration');
  assert.ok(Math.abs(companion.start - note.start - 1.03) < 1e-9, 'group release preserves spacing');
  lane.notes = [note]; S.selection = new Set([note]); S.state.duration = 10;

  // A tempo marker between old-grid lines ends a shortened final cell.
  S.pxPerSec = 2000;
  S.state.tempoMap = [{ t: 1.23, bpm: 60, tsNum: 4, tsDen: 4, subdiv: 8 }];
  note.start = 1.1875; note.end = 1.5;
  stage.emit('mousedown', { clientX: 149 });
  win.emit('mousemove', { clientX: 122 });
  assert.equal(note.end, 1.23, 'right edge can stop at the marker despite the short cell');
  win.emit('mouseup', { clientX: 122 });
  assert.equal(note.end, 1.23, 'committing retains the exact boundary');
  stage.emit('mousedown', { clientX: 119 });
  win.emit('mousemove', { clientX: 122.5 });
  assert.equal(note.start, 1.1875, 'left edge permits the shortened cell before a marker');
  win.emit('mouseup', { clientX: 122.5 });
  note.start = 1; note.end = 1.5;
  stage.emit('mousedown', { clientX: 149 });
  win.emit('mousemove', { clientX: 148 });
  assert.ok(note.end > 1.23, 'resizing past a marker still permits an intentional sustain');
  win.emit('mouseup', { clientX: 148 });

  // Drawing a new note uses the same shortened final cell as resizing.
  lane.notes = []; S.motifLabels = []; S.shapeLabels = []; S.selection.clear();
  noteLength.remember(S.state, { start: 0, end: .0625 }, grid.gridSegments());
  stage.emit('dblclick', { clientX: 118.75 });
  assert.equal(lane.notes.length, 1, 'a short final cell can still be drawn');
  assert.equal(lane.notes[0].start, 1.1875);
  assert.equal(lane.notes[0].end, 1.23, 'a drawn note ends exactly at the tempo marker');
} finally { globalThis.window = oldWindow; }
console.log('resize grid: adaptive snapping, Alt, release, fixed edges and persistent free timing passed');
