// Pick energy shown as brightness, with no added movement of the string.
// Song time keeps the decay and repeated attacks in step with slowed playback.
import { strikeTime } from "./articulations.js";

export function stringGlow(mark, t) {
  const n = mark.note || {}, fx = n.fx || {};
  const start = n.start ?? mark.start;
  const end = mark.soundingEnd ?? (fx.staccato ? Math.min(n.end ?? Infinity, start + 0.18) : n.end ?? Infinity);
  // Sustain decays in seconds since the pick. Release starts at the note's end,
  // rather than shortening the attack envelope for short notes.
  const releaseSeconds = 0.18;
  if (t >= end + releaseSeconds) return 0;
  const strike = strikeTime(mark, Math.min(t, end - 1e-8));
  if (strike == null || t < strike) return 0;
  const age = t - strike;
  const u = Math.max(0, (t - end) / releaseSeconds);
  const release = 1 - u * u * (3 - 2 * u);
  const decay = fx.dead ? 0.025 : fx.palmMute ? 0.065 : 0.7;
  let strength = fx.ghost ? 0.35 : fx.accent ? 1.3 : 1;
  // Repeated picks need a dim resting level so the separate attack flashes
  // remain visible instead of merging into an almost constant bright string.
  if (mark.tremoloStep) strength *= 0.3;
  if (mark.slurred) strength *= 0.75;
  if (n.slap === "slap" || n.slap === "pop") strength *= 1.2;
  return Math.min(1, 0.85 * strength * Math.exp(-age / decay)
    * release);
}

export function stringAttackPulse(mark, t) {
  if (mark.slurred && !mark.tremoloStep) return 0;
  const strike = strikeTime(mark, t);
  if (strike == null) return 0;
  const fx = mark.note?.fx || {};
  const window = Math.min(fx.dead ? 0.04 : 0.1, mark.tremoloStep ? mark.tremoloStep * 0.65 : 0.1);
  const age = t - strike;
  if (age >= window) return 0;
  const strength = fx.ghost ? 0.35 : fx.accent ? 1.2 : 1;
  return Math.min(1, strength * (1 - age / window) ** 2);
}
