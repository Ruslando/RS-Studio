// Shared by the sample player and both visualizations. Values are semitones,
// matching the Guitar Pro export's two-semitone dip/dive presets.
import { bendAt, bendCurve } from "./bend.js";

export const WHAMMY_CURVES = {
  dip: [[0, 0], [0.5, -2], [1, 0]],
  dive: [[0, 0], [1, -2]],
};
// An imported whammy keeps its own curve (`whammyPoints`, [t, semitones] like
// bendPoints); `whammy` then names its shape. A preset has no points.
export const whammyCurve = (n) => !n?.whammy ? null
  : n.whammyPoints?.length >= 2 ? n.whammyPoints : WHAMMY_CURVES[n.whammy] || null;
export const whammyAt = (n, u) => {
  const curve = whammyCurve(n);
  return curve ? bendAt(curve, Math.max(0, Math.min(1, u))) : 0;
};
// Where the note's pitch goes, bend and whammy together, as one [t, semitones]
// curve: what the stage draws the note along and puts the handles on. null for a
// note whose pitch stays put.
export function pitchCurve(n) {
  const bend = bendCurve(n), whammy = whammyCurve(n);
  if (!bend || !whammy) return bend || whammy;
  return [...new Set([...bend, ...whammy].map(([t]) => t))].sort((a, b) => a - b)
    .map((t) => [t, bendAt(bend, t) + bendAt(whammy, t)]);
}

// The preset a curve looks like, else "custom"; null for a flat one.
export function whammyKind(points) {
  if (!points?.length || points.every(([, v]) => Math.abs(v) < 1e-6)) return null;
  const first = points[0][1], last = points.at(-1)[1], low = Math.min(...points.map(([, v]) => v));
  if (Math.abs(first) < 1e-6 && Math.abs(last) < 1e-6 && low < 0) return "dip";
  if (Math.abs(first) < 1e-6 && last < 0 && last <= low + 1e-6) return "dive";
  return "custom";
}

// Less string tension reads as a smaller, lighter held finger, without moving
// its fret/string position. The style applies only while the whammy note is sounding.
export function whammyGripStyle(note, time) {
  if (!whammyCurve(note) || !(note.start <= time && time < note.end))
    return { size: 1, opacity: 1 };
  const u = (time - note.start) / (note.end - note.start);
  const tensionLoss = -whammyAt(note, u) / 2;
  return { size: 1 - 0.35 * tensionLoss, opacity: 1 - 0.55 * tensionLoss };
}
