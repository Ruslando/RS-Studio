// The app's tooltip (design 4.19). Any element with `data-tip` gets it on hover
// (`data-tip-tone` "error" or "warning" marks it as one); a canvas, whose marks
// are not elements, calls showTooltip with the pointer. A tip is a string, its
// first line the title, or blocks { title, body, tone, actionKey?, actions? }.
// Diagnostic actions stay separate from the serializable hover identity.
import { placeFloating } from './floating-position.js';
import { icon } from './icons.js';

const TONES = { error: 'Error', warning: 'Warning', note: 'Note' };

const DELAY_MS = 400, DISMISS_MS = 300;
let tip = null, timer = 0, dismissTimer = 0, shownText = '', owner = null;
let interactive = false, pointerInside = false;

function element() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip app-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    tip.addEventListener('mouseenter', () => { pointerInside = true; cancelDismiss(); });
    tip.addEventListener('mouseleave', () => { pointerInside = false; scheduleTooltipHide(); });
    tip.addEventListener('focusin', cancelDismiss);
    tip.addEventListener('focusout', event => { if (!tip.contains(event.relatedTarget)) scheduleTooltipHide(); });
    document.body.append(tip);
  }
  return tip;
}

function fill(blocks) {
  element().replaceChildren(...blocks.map(({ title, body, tone, actions }) => {
    const part = document.createElement('div');
    part.className = 'app-tooltip-block';
    if (TONES[tone]) {
      const kind = document.createElement('div');
      kind.className = 'app-tooltip-kind';
      kind.dataset.tone = tone;
      kind.innerHTML = icon(tone === 'note' ? 'info' : 'warning', 14);
      kind.append(TONES[tone]);
      part.append(kind);
    }
    const head = document.createElement('div');
    head.className = 'app-tooltip-title';
    head.textContent = title;
    part.append(head);
    if (body) {
      const text = document.createElement('div');
      text.textContent = body;
      part.append(text);
    }
    if (actions?.length) {
      const controls = document.createElement('div'); controls.className = 'app-tooltip-actions';
      for (const action of actions) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
        button.addEventListener('click', event => { event.stopPropagation(); hideTooltip(); action.fn(); });
        controls.append(button);
      }
      part.append(controls);
    }
    return part;
  }));
}

const asBlocks = (tip, tone) => typeof tip !== 'string' ? tip : tip ? [{
  title: tip.split('\n')[0], body: tip.split('\n').slice(1).join('\n'), tone }] : [];

// Show `tip` below (x, y) after the hover delay; the same tip again keeps its place.
export function showTooltip(tip, x, y, from = null, tone = null) {
  // Canvas tips also carry live objects for context menus. Only display fields
  // belong in the hover identity: synths can be circular and notes can change.
  const blocks = asBlocks(tip, tone).map(({title, body, tone, actionKey, actions}) => ({title, body, tone, actionKey, actions}));
  if (!blocks.length) { scheduleTooltipHide(); return; }
  cancelDismiss();
  owner = from;
  const text = JSON.stringify(blocks.map(({title, body, tone, actionKey, actions}) => ({
    title, body, tone, actionKey, actions: actions?.map(action => action.label),
  })));
  if (text === shownText) return;
  clearTimeout(timer);
  const wasShown = !!shownText && !element().hidden;
  shownText = text;
  const open = () => {
    timer = 0;
    interactive = blocks.some(block => block.actions?.length);
    element().toggleAttribute('data-interactive', interactive);
    element().setAttribute('role', interactive ? 'dialog' : 'tooltip');
    if (interactive) element().setAttribute('aria-label', 'Issue details');
    else element().removeAttribute('aria-label');
    fill(blocks);
    element().hidden = false;
    placeFloating(element(), x, y, 14);
  };
  if (wasShown) open();             // moving from one tip to the next: no second wait
  else timer = setTimeout(open, DELAY_MS);
}

function cancelDismiss() { clearTimeout(dismissTimer); dismissTimer = 0; }

// Leaving the symbol starts a grace period; entering the popup cancels it.
export function scheduleTooltipHide() {
  clearTimeout(timer); timer = 0;
  if (!tip || tip.hidden || !interactive) { hideTooltip(); return; }
  if (pointerInside || tip.contains(document.activeElement) || dismissTimer) return;
  dismissTimer = setTimeout(hideTooltip, DISMISS_MS);
}

export function hideTooltip() {
  clearTimeout(timer); timer = 0; cancelDismiss();
  interactive = false; pointerInside = false;
  shownText = ''; owner = null;
  if (tip) tip.hidden = true;
}

document.addEventListener('mouseover', event => {
  if (tip?.contains(event.target)) { cancelDismiss(); return; }
  const target = event.target.closest?.('[data-tip]');
  if (!target) { if (owner) scheduleTooltipHide(); return; }
  if (target === owner) { cancelDismiss(); return; }
  const rect = target.getBoundingClientRect();
  // Beside a menu row, so it does not cover the rows below; under anything else.
  const [x, y] = target.closest('.ctxmenu') ? [rect.right + 8, rect.top - 14]
    : [Math.max(rect.left, event.clientX - 12), rect.bottom - 8];
  showTooltip(target.dataset.tip, x, y, target, target.dataset.tipTone);
});
for (const type of ['mousedown', 'wheel']) window.addEventListener(type, event => {
  if (!tip?.contains(event.target)) hideTooltip();
}, true);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { hideTooltip(); return; }
  if (tip?.contains(event.target) || (interactive && event.key === 'Tab')) return;
  hideTooltip();
}, true);
window.addEventListener('blur', event => { if (event.target === window) hideTooltip(); }, true);
