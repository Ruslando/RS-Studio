import { dockBounds, dockPosition, nearestDock } from './edge-dock.js';
import { closeMenus } from './menus.js';
import { icon, DRAG_HANDLE_ICON } from './icons.js';

export function initSpectrogramDock(panel) {
  const key = 'rs-spectrogram-controls';
  let state = { edge: 'right', fraction: .15, collapsed: true };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && ['top','right','bottom','left'].includes(saved.edge) && Number.isFinite(saved.fraction))
      state = { edge: saved.edge, fraction: Math.max(0, Math.min(1, saved.fraction)), collapsed: saved.collapsed !== false };
  } catch { /* use the default layout */ }
  const handle = document.getElementById('stageControlsDrag'), toggle = document.getElementById('stageControlsToggle');
  const body = document.getElementById('stageControlsBody');
  handle.innerHTML = DRAG_HANDLE_ICON;
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* optional preference */ } };
  const bounds = () => dockBounds(panel.parentElement.clientWidth, panel.parentElement.clientHeight, panel.offsetWidth, panel.offsetHeight);
  function position() {
    if (panel.hidden) return;
    const { x, y } = dockPosition(bounds(), state.edge, state.fraction);
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
    panel.dataset.edge = state.edge;
    panel.dataset.statusAbove = String(y + panel.offsetHeight + 50 > panel.parentElement.clientHeight);
  }
  function collapse() {
    body.hidden = state.collapsed;
    toggle.setAttribute('aria-expanded', String(!state.collapsed));
    toggle.title = state.collapsed ? 'Expand spectrogram controls' : 'Collapse spectrogram controls';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.innerHTML = icon(state.collapsed ? 'chevronDown' : 'chevronUp', 14);
    panel.classList.toggle('collapsed', state.collapsed); position();
  }
  toggle.addEventListener('click', () => { closeMenus(); state.collapsed = !state.collapsed; collapse(); save(); });
  let drag = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); closeMenus();
    drag = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    handle.setPointerCapture(event.pointerId); panel.classList.add('docking');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    Object.assign(state, nearestDock(bounds(), drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y));
    position();
  });
  const finish = () => { if (drag) save(); drag = null; panel.classList.remove('docking'); };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, finish);
  handle.addEventListener('keydown', event => {
    const edge = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }[event.key];
    if (!edge) return;
    event.preventDefault(); event.stopPropagation(); closeMenus(); state.edge = edge; position(); save();
  });
  new ResizeObserver(position).observe(panel.parentElement);
  new ResizeObserver(position).observe(panel);
  new MutationObserver(position).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  collapse();
}
