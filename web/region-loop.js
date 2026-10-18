// Arm only after the playhead enters the range. Explicit seeks reset the latch.
export function createRegionLoop() {
  let key = "", armed = false, previousTime = null;
  return {
    reset() { key = ""; armed = false; previousTime = null; },
    update(time, region) {
      const valid = region && Number.isFinite(region.t0) && Number.isFinite(region.t1) && region.t1 > region.t0;
      const nextKey = valid ? `${region.t0}:${region.t1}` : "";
      if (key !== nextKey) { key = nextKey; armed = false; previousTime = null; }
      if (!valid || !Number.isFinite(time)) return null;
      if (time >= region.t0 && time < region.t1) armed = true;
      // A delayed background tick can cross the entire range. Explicit seeks
      // reset previousTime, so seeking past the range never arms it.
      if (previousTime !== null && previousTime < region.t0 && time >= region.t1) armed = true;
      previousTime = time;
      // Restart at the boundary itself: carrying tick overshoot into the next
      // pass skips attacks written exactly at the loop start.
      if (armed && time >= region.t1) return region.t0;
      return null;
    },
    end(region) {
      // Clip lookahead even before entry: a short loop can fit entirely inside
      // one scheduling window, including notes outside it that must not fire.
      return region && key === `${region.t0}:${region.t1}` && (armed || previousTime !== null && previousTime < region.t1)
        ? region.t1 : Infinity;
    },
  };
}
