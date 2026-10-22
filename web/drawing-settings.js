// Compact, live controls share the authoritative inputs and persistence used by
// Editor settings. The modal keeps its existing Apply / cancel behavior.
import { $ } from './dom.js';
import { S } from './store.js';
import { keyOf, matchKey, shortcutTitle } from './keymap.js';
import { placeFloating } from './floating-position.js';
import { registerEscapeLayer, ESC_DEPTH } from './escape-stack.js';
import { closeMenus } from './menus.js';

function position() {
  const panel = $('drawingQuickPanel'), rect = $('drawingSettings').getBoundingClientRect();
  placeFloating(panel, rect.right - panel.offsetWidth, rect.bottom);
}
function sync() {
  const snap = $('traceSnap').checked;
  $('drawingSettingsStatus').textContent = snap ? 'Snap to pitch' : 'Free draw';
  $('drawingSettings').title = shortcutTitle(`Drawing: ${snap ? 'snap to pitch' : 'free draw'}`, 'drawingSettings');
  $('quickTraceSnapKey').textContent = keyOf('drawingSnap') || '';
  $('quickTraceSnap').title = shortcutTitle('Snap to pitch', 'drawingSnap');
}
export function toggleDrawingSnap() {
  const control = $('traceSnap');
  control.checked = !control.checked;
  control.dispatchEvent(new Event('change', { bubbles: true }));
}
function close(returnFocus = false) {
  const panel = $('drawingQuickPanel');
  if (panel.hidden) return false;
  if (panel.contains(document.activeElement)) document.activeElement.blur();
  panel.hidden = true; $('drawingSettings').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('drawingSettings').focus({ preventScroll: true });
  return true;
}
export function toggleDrawingSettings() {
  if (close(true) || !S.state) return;
  closeMenus();
  $('drawingQuickPanel').hidden = false;
  $('drawingSettings').setAttribute('aria-expanded', 'true');
  sync(); position();
  $('quickTraceSnap').focus({ preventScroll: true });
}
export function initDrawingSettings() {
  const panel = $('drawingQuickPanel'), button = $('drawingSettings');
  button.addEventListener('click', toggleDrawingSettings);
  $('drawingQuickClose').addEventListener('click', () => close(true));
  for (const id of ['traceSnap','traceRange'])
    $(id).addEventListener(id === 'traceSnap' ? 'change' : 'input', sync);
  window.addEventListener('cw-keymap-changed', sync);
  registerEscapeLayer(ESC_DEPTH.popover, () => close(true));
  document.addEventListener('pointerdown', event => {
    if (!panel.contains(event.target) && !button.contains(event.target)) close();
  }, true);
  document.addEventListener('focusin', event => {
    if (!panel.contains(event.target) && !button.contains(event.target)) close();
  });
  panel.addEventListener('keydown', event => {
    if (matchKey(event, 'drawingSettings')) {
      event.preventDefault(); event.stopPropagation(); close(true);
    } else if (matchKey(event, 'drawingSnap')) {
      event.preventDefault(); event.stopPropagation(); toggleDrawingSnap();
    } else if (event.key === ' ') {
      // Space operates the focused checkbox / button without starting playback.
      event.stopPropagation();
    }
  });
  window.addEventListener('resize', () => { if (!panel.hidden) position(); });
  window.addEventListener('cw-project-closed', () => close());
  window.addEventListener('cw-project-opened', () => { close(); sync(); });
  sync();
}
