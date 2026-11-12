import assert from 'node:assert/strict';
import { wireDockControls } from '../../web/dock-controls.js';

const original = { ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver };
const observations = [];
class Observer {
  constructor(callback) { this.callback = callback; }
  observe(target, options) { observations.push({ observer: this, target, options }); }
}
globalThis.ResizeObserver = globalThis.MutationObserver = Observer;
try {
  const listeners = {}, classes = new Set();
  const panel = { offsetLeft: 50, offsetTop: 20, parentElement: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  let capture, saves = 0, positions = 0, menusClosed = 0;
  const handle = { addEventListener: (name, callback) => { listeners[name] = callback; },
    setPointerCapture: id => { capture = id; } };
  const state = { edge: 'top', fraction: .5, collapsed: false, tab: 'draw' };
  wireDockControls(panel, handle, {
    bounds: () => ({ left: 0, right: 100, top: 0, bottom: 100 }),
    move: dock => Object.assign(state, dock), setEdge: edge => { state.edge = edge; },
    position: () => positions++, save: () => saves++, beforeMove: () => menusClosed++,
  });
  const event = values => ({ button: 0, clientX: 10, clientY: 10, pointerId: 7,
    preventDefault() {}, stopPropagation() {}, ...values });
  listeners.pointerdown(event({ button: 2 }));
  listeners.pointermove(event({ clientX: 60 }));
  assert.equal(positions, 0, 'right-click must not start a dock drag');
  listeners.pointerdown(event());
  assert.equal(capture, 7);
  assert.equal(classes.has('docking'), true);
  listeners.pointermove(event({ clientX: 110, clientY: 60 }));
  assert.equal(state.edge, 'right');
  assert.equal(state.tab, 'draw', 'docking preserves panel-specific state');
  assert.equal(state.collapsed, false);
  listeners.pointercancel();
  listeners.lostpointercapture();
  assert.equal(saves, 1, 'cancellation and lost capture must not save twice');
  assert.equal(classes.has('docking'), false);
  listeners.pointermove(event());
  assert.equal(positions, 1, 'movement after cancellation is ignored');
  listeners.keydown(event({ key: 'ArrowLeft' }));
  assert.equal(state.edge, 'left');
  assert.equal(saves, 2);
  assert.equal(menusClosed, 2, 'drag and keyboard docking close menus');
  listeners.keydown(event({ key: 'Enter' }));
  assert.equal(saves, 2, 'unrelated keys do not move or persist the dock');
  assert.equal(observations.length, 3);
  observations[0].observer.callback();
  assert.equal(positions, 3, 'parent resize repositions the dock');
} finally { Object.assign(globalThis, original); }
console.log('Dock capture, cancellation, keyboard movement and panel state passed');
