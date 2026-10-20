// The app's tooltip (design 4.19). Any element with `data-tip` gets it on hover
// (`data-tip-tone` "error" or "warning" marks it as one); a canvas, whose marks
// are not elements, calls showTooltip with the pointer. A tip is a string, its
// first line the title, or a list of blocks { title, body, tone }.
import { placeFloating } from './floating-position.js';
import { icon } from './icons.js';

const TONES = { error: 'Error', warning: 'Warning' };

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

function fill(blocks) {
  element().replaceChildren(...blocks.map(({ title, body, tone }) => {
    const part = document.createElement('div');
    part.className = 'app-tooltip-block';
    if (TONES[tone]) {
      const kind = document.createElement('div');
      kind.className = 'app-tooltip-kind';
      kind.dataset.tone = tone;
      kind.innerHTML = icon('warning', 14);
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
    return part;
  }));
}

const asBlocks = (tip, tone) => typeof tip !== 'string' ? tip : tip ? [{
  title: tip.split('\n')[0], body: tip.split('\n').slice(1).join('\n'), tone }] : [];

// Show `tip` below (x, y) after the hover delay; the same tip again keeps its place.
export function showTooltip(tip, x, y, from = null, tone = null) {
  const blocks = asBlocks(tip, tone);
  if (!blocks.length) { hideTooltip(); return; }
  owner = from;
  const text = JSON.stringify(blocks);
  if (text === shownText) return;
  clearTimeout(timer);
  const wasShown = !!shownText && !element().hidden;
  shownText = text;
  const open = () => {
    fill(blocks);
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
  showTooltip(target.dataset.tip, Math.max(rect.left, event.clientX - 12), rect.bottom - 8, target, target.dataset.tipTone);
});
for (const type of ['mousedown', 'wheel', 'keydown', 'blur']) window.addEventListener(type, hideTooltip, true);
