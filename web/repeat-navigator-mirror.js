import { renderRepeatNavigator } from './repeats.js';
import { initRepeatDock } from './repeat-dock.js';

// The inactive pane has its own toolbar and picker state. Commands first make
// that pane live, then use the same handlers as the editor's toolbar.
export function createRepeatNavigatorMirror(parent, activate) {
  const source = document.getElementById('repeatNavigator');
  const panel = source.cloneNode(true);
  panel.querySelector('#repeatHover').remove();
  const elements = {};
  for (const element of [panel, ...panel.querySelectorAll('[id]')]) {
    const id = element.id;
    elements[id] = element;
    element.id = id.replace(/^repeat/, 'splitRepeat');
  }
  parent.append(panel);
  initRepeatDock(panel, elements.repeatDrag, { key: 'rs-repeat-controls-other' });
  // Native controls and docking work without the stage's click-to-activate
  // forwarding, which targets coordinates rather than toolbar commands.
  for (const type of ['pointerdown', 'mousedown', 'contextmenu'])
    panel.addEventListener(type, event => event.stopPropagation());
  const forward = (id, change = false) => {
    const value = elements[id].value;
    activate();
    const control = document.getElementById(id);
    if (change) { control.value = value; control.dispatchEvent(new Event('change')); }
    else control.click();
    queueMicrotask(() => (control.querySelector('summary') || control).focus({ preventScroll: true }));
  };
  for (const id of ['repeatGroupPrevious', 'repeatGroupNext', 'repeatPrevious', 'repeatNext',
    'repeatChangePrevious', 'repeatChangeNext', 'repeatClose'])
    elements[id].addEventListener('click', () => forward(id));
  for (const id of ['repeatGroup', 'repeatInstance', 'repeatChangePosition'])
    elements[id].addEventListener('change', () => forward(id, true));
  elements.repeatInstance.addEventListener('toggle', () => {
    if (elements.repeatInstance.open) document.getElementById('repeatInstance').open = false;
  });
  window.addEventListener('pointerdown', event => {
    if (!elements.repeatInstance.contains(event.target)) elements.repeatInstance.open = false;
  });
  return () => renderRepeatNavigator(elements);
}
