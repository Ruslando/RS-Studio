import { wireDockControls } from './dock-controls.js';
import { dockBounds, dockPosition } from './edge-dock.js';
import { DRAG_HANDLE_ICON } from './icons.js';

const docks = new WeakMap();

// The live and painted DOM panes trade places when focus changes. Their dock
// positions belong to the physical sides, so trade those along with the views.
export function swapRepeatDocks(first, second) {
  const a = docks.get(first), b = docks.get(second);
  if (!a || !b) return;
  const state = a.read();
  a.restore(b.read()); b.restore(state);
}

// Also the split view's settings bar (split-view.js), under its own key.
export function initRepeatDock(panel, handle, { key = 'rs-repeat-controls', edge = 'top' } = {}) {
  let state = { edge, fraction: .5 };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && ['top', 'right', 'bottom', 'left'].includes(saved.edge) && Number.isFinite(saved.fraction))
      state = { edge: saved.edge, fraction: Math.max(0, Math.min(1, saved.fraction)) };
  } catch { /* optional layout preference */ }
  handle.innerHTML = DRAG_HANDLE_ICON;
  const bounds = () => dockBounds(panel.parentElement.clientWidth, panel.parentElement.clientHeight, panel.offsetWidth, panel.offsetHeight);
  const position = () => {
    if (panel.hidden) return;
    const { x, y } = dockPosition(bounds(), state.edge, state.fraction);
    panel.style.left = `${x}px`; panel.style.top = `${y}px`; panel.dataset.edge = state.edge;
    panel.dataset.menuAbove = String(y > panel.parentElement.clientHeight / 2);
  };
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* optional preference */ } };
  docks.set(panel, {
    read: () => ({ ...state }),
    restore: next => { state = { ...next }; position(); save(); },
  });
  wireDockControls(panel, handle, {
    bounds, position, save,
    move: dock => { state = dock; },
    setEdge: edge => { state.edge = edge; },
  });
  position();
}
