import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const scroll = Object.assign(new EventTarget(), {
  scrollLeft: 100, scrollTop: 100, scrollWidth: 2000, scrollHeight: 1200,
  clientWidth: 500, clientHeight: 400,
});
const win = new EventTarget();
const saved = Object.fromEntries(['window','performance','requestAnimationFrame','cancelAnimationFrame','CustomEvent'].map(key => [key,globalThis[key]]));
let now = 0, next = 0, reduced = false;
const callbacks = new Map();
const advance = elapsed => {
  now += elapsed;
  const pending = [...callbacks.values()]; callbacks.clear();
  for (const callback of pending) callback(now);
};
try {
  Object.assign(globalThis, { window: win, performance: { now: () => now },
    requestAnimationFrame: callback => { callbacks.set(++next,callback); return next; },
    cancelAnimationFrame: id => callbacks.delete(id), CustomEvent: class extends Event {},
  });
  const motion = await mockImport(new URL('../../web/viewport-motion.js', import.meta.url), {
    './dom.js': { scroll }, './repaint.js': { draw() {} },
    './panel-motion.js': { motionTiming: () => ({ duration: reduced ? 0 : 200, ease: t => t }) },
  }, { './pan-momentum.js': true });
  motion.coastViewport({ x: 1, y: .5 }); advance(16);
  assert.ok(scroll.scrollLeft > 100 && scroll.scrollTop > 100, 'both axes coast after release');
  win.dispatchEvent(new Event('pointerdown'));
  const stopped = scroll.scrollLeft; advance(100);
  assert.equal(scroll.scrollLeft, stopped, 'new click cancels the coast');
  assert.equal(motion.viewportMoving(), false);

  scroll.scrollLeft = 1499; scroll.scrollTop = 100;
  motion.coastViewport({ x: 1, y: 1 }); advance(16);
  assert.equal(scroll.scrollLeft, 1500, 'horizontal boundary clamps without overshoot');
  const top = scroll.scrollTop; advance(16);
  assert.ok(scroll.scrollTop > top, 'vertical momentum survives hitting the horizontal boundary');
  win.dispatchEvent(new Event('keydown'));
  assert.equal(motion.viewportMoving(), false);

  scroll.scrollLeft = 500; scroll.scrollTop = 100;
  motion.coastViewport({ x: -1, y: 0 });
  for (let i = 0; i < 100; i++) advance(16);
  assert.equal(motion.viewportMoving(), false, 'friction settles naturally');
  assert.ok(scroll.scrollLeft < 500 && scroll.scrollLeft > 250);
  reduced = true; motion.coastViewport({ x: 1, y: 0 });
  assert.equal(motion.viewportMoving(), false, 'reduced motion disables inertia');
  reduced = false; motion.coastViewport({ x: 1, y: 0 });
  win.dispatchEvent(new Event('cw-project-closed'));
  assert.equal(motion.viewportMoving(), false, 'closing a project cancels inertia');
} finally { Object.assign(globalThis, saved); }
console.log('Viewport inertia: interruption, bounds, settling and reduced motion: OK');
