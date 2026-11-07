import assert from 'node:assert/strict';

class Element {
  children = []; style = {}; dataset = {}; attributes = {}; hidden = true; listeners = {};
  isConnected = true; offsetWidth = 180; offsetHeight = 60;
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  toggleAttribute(name, enabled) { if (enabled) this.attributes[name] = ''; else delete this.attributes[name]; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  contains(target) { return this === target || this.children.some(child => child instanceof Element && child.contains(target)); }
  fire(name, extra = {}) { for (const fn of this.listeners[name] || []) fn({target: this, stopPropagation() {}, ...extra}); }
}
const names = ['document', 'window', 'setTimeout', 'clearTimeout', 'ResizeObserver'];
const original = Object.fromEntries(names.map(name => [name, globalThis[name]]));
const pending = new Map(); let scheduled = 0, now = 0;
function advance(ms) {
  const end = now + ms;
  while (true) {
    const next = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    const [id, timer] = next; pending.delete(id); now = timer.at; timer.fn();
  }
  now = end;
}
try {
  globalThis.document = Object.assign(new Element(), {body: new Element(), createElement: () => new Element(), activeElement: null});
  globalThis.window = Object.assign(new Element(), {innerWidth: 1000, innerHeight: 800});
  globalThis.ResizeObserver = class {observe() {} unobserve() {}};
  globalThis.setTimeout = (fn, ms) => {pending.set(++scheduled, {fn, at: now + ms}); return scheduled;};
  globalThis.clearTimeout = id => pending.delete(id);
  const {showTooltip, hideTooltip, scheduleTooltipHide} = await import('../../web/tooltip.js');
  const lane = {notes: []}; lane._synth = {lane};
  for (const [tone, label] of [['warning', 'Warning'], ['error', 'Error'], ['note', 'Note']]) {
    hideTooltip();
    const diagnostic = {lane, issue: {id: `test.${tone}`}};
    const tip = {title: `A ${tone}`, body: 'Explanation', tone, diagnostic};
    assert.doesNotThrow(() => showTooltip([tip], 10, 20), 'live diagnostic objects must not break hover');
    const before = scheduled;
    lane.notes.push({id: tone});
    showTooltip([{...tip, ignored: false}], 11, 21);
    assert.equal(scheduled, before, 'metadata changes must not restart the hover delay');
    assert.equal(pending.size, 1); advance(400);
    const tooltip = document.body.children[0];
    assert.equal(tooltip.hidden, false);
    const block = tooltip.children[0];
    assert.equal(block.children[0].children[0], label, 'severity label is shown');
    assert.equal(block.children[1].textContent, `A ${tone}`);
    assert.equal(block.children[2].textContent, 'Explanation');
  }
  hideTooltip();
  const tooltip = document.body.children[0];
  assert.equal(tooltip.hidden, true);
  showTooltip('Title\nDetails', 10, 20, null, 'warning'); advance(400);
  assert.equal(tooltip.children[0].children[1].textContent, 'Title', 'DOM tooltip text still works');
  showTooltip([], 10, 20);
  assert.equal(tooltip.hidden, true, 'ordinary tooltips still dismiss normally');

  let ignoredInstance = 0, ignoredCategory = 0;
  const interactive = {
    title: 'Ghost note is not scored', body: 'Explanation', tone: 'warning', actionKey: 'instance-1',
    diagnostic: {lane}, actions: [
      {label: 'Ignore instance', fn: () => ignoredInstance++},
      {label: 'Ignore category', fn: () => ignoredCategory++},
    ],
  };
  const reveal = block => {hideTooltip(); showTooltip([block], 10, 20); advance(400);};
  reveal(interactive);
  assert.equal(tooltip.attributes.role, 'dialog');
  assert.ok('data-interactive' in tooltip.attributes, 'popup accepts pointer interactions');
  assert.deepEqual(tooltip.children[0].children.at(-1).children.map(button => button.textContent), ['Ignore instance', 'Ignore category']);
  showTooltip([], 20, 30); advance(299);
  assert.equal(tooltip.hidden, false, 'grace period lets the pointer cross the gap');
  tooltip.fire('mouseenter'); advance(1200);
  assert.equal(tooltip.hidden, false, 'hovering the popup keeps it alive');
  const buttons = tooltip.children[0].children.at(-1).children;
  document.fire('mouseover', {target: buttons[0]});
  window.fire('mousedown', {target: buttons[0]});
  assert.equal(tooltip.hidden, false, 'capture mousedown must not swallow the action');
  buttons[0].fire('click');
  assert.equal(ignoredInstance, 1); assert.equal(ignoredCategory, 0);
  assert.equal(tooltip.hidden, true);

  reveal(interactive); tooltip.fire('mouseenter'); tooltip.fire('mouseleave');
  advance(299); assert.equal(tooltip.hidden, false);
  advance(1); assert.equal(tooltip.hidden, true, 'leaving popup dismisses after the grace period');
  reveal(interactive); scheduleTooltipHide();
  const category = tooltip.children[0].children.at(-1).children[1];
  document.activeElement = category; tooltip.fire('focusin'); advance(1200);
  assert.equal(tooltip.hidden, false, 'keyboard focus also keeps the popup alive');
  window.fire('keydown', {target: category, key: 'Enter'});
  window.fire('blur', {target: category});
  assert.equal(tooltip.hidden, false, 'internal key and focus events do not dismiss controls');
  category.fire('click'); assert.equal(ignoredCategory, 1);
  document.activeElement = null;

  reveal(interactive); window.fire('keydown', {key: 'Escape'});
  assert.equal(tooltip.hidden, true, 'Escape closes popup');
  reveal(interactive); window.fire('mousedown', {target: new Element()});
  assert.equal(tooltip.hidden, true, 'outside click closes popup'); advance(1000);
  assert.equal(tooltip.hidden, true, 'canceled timers do not reopen it');

  reveal(interactive); scheduleTooltipHide();
  let other = 0;
  showTooltip([{...interactive, actionKey: 'instance-2', actions: [{label: 'Ignore instance', fn: () => other++}]}], 30, 40);
  tooltip.children[0].children.at(-1).children[0].fire('click');
  assert.equal(other, 1, 'identical text on another instance targets the new source');
  assert.equal(ignoredInstance, 1);

  reveal(interactive);
  const focused = tooltip.children[0].children.at(-1).children[0];
  document.activeElement = focused; tooltip.fire('focusin');
  document.activeElement = null; tooltip.fire('focusout', {relatedTarget: new Element()});
  advance(300); assert.equal(tooltip.hidden, true, 'leaving keyboard focus starts dismissal');
  hideTooltip(); showTooltip([interactive], 10, 20); showTooltip([], 12, 22); advance(1200);
  assert.equal(tooltip.hidden, true, 'leaving before the initial delay cancels opening');

  reveal(interactive); scheduleTooltipHide(); advance(200);
  showTooltip([interactive], 12, 22); advance(500);
  assert.equal(tooltip.hidden, false, 'returning to the symbol cancels pending dismissal');
  window.fire('wheel', {target: tooltip.children[0]});
  assert.equal(tooltip.hidden, false, 'scrolling a tall tooltip preserves it');
  window.fire('blur');
  assert.equal(tooltip.hidden, true, 'window blur dismisses it');
} finally {
  for (const name of names) {
    if (original[name] === undefined) delete globalThis[name]; else globalThis[name] = original[name];
  }
}
console.log('Tooltip severities, actions, grace period, hover, focus, dismissal and target identity passed');
