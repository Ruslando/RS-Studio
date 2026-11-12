// Clipboard capture and beat-relative placement, shared by editor and tracing.
import { laneOf } from "./lane-state.js";
import { laneClock } from "./reference-clock.js";
import { noteHandAnchors } from "./clipboard-fingering.js";
import { laneFingeringNow } from "./lane-fingering.js";
import { copyEffects } from "./note-effects.js";
import { snap } from "./grid-read.js";

// A clipboard entry remembers where its note sits in beats on its own layer's
// grid, so a paste under another tempo keeps the rhythm, not the seconds.
export function clipOf(notes) {
  const clocks = new Map(), hands = new Map(), fingerings = new Map();
  return notes.map((n) => {
    const lane = laneOf(n);
    if (lane && !clocks.has(lane)) clocks.set(lane, laneClock(lane));
    if (lane && !hands.has(lane)) hands.set(lane, noteHandAnchors(lane.notes, lane.handHolds));
    if (lane && !fingerings.has(lane)) {
      const found = laneFingeringNow(lane);
      fingerings.set(lane, { found, byId: new Map(found.notes.map(note => [note.id, note])) });
    }
    const clock = lane && clocks.get(lane);
    const fingering = fingerings.get(lane), played = fingering?.byId.get(n.id) || n;
    const finger = n.finger ?? fingering?.found.fingers.get(played);
    const anchor = fingering?.found.seats.get(played) ?? hands.get(lane)?.get(n);
    const copied = copyEffects(n, {
      start: n.start, end: n.end, pitch: n.pitch,
      ...(Number.isInteger(finger) && finger >= 0 ? { finger } : {}),
      ...(Number.isFinite(anchor) && anchor > 0 ? { handAnchor: anchor } : {}),
      ...(clock ? { beat0: clock.beatAt(n.start), beat1: clock.beatAt(n.end) } : {}),
      ...(n.motifId ? { motifId: n.motifId } : {}),
      ...(n.shapeId ? { shapeId: n.shapeId, shapeKind: n.shapeKind, ...(n.shapeName ? { shapeName: n.shapeName } : {}) } : {}),
    });
    const position = fingering?.found.voiced.get(played);
    if (position) copied.pos = { ...copied.pos, ...position };
    return copied;
  });
}

// Where a clip lands when its first note goes to time `at` on `lane`: each note
// at its beat distance from the first, on that layer's grid. Only the landing
// point snaps; the notes keep their rhythm exactly. Snapping each note to the
// visible grid moved notes off it whenever the view was zoomed out past the
// copy's finest note. One still off the grid is pulled on at commit (snapStrayNotes).
export function placeClip(clip, lane, at) {
  const clock = laneClock(lane);
  const beats = clip.every((c) => Number.isFinite(c.beat0));
  const first = beats ? Math.min(...clip.map((c) => c.beat0)) : Math.min(...clip.map((c) => c.start));
  const target = snap(Math.max(0, at));
  const b = clock.beatAt(target);
  return clip.map((c) => {
    const start = beats ? clock.timeAt(b + c.beat0 - first) : target + c.start - first;
    const end = beats ? clock.timeAt(b + c.beat1 - first) : target + c.end - first;
    return { start, end };
  });
}

