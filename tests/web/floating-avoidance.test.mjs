import assert from 'node:assert/strict';
import { avoidingBounds, placeFloatingAvoiding } from '../../web/floating-position.js';
const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const rectangle = (point, width, height) => ({ ...point, right: point.left + width, bottom: point.top + height });
for (const notes of [
  [{ left: 190, right: 360, top: 180, bottom: 205 }, { left: 190, right: 370, top: 260, bottom: 300 }],
  [{ left: 700, right: 890, top: 360, bottom: 395 }, { left: 700, right: 920, top: 420, bottom: 490 }],
  [{ left: 15, right: 185, top: 20, bottom: 45 }, { left: 15, right: 200, top: 70, bottom: 135 }],
  // Long notes rule out the horizontal sides; placement must use vertical space.
  [{ left: 20, right: 980, top: 220, bottom: 270 }, { left: 20, right: 980, top: 310, bottom: 365 }],
]) {
  const point = avoidingBounds(notes, 280, 180, 1000, 700, { left: 0, right: 1000, top: 0, bottom: 600 });
  const panel = rectangle(point, 280, 180);
  assert.ok(notes.every(note => area(panel, note) === 0), 'both preview versions remain uncovered');
  assert.ok(panel.left >= 8 && panel.top >= 8 && panel.right <= 992 && panel.bottom <= 692);
}
const notes = [{ left: 300, right: 480, top: 200, bottom: 270 }];
const first = avoidingBounds(notes, 280, 180, 1000, 700);
assert.deepEqual(avoidingBounds(notes, 280, 120, 1000, 700, null, first), first, 'a shrinking change list keeps its position');
const occupied = rectangle(first, 280, 180);
const moved = avoidingBounds([occupied], 280, 180, 1000, 700, null, first);
assert.equal(area(rectangle(moved, 280, 180), occupied), 0, 'a stale position is replaced when it would cover a new preview');

const saved = { window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
try {
  globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 700 });
  let resize;
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} };
  const panel = { isConnected: true, hidden: false, offsetWidth: 280, offsetHeight: 180, style: {} };
  const protectedNotes = [{ left: 300, right: 480, top: 200, bottom: 270 }];
  const avoidance = () => ({ rects: protectedNotes });
  placeFloatingAvoiding(panel, avoidance, { reset: true });
  const position = { ...panel.style };
  placeFloatingAvoiding(panel, avoidance);
  assert.deepEqual(panel.style, position, 'switching previews keeps the card stable');
  panel.offsetHeight = 120; resize([{ target: panel }]);
  assert.deepEqual(panel.style, position, 'content resizing retains a safe position');
  const current = { left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) };
  protectedNotes[0] = rectangle(current, 280, 120);
  resize([{ target: panel }]);
  const next = rectangle({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) }, 280, 120);
  assert.equal(area(next, protectedNotes[0]), 0, 'live preview changes are remeasured');
  window.innerWidth = 600; window.innerHeight = 400; window.dispatchEvent(new Event('resize'));
  assert.ok(parseFloat(panel.style.left) + panel.offsetWidth <= 592);
  assert.ok(parseFloat(panel.style.top) + panel.offsetHeight <= 392);
} finally { Object.assign(globalThis, saved); }
console.log('Floating comparison cards avoid both previews and stay stable on updates');
