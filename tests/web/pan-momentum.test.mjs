import assert from 'node:assert/strict';
import { createPanTracker, panMomentumStep } from '../../web/pan-momentum.js';

const tracker = createPanTracker(0, 0, 0);
tracker.sample(40, 20, 40); tracker.sample(80, 40, 80);
assert.deepEqual(tracker.velocity(80), { x: 1, y: .5 });
assert.deepEqual(tracker.velocity(180), { x: 0, y: 0 }, 'holding before release removes the flick');
const slow = createPanTracker(0, 0, 0);
slow.sample(20, 0, 80);
assert.ok(slow.velocity(80).x < tracker.velocity(80).x);
const reversal = createPanTracker(0, 0, 0);
reversal.sample(100, 0, 100); reversal.sample(70, 0, 130); reversal.sample(0, 0, 200);
assert.ok(reversal.velocity(200).x < 0, 'release direction follows the recent reversal');
assert.deepEqual(createPanTracker(20, 10, 0).velocity(100), { x: 0, y: 0 });

function travel(frames, elapsed) {
  let velocity = { x: 1, y: -.5 }, x = 0, y = 0;
  for (let i = 0; i < frames; i++) {
    const step = panMomentumStep(velocity, elapsed);
    x += step.dx; y += step.dy; velocity = step;
  }
  return { x, y, speed: Math.hypot(velocity.x, velocity.y) };
}
const fine = travel(20, 16), coarse = travel(10, 32);
assert.ok(Math.abs(fine.x - coarse.x) < 1e-9 && Math.abs(fine.y - coarse.y) < 1e-9, 'frame-rate independent distance');
assert.ok(fine.speed < Math.hypot(1, -.5), 'friction decreases speed');
assert.ok(travel(80, 16).x < 220, 'finite coasting distance');
console.log('Pan release velocity and exponential friction: OK');
