import { wireDockControls } from './dock-controls.js';
import { dockBounds, dockPosition } from './edge-dock.js';
import { DRAG_HANDLE_ICON } from './icons.js';

export function initRepeatDock(panel, handle) {
  const key = 'rs-repeat-controls';
  let state = { edge: 'top', fraction: .5 };
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
  wireDockControls(panel, handle, {
    bounds, position, save,
    move: dock => { state = dock; },
    setEdge: edge => { state.edge = edge; },
  });
  position();
}
