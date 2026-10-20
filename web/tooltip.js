// The app's tooltip (design 4.19). Any element with `data-tip` gets it on hover;
// a canvas, whose marks are not elements, calls showTooltip with the pointer.
// The text is blocks split by a blank line; each block's first line is its title.
import { placeFloating } from './floating-position.js';

const DELAY_MS = 400;
let tip = null, timer = 0, shownText = '', owner = null;

function element() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip app-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function fill(text) {
  const box = element();
  box.replaceChildren(...text.split('\n\n').map(block => {
    const [title, ...rest] = block.split('\n');
    const part = document.createElement('div');
    part.className = 'app-tooltip-block';
    const head = document.createElement('div');
    head.className = 'app-tooltip-title';
    head.textContent = title;
    part.append(head);
    if (rest.length) {
      const body = document.createElement('div');
      body.textContent = rest.join('\n');
      part.append(body);
    }
    return part;
  }));
}

// Show `text` below (x, y) after the hover delay; the same text again keeps its place.
export function showTooltip(text, x, y, from = null) {
  if (!text) { hideTooltip(); return; }
  owner = from;
  if (text === shownText) return;
  clearTimeout(timer);
  const wasShown = !!shownText && !element().hidden;
  shownText = text;
  const open = () => {
    fill(text);
    element().hidden = false;
    placeFloating(element(), x, y, 14);
  };
  if (wasShown) open();             // moving from one tip to the next: no second wait
  else timer = setTimeout(open, DELAY_MS);
}

export function hideTooltip() {
  clearTimeout(timer);
  shownText = ''; owner = null;
  if (tip) tip.hidden = true;
}

document.addEventListener('mouseover', event => {
  const target = event.target.closest?.('[data-tip]');
  if (!target) { if (owner) hideTooltip(); return; }
  if (target === owner) return;
  const rect = target.getBoundingClientRect();
  showTooltip(target.dataset.tip, Math.max(rect.left, event.clientX - 12), rect.bottom - 8, target);
});
for (const type of ['mousedown', 'wheel', 'keydown', 'blur']) window.addEventListener(type, hideTooltip, true);
