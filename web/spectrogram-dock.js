import { dockBounds, dockPosition, nearestDock } from './edge-dock.js';
import { closeMenus } from './menus.js';
import { icon, DRAG_HANDLE_ICON } from './icons.js';

let showTab = () => {};
// Expand the controls on one tab ('view' | 'draw'); a second call on the open tab collapses.
export const toggleStageTab = tab => showTab(tab);

export function initSpectrogramDock(panel) {
  const key = 'rs-spectrogram-controls';
  let state = { edge: 'right', fraction: .15, collapsed: true, tab: 'view' };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && ['top','right','bottom','left'].includes(saved.edge) && Number.isFinite(saved.fraction))
      state = { edge: saved.edge, fraction: Math.max(0, Math.min(1, saved.fraction)), collapsed: saved.collapsed !== false, tab: saved.tab === 'draw' ? 'draw' : 'view' };
  } catch { /* use the default layout */ }
  const handle = document.getElementById('stageControlsDrag'), toggle = document.getElementById('stageControlsToggle');
  const body = document.getElementById('stageControlsBody'), tabs = document.getElementById('stageControlsTabs');
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
    body.hidden = tabs.hidden = state.collapsed;
    for (const button of tabs.querySelectorAll('[data-stage-tab]')) {
      const active = button.dataset.stageTab === state.tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      document.getElementById(button.getAttribute('aria-controls')).hidden = !active;
    }
    toggle.setAttribute('aria-expanded', String(!state.collapsed));
    toggle.title = state.collapsed ? 'Expand spectrogram controls' : 'Collapse spectrogram controls';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.innerHTML = icon(state.collapsed ? 'chevronDown' : 'chevronUp', 14);
    panel.classList.toggle('collapsed', state.collapsed); position();
  }
  toggle.addEventListener('click', () => { closeMenus(); state.collapsed = !state.collapsed; collapse(); save(); });
  const select = tab => { closeMenus(); state.tab = tab; state.collapsed = false; collapse(); save(); };
  for (const button of tabs.querySelectorAll('[data-stage-tab]')) button.addEventListener('click', () => select(button.dataset.stageTab));
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    select(state.tab === 'view' ? 'draw' : 'view');
    tabs.querySelector(`[data-stage-tab="${state.tab}"]`).focus();
  });
  showTab = tab => {
    if (panel.hidden) return false;
    if (!state.collapsed && state.tab === tab) { state.collapsed = true; collapse(); save(); return false; }
    select(tab); return true;
  };
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
