// Pick energy shown as brightness, with no added movement of the string.
// Song time keeps the decay and repeated attacks in step with slowed playback.
import { strikeTime } from "./articulations.js";

export function stringGlow(mark, t) {
  const strike = strikeTime(mark, t);
  if (strike == null) return 0;
  const n = mark.note || {}, fx = n.fx || {}, age = t - strike;
  const own = Math.max(0, (n.end ?? Infinity) - (n.start ?? mark.start));
  const duration = fx.staccato ? Math.min(0.18, own * 0.45) : own;
  const end = mark.soundingEnd ?? (n.start ?? mark.start) + duration;
  if (t >= end) return 0;
  const decay = fx.dead ? 0.025 : fx.palmMute ? 0.065 : 0.7;
  let strength = fx.ghost ? 0.35 : fx.accent ? 1.3 : 1;
  // Repeated picks need a dim resting level so the separate attack flashes
  // remain visible instead of merging into an almost constant bright string.
  if (mark.tremoloStep) strength *= 0.3;
  if (mark.slurred) strength *= 0.75;
  if (n.slap === "slap" || n.slap === "pop") strength *= 1.2;
  return Math.min(1, 0.85 * strength * Math.exp(-age / decay)
    * Math.min(1, Math.max(0, (end - t) / 0.06)));
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
