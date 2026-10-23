// Drawing controls live on the spectrogram controls' Drawing tab. They mirror the
// authoritative inputs persisted by Editor settings (settings.js).
import { $ } from './dom.js';
import { S } from './store.js';
import { keyOf, shortcutTitle } from './keymap.js';
import { toggleStageTab } from './spectrogram-dock.js';

function sync() {
  $('quickTraceSnapKey').textContent = keyOf('drawingSnap') || '';
  $('quickTraceSnap').title = shortcutTitle('Snap to pitch', 'drawingSnap');
  $('stageTabDraw').title = shortcutTitle('Drawing settings', 'drawingSettings');
}
export function toggleDrawingSnap() {
  const control = $('traceSnap');
  control.checked = !control.checked;
  control.dispatchEvent(new Event('change', { bubbles: true }));
}
export function toggleDrawingSettings() {
  if (S.state && toggleStageTab('draw')) $('quickTraceSnap').focus({ preventScroll: true });
}
export function initDrawingSettings() {
  window.addEventListener('cw-keymap-changed', sync);
  sync();
}
export function normalizeTraceRange(value) {
  const range = Number(value);
  return range >= 3 ? '3' : range === 1 ? '1' : '2';
}
