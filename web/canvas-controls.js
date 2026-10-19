// Toolbar shortcuts and direct edge handles are two views of one panel state.
import { shortcutTitle } from './keymap.js';
export function panelControls(name) {
  return [...document.querySelectorAll(`[data-panel-toggle="${name}"]`)];
}
export function syncPanelControls(name, expanded, label) {
  for (const button of panelControls(name)) {
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', label);
    const command = { sidebar: 'sidebar', artifacts: 'artifacts', markers: 'markerLanes', fretboard: 'fretboard' }[name];
    button.title = command ? shortcutTitle(label, command) : label;
  }
}
