// Shared musical timing for sample attacks and the hand's strike animation.
export const tremoloStep = (n, bpm = 120) => ["8", "16", "32"].includes(n?.tremPick)
  ? 240 / ((bpm || 120) * Number(n.tremPick)) : 0;

export function strumOffset(n, column, duration = n.end - n.start) {
  // Legacy projects may carry a stroke; the editor no longer interprets it.
  return 0;
}

export function hammerLink(a, b) {
  if (!a || !b || a.fx?.dead || b.fx?.dead || b.slap === "tap"
      || Math.abs(b.start - a.end) >= 0.03 || b.start <= a.start) return false;
  const from = a.fx?.hammer, to = b.fx?.hammer;
  return to === true || to === "dest" || to === "both" || from === "origin" || from === "both";
}

// Imported notes carry origin/destination roles; authored ones use the shared
// toggle. Infer H/P from the destination's pitch, as the Rocksmith exporter does.
export function hammerDirections(notes) {
  const map = new Map(), sorted = [...notes].sort((a, b) => a.start - b.start);
  let column = [], previous = [];
  for (const n of sorted) {
    if (column.length && n.start - column[0].start >= 1e-4) { previous = column; column = []; }
    const choices = previous.filter((a) => hammerLink(a, n)
      && (a.pos?.string == null || n.pos?.string == null || a.pos.string === n.pos.string));
    const origin = choices.sort((a, b) => Math.abs(a.pitch - n.pitch) - Math.abs(b.pitch - n.pitch))[0];
    if (origin) {
      const tag = n.pitch < origin.pitch ? "P" : "H";
      map.set(n, tag);
    }
    column.push(n);
  }
  return map;
}

export function strikeTime(mark, t) {
  if (mark.shapeHeld || mark.note?.gripOnly) return null;
  const start = mark.strikeStart ?? mark.start;
  if (t < start || (mark.note && t >= (mark.soundingEnd ?? mark.note.end))) return null;
  const step = mark.tremoloStep || 0;
  return step ? start + Math.floor((t - start + 1e-8) / step) * step : start;
}

export const letRingEnd = (note, nextStart = Infinity, songEnd = Infinity) =>
  Math.min(Number.isFinite(nextStart) ? nextStart : note.end + 2, songEnd);
