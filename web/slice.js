// Splitting a sustained editor note into two attacks. Kept DOM-free so the
// musical-data rules can be tested without constructing the editor shell.

import { bendAt, bendCurve, normalizeCurve } from "./bend.js";
import { copyEffects } from "./note-effects.js";

const ATTACK_ONLY_FIELDS = ["slide", "grace", "trill", "tremPick", "slap", "stroke", "whammy"];

// X coordinate where a freehand cut segment crosses a note's pitch-row centre.
// The caller snaps this *time* afterward; y deliberately remains continuous.
export function lineXAtRow(line, rowCenter, rowHeight) {
  const dy = line.y1 - line.y0;
  if (Math.abs(dy) < 0.5)
    return Math.abs(rowCenter - line.y0) <= rowHeight / 2 ? (line.x0 + line.x1) / 2 : null;
  // A line that only clips the top/bottom of a note still counts. Use its row
  // centre when available, otherwise the nearest actual crossing point.
  const lo = Math.max(Math.min(line.y0, line.y1), rowCenter - rowHeight / 2);
  const hi = Math.min(Math.max(line.y0, line.y1), rowCenter + rowHeight / 2);
  if (lo > hi) return null;
  const y = Math.max(lo, Math.min(rowCenter, hi));
  const fraction = (y - line.y0) / dy;
  return line.x0 + (line.x1 - line.x0) * fraction;
}

// Re-express a bend curve over one half of a split note. The new right-hand
// segment begins at the audible bend pitch at the cut, rather than snapping
// back to the unbent fret pitch.
function curveSegment(points, from, to) {
  const span = to - from;
  const out = [[0, bendAt(points, from)]];
  for (const [t, value] of points) if (t > from && t < to)
    out.push([(t - from) / span, value]);
  out.push([1, bendAt(points, to)]);
  return normalizeCurve(out);
}

// Return independent note objects for the left and right attacks, or null if
// `at` is not strictly inside the note with room for both resulting durations.
// `newId` is injected so callers own their id allocation policy.
export function splitNote(note, at, minDuration, newId) {
  // Both edges and the cut are grid multiples computed independently, so an
  // exactly-one-cell half lands ~1e-16 either side of minDuration. Without the
  // tolerance the same cut succeeds or fails depending on the float dust.
  const floor = minDuration - 1e-6;
  if (!note || !Number.isFinite(at) || at - note.start < floor || note.end - at < floor)
    return null;

  const left = copyEffects(note, { ...note, end: at });
  const right = copyEffects(note, { ...note, id: newId(), start: at });

  // These are attacks/beat effects. Repeating them would invent a second slide,
  // grace note, or strum; the freshly sliced attack deliberately starts clean.
  for (const field of ATTACK_ONLY_FIELDS) delete right[field];

  // Drop legacy grip metadata. Pure motif labels remain on both halves.
  delete left.shapeId; delete left.shapeSource;
  delete right.shapeId; delete right.shapeSource;

  // A late slide start stays at its moment in time. Cut before it, the slide
  // moves to the right half, which is the part that still leads into the target.
  const slideAt = note.slideStart != null ? note.start + note.slideStart * (note.end - note.start) : null;
  delete left.slideStart; delete right.slideStart;
  if (slideAt != null && at <= slideAt) {
    right.slide = note.slide; delete left.slide;
    if (slideAt - at > 1e-9) right.slideStart = (slideAt - at) / (note.end - at);
  } else if (slideAt != null) left.slideStart = (slideAt - note.start) / (at - note.start);
  // Where a slide-in lands stays at its moment too, within the left half.
  if (note.slideEnd != null) left.slideEnd = Math.min(0.95, note.slideEnd * (note.end - note.start) / (at - note.start));
  for (const half of [left, right]) if (!half.slide) { delete half.slideEnd; delete half.slideFrets; }

  // Late vibrato likewise: cut before it, the left half is plain.
  const vibratoAt = note.fx?.vibrato && note.vibratoStart != null
    ? note.start + note.vibratoStart * (note.end - note.start) : null;
  delete left.vibratoStart; delete right.vibratoStart;
  if (vibratoAt != null && at <= vibratoAt) {
    const fx = { ...left.fx }; delete fx.vibrato;
    if (Object.keys(fx).length) left.fx = fx; else delete left.fx;
    if (vibratoAt - at > 1e-9) right.vibratoStart = (vibratoAt - at) / (note.end - at);
  } else if (vibratoAt != null) left.vibratoStart = (vibratoAt - note.start) / (at - note.start);

  const curve = bendCurve(note);
  if (curve) {
    const fraction = (at - note.start) / (note.end - note.start);
    left.bend = "custom";
    right.bend = "custom";
    left.bendPoints = curveSegment(curve, 0, fraction);
    right.bendPoints = curveSegment(curve, fraction, 1);
  }
  return { left, right };
}
