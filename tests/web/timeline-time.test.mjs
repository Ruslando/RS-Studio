import assert from 'node:assert/strict';
import { createOverviewTime, formatTimelineTime, parseTimelineTime } from '../../web/timeline-time.js';

assert.equal(formatTimelineTime(0), '00:00');
assert.equal(formatTimelineTime(65.987), '01:05');
assert.equal(formatTimelineTime(3599.999), '59:59');
assert.equal(formatTimelineTime(3600), '1:00:00');
assert.equal(formatTimelineTime(3723.456, true), '1:02:03.456');
assert.equal(formatTimelineTime(Infinity), '00:00');
assert.equal(parseTimelineTime('01:05'), 65);
assert.equal(parseTimelineTime('1:02:03.456'), 3723.456);
assert.equal(parseTimelineTime(' 00:01.5 '), 1.5);
// Before 0 lies the leading silence, with a minus sign both ways.
assert.equal(formatTimelineTime(-1.6474, true), '-00:01.647');
assert.equal(formatTimelineTime(-0.0004, true), '00:00.000');
assert.equal(parseTimelineTime('-01:00'), -60);
for (const invalid of ['', '65', '--01:00', '00:60', '60:00', '1:60:00', '1:00:60', '00:01.1234', 'hello'])
  assert.equal(parseTimelineTime(invalid), null, invalid);

class Element {
  listeners = new Map(); hidden = false; style = {}; value = ''; validity = ''; attrs = {};
  addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
  emit(type, props = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ preventDefault() {}, stopPropagation() {}, ...props });
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  setCustomValidity(value) { this.validity = value; }
  reportValidity() { this.reported = true; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  blur() { this.focused = false; this.emit('blur'); }
}
const root = new Element(), button = new Element(), input = new Element();
input.hidden = true;
Object.defineProperty(root, 'offsetWidth', { get: () => input.hidden ? 60 : 140 });
let project = {}, time = 65.25;
const seeks = [];
const control = createOverviewTime({ root, button, input, getProject: () => project, getTime: () => time,
  onSeek: value => { time = value; seeks.push(value); } });
control.sync(time, 4000, 500);
assert.equal(button.textContent, '01:05.250', 'milliseconds are visible without scrubbing');
button.emit('dblclick');
assert.equal(input.value, '01:05.250');
assert.ok(input.focused && input.selected);
input.value = '1:02:03.456';
control.sync(66, 4000, 500);
assert.equal(input.value, '1:02:03.456', 'playback does not overwrite typed text');
input.emit('keydown', { key: 'Enter' });
assert.deepEqual(seeks, [3723.456]);
assert.equal(button.textContent, '1:02:03.456');
assert.ok(input.hidden && !button.hidden);
button.emit('dblclick'); input.value = '99:00:00';
input.emit('keydown', { key: 'Enter' });
assert.ok(input.validity && input.reported, 'out-of-range times show validation instead of seeking');
input.emit('keydown', { key: 'Escape' });
assert.equal(seeks.length, 1);
assert.ok(input.hidden);
button.emit('dblclick'); input.value = '00:30'; input.emit('blur');
assert.equal(time, 30, 'a valid edit commits on blur');
button.emit('dblclick'); input.value = 'bad'; input.emit('blur');
assert.ok(input.hidden, 'invalid text does not trap focus after clicking elsewhere');
control.sync(3999, 4000, 500);
button.emit('dblclick');
assert.ok(parseFloat(root.style.left) + root.offsetWidth <= 500, 'editor remains visible at the right edge');
input.value = '00:40'; project = {};
control.sync(0, 100, 500);
assert.ok(input.hidden, 'changing projects cancels the previous editor');
assert.equal(time, 30);
control.sync(0, 0, 0);
assert.ok(root.hidden, 'no project hides the readout');
console.log('overview time: formatting, persistent label, inline editing, validation and project changes passed');
