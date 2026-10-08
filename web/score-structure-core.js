// Pure bar-list model: normalizing bars, extending them to cover a duration, and
// the retiming that inserting or removing one forces on everything else.
//
// Bars are stored as absolute seconds (`seconds` + `durationSeconds`), not
// beats, because the canvas, the notes and every marker are in seconds. The
// price is that changing the bar list is not a bar-list edit — it is a rewrite
// of every note and marker that sits after the seam. That arithmetic is here,
// separated from the dialog in score-structure.js so it can be tested without a
// DOM: see tests/score-structure.test.mjs.
//
// The mutating functions take plain arrays rather than reading S.state, so a
// test can hand them three notes instead of a project.

import { MAX_BARS_SCANNED } from "./constants.js";

export function normalizeScoreBars(bars, duration = 0) {
  const source = Array.isArray(bars) ? bars : [];
  return source.map((bar, index) => {
    const seconds = Math.max(0, Number(bar.seconds) || 0);
    const next = Number(source[index + 1]?.seconds);
    const end = Number.isFinite(next) ? next : Math.max(seconds, Number(duration) || seconds);
    return {
      ...bar, id: bar.id || `bar_${bar.sourceIndex ?? bar.index ?? index}`,
      sourceIndex: Number.isInteger(bar.sourceIndex) ? bar.sourceIndex : (Number.isInteger(bar.index) ? bar.index : null),
      index, seconds, durationSeconds: Math.max(0.001, Number(bar.durationSeconds) || end - seconds || 1),
      timeSignatureNumerator: Math.max(1, Number(bar.timeSignatureNumerator) || 4),
      timeSignatureDenominator: Math.max(1, Number(bar.timeSignatureDenominator) || 4),
      keySignature: Math.max(-7, Math.min(7, Number(bar.keySignature) || 0)),
      keySignatureType: Number(bar.keySignatureType) === 1 ? 1 : 0,
      isRepeatStart: !!bar.isRepeatStart, repeatCount: Math.max(0, Number(bar.repeatCount) || 0),
      alternateEndings: Math.max(0, Number(bar.alternateEndings) || 0),
      section: bar.section ? { marker: String(bar.section.marker || ""), text: String(bar.section.text || "") } : null,
    };
  });
}

export function coverScoreDuration(bars, duration) {
  const out = bars.map((bar) => ({ ...bar, section: bar.section ? { ...bar.section } : null }));
  const target = Math.max(0, Number(duration) || 0);
  while (out.length && out.at(-1).seconds + out.at(-1).durationSeconds < target - 1e-6
         && out.length < MAX_BARS_SCANNED) {
    const source = out.at(-1), seconds = source.seconds + source.durationSeconds;
    out.push({ ...source, id: `bar_auto_${out.length}_${Math.round(seconds * 1000)}`, sourceIndex: null,
      index: out.length, seconds, isRepeatStart: false, repeatCount: 0, alternateEndings: 0,
      section: null, tempoAutomations: [] });
  }
  return out;
}

// Open `amount` seconds of silence at `at`. Notes starting at or after the seam
// move whole; a note straddling it is stretched — its tail moves, its head does
// not — so a note held across an inserted bar stays held.
//
// `lanes` is anything with a `.notes` array; `markerLists` is a list of marker
// arrays (tempo, section, per-lane), each entry carrying a `.t` in seconds.
// Both are mutated in place, which is why the caller snapshots first.
export function shiftForInsert(lanes, markerLists, at, amount) {
  for (const lane of lanes) for (const note of lane.notes) {
    if (note.start >= at - 1e-7) { note.start += amount; note.end += amount; }
    else if (note.end > at) note.end += amount;
  }
  for (const markers of markerLists) for (const marker of markers || [])
    marker.t = insertTime(marker.t, at, amount);
}

// The single-time versions of the two rules above, for callers holding bare
// numbers instead of `{t}` objects — reference-box anchors, mainly. Same rule as
// a marker: past the seam it slides, inside a cut it collapses onto the seam.
export const insertTime = (t, at, amount) => (t >= at - 1e-7 ? t + amount : t);
export const removeTime = (t, start, end) =>
  (t >= end ? t - (end - start) : t > start ? start : t);

// Cut the window [start, end) out of the timeline. Five cases per note, in the
// order they are tested — each answers "which part of this note survives":
//
//   1. entirely before the cut  -> untouched
//   2. entirely after it        -> slides back by the full width
//   3. spans the whole cut      -> keeps both ends, loses the middle (shorter)
//   4. overlaps the cut's start -> truncated to end where the cut begins
//   5. overlaps the cut's end   -> head trimmed to the seam, then slid back
//   otherwise it lies inside the cut and is deleted.
//
// That last case is why removing a bar is destructive and why the caller must
// snapshot first. The final filter also drops anything left shorter than a
// microsecond, so a note that merely touched the seam disappears rather than
// surviving as a zero-length artefact.
//
// Markers get the same treatment in miniature, with one deliberate difference:
// past the cut they slide back, but inside it they collapse onto the seam
// instead of being deleted. A tempo or section marker with nothing left to mark
// still has to mark *something* — dropping one silently would change how the
// rest of the song is read.
export function shiftForRemoval(lanes, markerLists, start, end) {
  const amount = end - start;
  for (const lane of lanes) lane.notes = lane.notes.map((note) => {
    const copy = { ...note };
    if (copy.end <= start) return copy;
    if (copy.start >= end) { copy.start -= amount; copy.end -= amount; return copy; }
    if (copy.start < start && copy.end > end) { copy.end -= amount; return copy; }
    if (copy.start < start) { copy.end = start; return copy; }
    if (copy.end > end) { copy.start = start; copy.end -= amount; return copy; }
    return null;
  }).filter((note) => note && note.end > note.start + 1e-6);
  for (const markers of markerLists) for (const marker of markers || [])
    marker.t = removeTime(marker.t, start, end);
}
