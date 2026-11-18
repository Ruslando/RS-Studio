import { renderRepeatNavigator } from './repeats.js';

// The inactive pane has its own toolbar, fixed on its side of the split view's
// rail (split-view.js), which shows only its instance controls. Commands first
// make that pane live, then use the same handlers as the editor's toolbar.
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
  const forward = (id, change = false) => {
    const value = elements[id].value;
    activate();
    const control = document.getElementById(id);
    if (change) { control.value = value; control.dispatchEvent(new Event('change')); }
    else { control.click(); queueMicrotask(() => control.focus({ preventScroll: true })); }
    // A dropdown hands focus back (select-pickers.js): focusing the live one would keep the keys.
  };
  for (const id of ['repeatGroupPrevious', 'repeatGroupNext', 'repeatPrevious', 'repeatNext',
    'repeatChangePrevious', 'repeatChangeNext', 'repeatClose'])
    elements[id].addEventListener('click', () => forward(id));
  for (const id of ['repeatGroup', 'repeatInstance', 'repeatChangePosition'])
    elements[id].addEventListener('change', () => forward(id, true));
  return () => renderRepeatNavigator(elements);
}
