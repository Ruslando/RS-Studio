// Pure helpers for marker-clipboard.js.

// The copied flags with the earliest one at `at`, the rest at their distance from it.
export function landMarkers(clip, at) {
  const first = Math.min(...clip.map((c) => c.t));
  return clip.map((c) => ({ ...c, t: at + c.t - first }));
}

// The flags from time a to time b, both included, in either order.
export function markerRange(flags, a, b) {
  const lo = Math.min(a, b) - 1e-6, hi = Math.max(a, b) + 1e-6;
  return flags.filter((f) => f.t >= lo && f.t <= hi);
}
