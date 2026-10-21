import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

class Element extends EventTarget {
  style = {}; hidden = true; clientWidth = 0;
  attributes = new Map();
  classList = { add() {}, remove() {} };
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  toggleAttribute(key, on) { if (on) this.setAttribute(key, ''); else this.removeAttribute(key); }
  getAttribute(key) { return this.attributes.get(key); }
  getBoundingClientRect() { return { height: 200 }; }
  blur() {}
}
const elements = new Map(), $ = id => {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
};
const win = new EventTarget(), S = { selection: new Set() };
let playing = false;
const saved = Object.fromEntries(['window', 'localStorage', 'ResizeObserver'].map(key => [key, globalThis[key]]));
const noop = () => {};
try {
  Object.assign(globalThis, { window: win, localStorage: { getItem: () => null }, ResizeObserver: class { observe() {} } });
  const dom = Object.fromEntries(['editorEl', 'fretboardApply', 'fretboardAuto', 'fretboardBusy', 'fretboardBusyLabel',
    'fretboardEl', 'fretboardFollow', 'fretboardName', 'fretboardPanel', 'fretboardPin',
    'fretboardShape', 'fretboardStage'].map(id => [id, $(id)]));
  dom.fretboardFollow.children = ['here', 'guided', 'locked'].map(follow =>
    Object.assign(new Element(), { dataset: { follow } }));
  const board = await mockImport(new URL('../../web/fretboard.js', import.meta.url), {
    './dom.js': { ...dom, $ }, './store.js': { S },
    './playback.js': { transportPlaying: () => playing },
    './panel-motion.js': { panelMotion: () => ({ duration: 0 }) },
    './repaint.js': { draw: noop }, './splitters.js': { splitter: noop },
    './canvas-controls.js': { panelControls: () => [], syncPanelControls: noop },
    './ui.js': { wireMenu: noop }, './escape-stack.js': { ESC_DEPTH: {}, registerEscapeLayer: noop },
    './layer-role.js': { selectedTablatureLane: () => null }, './lanes.js': { canEditLane: () => false },
  });
  board.init_fretboard();
  const mode = () => String(dom.fretboardPanel.attributes.has('data-editing'));
  const transport = type => { const e = new Event('cw-transport'); e.detail = type; win.dispatchEvent(e); };
  board.setFretboardVisible(true);
  assert.equal(mode(), 'true', 'opening a paused fretboard defaults to edit mode');
  playing = true; transport('play');
  assert.equal(mode(), 'false', 'playback switches the board to preview');
  board.setFretboardEdit(true);
  assert.equal(mode(), 'false', 'edit mode cannot be enabled during playback');
  playing = false; transport('pause');
  assert.equal(mode(), 'true', 'pausing restores edit mode');
  board.setFretboardEdit(false);
  transport('seek');
  assert.equal(mode(), 'false', 'a seek preserves an explicitly chosen paused preview');
  playing = true; transport('play');
  playing = false; transport('pause');
  assert.equal(mode(), 'true', 'the next pause restores the edit default');
  board.setFretboardVisible(false);
  playing = true;
  board.setFretboardVisible(true);
  assert.equal(mode(), 'false', 'opening while playing stays in preview mode');
  board.setFretboardVisible(false);
  playing = false; transport('pause');
  assert.equal(mode(), 'false', 'a collapsed fretboard stays inactive');
  board.setFretboardVisible(true);
  assert.equal(mode(), 'true', 'reopening while paused restores edit mode');
} finally { Object.assign(globalThis, saved); }
console.log('Fretboard transport defaults passed');
