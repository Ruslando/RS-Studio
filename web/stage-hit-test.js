// Stage hit testing shared by rendering, hover actions and pointer gestures.
import { graceBefore } from "./grace.js";
import { pitchCurve } from "./whammy.js";
import { easedCurveAt } from "./bend.js";
import { noteRibbon } from "./note-render.js";
import { scroll, stage } from "./dom.js";
import { withMemo } from "./paint-memo.js";
import { timeAt, pitchAt, pitchAtExact } from "./geometry.js";
import { gridAt } from "./grid-read.js";
import { activeLane } from "./lanes.js";
import { boxOfNote } from "./references.js";
import { railsBottom } from "./marker-rails.js";
import { S } from "./store.js";

// A note whose pitch moves (a bend, or a slide's ribbon onto the next note) is
// drawn along that curve, several rows away from its base pitch and, for a slide,
// on past its own end. It is grabbed exactly where it is drawn: within half a row
// of the curve, as the stage eases it (bend.js easedCurveAt). `exact` is the
// unrounded pitch under the pointer; a plain note only needs its row.
function noteAt(lane, t, pitch, exact = pitch) {
  if (!lane) return null;
  for (let i = lane.notes.length - 1; i >= 0; i--) {
    const n = lane.notes[i];
    const ribbon = noteRibbon(lane, n);
    const curve = pitchCurve(n) || ribbon?.points;
    const end = !pitchCurve(n) && ribbon ? ribbon.end : n.end;
    if (t < n.start || t > end) continue;
    if (!curve) { if (n.pitch === pitch) return n; continue; }
    const at = n.pitch + easedCurveAt(curve, (t - n.start) / Math.max(1e-6, end - n.start));
    if (Math.abs(exact - at) <= 0.5) return n;
  }
  return null;
}

export const pickNote = (t, pitch, exact = pitch) => withMemo(() => pickNoteNow(t, pitch, exact));

function pickNoteNow(t, pitch, exact) {
  const order = [activeLane(), ...S.state.lanes.filter((l) => l !== activeLane())];
  for (const lane of order) {
    // Locked or hidden lanes are display-only — never hit-test them, so their
    // notes can't be grabbed, moved, or selected.
    if (!lane || !lane.visible || lane.locked) continue;
    const n = noteAt(lane, t, pitch, exact);
    if (n) return { lane, note: n };
    // A derived grace bar grabs its parent. It is never an independent note,
    // and cannot acquire its own resize handles or separate pitch/timing.
    for (let i = lane.notes.length - 1; i >= 0; i--) {
      const note = lane.notes[i], grace = graceBefore(note, gridAt(note.start)?.bpm || 120);
      if (grace && t >= grace.start && t < note.start && pitch === note.pitch + grace.offset)
        return { lane, note, grace: true };
    }
  }
  return null;
}

// World-space coords (absolute song px) from client coords — so the auto-scroll
// loop can recompute a drag from a stationary cursor as the viewport pans.
export function clientToCanvas(cx, cy) {
  // The canvas is sticky (its rect stays at the viewport's top-left and no longer
  // moves with scroll), so add scrollLeft/scrollTop to map back into world px —
  // what every caller (timeAt, pitchAt, hit-testing, trace points) expects.
  const r = stage.getBoundingClientRect();
  return [cx - r.left + scroll.scrollLeft, cy - r.top + scroll.scrollTop];
}

export function localXY(e) {
  return clientToCanvas(e.clientX, e.clientY);
}

// Re-hit-test in the current viewport. A stationary pointer can cover another
// note after scrolling, zooming or playback following, without a mousemove.
export function hoveredStageNote() {
  if (!S.state || S.drag || S.mouseX == null || stage.closest('[hidden], [inert]') ||
      document.elementFromPoint(S.lastPointerX, S.lastPointerY) !== stage) return null;
  const [x, y] = clientToCanvas(S.lastPointerX, S.lastPointerY);
  if (y - scroll.scrollTop <= railsBottom()) return null;
  const hit = pickNote(timeAt(x), pitchAt(y), pitchAtExact(y));
  return hit && !boxOfNote(hit.note)?.group.locked ? hit.note : null;
}

