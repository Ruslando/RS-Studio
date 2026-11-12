import { dockBounds, dockPosition, nearestDock } from './edge-dock.js';
import { DRAG_HANDLE_ICON } from './icons.js';

export function initRepeatDock(panel, handle) {
  const key = 'rs-repeat-controls';
  let state = { edge: 'top', fraction: .5 }, drag = null;
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
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    handle.setPointerCapture(event.pointerId); panel.classList.add('docking');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    state = nearestDock(bounds(), drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y); position();
  });
  const finish = () => { if (drag) save(); drag = null; panel.classList.remove('docking'); };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, finish);
  handle.addEventListener('keydown', event => {
    const edge = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }[event.key];
    if (!edge) return;
    event.preventDefault(); event.stopPropagation(); state.edge = edge; position(); save();
  });
  new ResizeObserver(position).observe(panel.parentElement);
  new ResizeObserver(position).observe(panel);
  new MutationObserver(position).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  position();
}
