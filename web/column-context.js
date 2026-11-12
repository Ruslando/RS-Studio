// Resolve a note's onset column without loading the editor command controller.
import { laneOf } from "./lane-state.js";
import { laneFretTuning } from "./lane-tuning.js";
import { chordColumns } from "./voicing-core.js";

// The onset-column (same grouping the engine + export use) that `note` sits in,
// with its edit lane and tuning. null for notes not in an edit lane.
export function columnOf(note) {
  const lane = laneOf(note);
  if (!lane) return null;
  const col = chordColumns(lane.notes).find((c) => c.notes.includes(note));
  return col ? { lane, tuning: laneFretTuning(lane), col } : null;
}

