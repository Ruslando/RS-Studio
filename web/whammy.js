// Shared by the sample player and both visualizations. Values are semitones,
// matching the Guitar Pro export's two-semitone dip/dive presets.
import { bendAt } from "./bend.js";

export const WHAMMY_CURVES = {
  dip: [[0, 0], [0.5, -2], [1, 0]],
  dive: [[0, 0], [1, -2]],
};
export const WHAMMY_TAG = { dip: "dip ↘↗", dive: "dive ↘" };
export const whammyAt = (kind, u) => WHAMMY_CURVES[kind]
  ? bendAt(WHAMMY_CURVES[kind], Math.max(0, Math.min(1, u))) : 0;

// Less string tension reads as a smaller, lighter held finger, without moving
// its fret/string position. The style applies only during the sounding dive.
export function whammyGripStyle(note, time) {
  if (note?.whammy !== "dive" || !(note.start <= time && time < note.end))
    return { size: 1, opacity: 1 };
  const u = (time - note.start) / (note.end - note.start);
  const tensionLoss = -whammyAt(note.whammy, u) / 2;
  return { size: 1 - 0.35 * tensionLoss, opacity: 1 - 0.55 * tensionLoss };
}
