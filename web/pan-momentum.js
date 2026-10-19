// Estimate release velocity from the last 90 ms of actual viewport movement.
// Keeping a sample before the window lets us interpolate a consistent interval,
// independent of the mouse's event rate. A pause before release removes momentum.
const WINDOW_MS = 90;
export function createPanTracker(left, top, time) {
  const samples = [{ left, top, time }];
  return {
    sample(left, top, time) {
      const last = samples.at(-1);
      if (time <= last.time) { Object.assign(last, { left, top }); return; }
      samples.push({ left, top, time });
      while (samples.length > 2 && samples[1].time < time - WINDOW_MS) samples.shift();
    },
    velocity(time) {
      const last = samples.at(-1), start = Math.max(samples[0].time, time - WINDOW_MS);
      if (time - last.time >= WINDOW_MS || time - start < 8) return { x: 0, y: 0 };
      const index = samples.findIndex(sample => sample.time >= start);
      const after = samples[index], before = samples[Math.max(0, index - 1)];
      const part = after.time === before.time ? 0 : (start - before.time) / (after.time - before.time);
      return {
        x: (last.left - (before.left + (after.left - before.left) * part)) / (time - start),
        y: (last.top - (before.top + (after.top - before.top) * part)) / (time - start),
      };
    },
  };
}

// Exact exponential integration gives the same coast distance at every frame rate.
export function panMomentumStep(velocity, elapsed) {
  const tau = 220, decay = Math.exp(-Math.max(0, elapsed) / tau);
  return { dx: velocity.x * tau * (1 - decay), dy: velocity.y * tau * (1 - decay),
    x: velocity.x * decay, y: velocity.y * decay };
}
