import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

class Surface {
  listeners = new Map(); style = {};
  addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
  emit(type, props = {}) {
    const event = { clientX: 200, clientY: 100, button: 0, preventDefault() {}, ...props };
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}
const stage = new Surface(), scroll = Object.assign(new Surface(), { scrollLeft: 0, scrollTop: 0 });
const win = new Surface(), lane = { visible: true, notes: [] };
const S = { state: { duration: 10, lanes: [lane] }, matches: [], selection: new Set(), detectRegion: { t0: 2, t1: 4 } };
const noop = () => {};
const oldWindow = globalThis.window;
try {
  globalThis.window = win;
  const { init_interaction } = await mockImport(new URL('../../web/interaction.js', import.meta.url), {
    './store.js': { S }, './dom.js': { stage, scroll }, './repaint.js': { draw: noop },
    './lanes.js': { activeLane: () => lane },
    './geometry.js': { timeAt: x => x / 100, pitchAt: () => 64 },
    './markers.js': { markerMouseDown: () => false, markerCursorAt: () => null },
    './marker-rails.js': { markerRails: () => [] },
    './note-render.js': { regionEdgeAt: x => Math.abs(x - S.detectRegion.t0 * 100) < 7 ? 'l' : Math.abs(x - S.detectRegion.t1 * 100) < 7 ? 'r' : null },
    './detect.js': { updateDetectStatus: noop }, './note-motion.js': { finishNoteGesture: noop },
  }, { './constants.js': true, './util.js': true, './note-length.js': true });
  init_interaction();
  for (const tool of ['pan', 'trace', 'select', 'frame', 'marquee']) {
    S.toolMode = tool; S.detectRegion = { t0: 2, t1: 4 };
    stage.emit('mousedown');
    assert.equal(S.drag?.mode, 'regionEdge', `${tool} does not swallow the loop handle`);
    assert.equal(S.drag.edge, 'l');
    win.emit('mousemove', { clientX: 150 });
    assert.equal(S.detectRegion.t0, 1.5, `${tool}: left handle changes the start`);
    win.emit('mouseup', { clientX: 150 });
    assert.equal(S.drag, null);
    stage.emit('mousedown', { clientX: 400 });
    assert.equal(S.drag?.edge, 'r');
    win.emit('mousemove', { clientX: 500 });
    assert.equal(S.detectRegion.t1, 5, `${tool}: right handle changes the end`);
    win.emit('mouseup', { clientX: 500 });
  }
  S.toolMode = 'trace';
  stage.emit('mousemove', { clientX: 500 });
  assert.equal(stage.style.cursor, 'ew-resize', 'Trace retains the handle resize cursor');
} finally { globalThis.window = oldWindow; }
console.log('Loop handles resize in every tool');
