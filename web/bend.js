// Bend curves. A bend is a list of [t, semi] control points: t = 0..1 across the
// note's duration, semi = semitones above the fretted pitch. Guitar Pro's own
// bend editor is a 12-column x quarter-tone grid and .gp5 stores exactly that, so
// snapping to SNAP_T/SNAP_SEMI keeps the round-trip lossless; targets that store
// float times and arbitrary values lose nothing either way, so free (Alt)
// dragging only costs .gp5 precision. DOM-free so the math stays testable.

export const SNAP_T = 1 / 12;
export const SNAP_SEMI = 0.5;        // a quarter tone — the finest unit either format has
export const MAX_SEMI = 6;           // BendPoint.MaxValue is 12 quarter-tones in GP and alphaTab
export const MAX_POINTS = 32;        // the tightest per-note cap any export target imposes

// Preset id -> canonical curve. A preset is only a starting shape: the points are
// *derived*, so a project that stores just `bend: "full"` needs no migration and
// only a dragged curve costs the extra bytes.
export const BEND_PRESETS = {
  quarter: [[0, 0], [0.5, 0.5], [1, 0.5]],
  half: [[0, 0], [0.5, 1], [1, 1]],
  full: [[0, 0], [0.5, 2], [1, 2]],
  onehalf: [[0, 0], [0.5, 3], [1, 3]],
  twostep: [[0, 0], [0.5, 4], [1, 4]],
  release: [[0, 0], [0.5, 2], [1, 0]],
  prebend: [[0, 2], [1, 2]],
  prebendRelease: [[0, 2], [0.5, 2], [1, 0]],
  bendReleaseBend: [[0, 0], [1 / 3, 2], [2 / 3, 0], [1, 2]],
};

export const BEND_TAG = {
  quarter: "¼", half: "½", full: "full", onehalf: "1½", twostep: "2",
  release: "b·r", prebend: "pre", prebendRelease: "pre·r", bendReleaseBend: "b·r·b",
  custom: "cust",
};

// The curve a note actually sounds: its own dragged points, else its preset's.
export function bendCurve(n) {
  if (!n || !n.bend) return null;
  if (n.bendPoints && n.bendPoints.length >= 2) return n.bendPoints;
  return BEND_PRESETS[n.bend] || BEND_PRESETS.full;
}

// Vibrato, as a guitarist plays it: small bends pushed and let go a few times a
// second, so the pitch only ever goes UP from the fret and comes back to it. It
// swells in over its first moment rather than starting at full width.
export const VIBRATO = { hz: 5.5, semi: 0.4, swell: 0.15 };
export const vibratoAt = (sec) => sec <= 0 ? 0
  : VIBRATO.semi * (1 - Math.cos(2 * Math.PI * VIBRATO.hz * sec)) / 2 * Math.min(1, sec / VIBRATO.swell);

// How far the string is PUSHED (sideways): the bend curve at fraction u of the
// note plus the vibrato `sec` seconds after its onset. One answer for the
// fretboard's finger and the playback's pitch, so the two agree.
export function pitchOffsetAt(n, u, sec) {
  const pts = bendCurve(n);
  return (pts ? bendAt(pts, u) : 0) + (n?.fx?.vibrato ? vibratoAt(sec) : 0);
}

// Trills alternate with the upper fret at a sixteenth-note rate. Sharing the
// phase keeps the tapping finger exactly in step with sample pitch playback.
export const trillInterval = (kind) => kind === "whole" ? 2 : kind === "half" ? 1 : 0;
export const trillOffsetAt = (n, sec, bpm = 120) => sec >= 0
  && Math.floor((sec + 1e-8) / (15 / (bpm || 120))) % 2 ? trillInterval(n?.trill) : 0;

// ---- slides ----
// A slide moves the fretting finger ALONG the string, so its pitch moves a fret —
// a semitone — at a time: `slideAt` is rounded to whole semitones, the steps a real
// slide clicks through.
//
// Onto the next note (shift/legato) the slide runs over THE WHOLE NOTE, from the
// pick to its end, as Rocksmith plays it: slideTo is a target fret and the note's
// sustain is the slide (rocksmith/chart.py).
// Into and out of a note it is as quick as a player makes it, the same both ways:
// an eighth note at the song's tempo there (`eighth`, in seconds), never more than
// half the note — at the start for a slide-in, at the end for a slide-out. Neither
// format stores how long these take (Rocksmith draws a slide-out over the sustain;
// it has no slide-in, Guitar Pro has both, untimed), so the editor does not either.
// A slide-out goes SLIDE.out frets, as the export writes it, and never below fret 1
// (the game cannot land one on the open string); a slide-in comes from SLIDE.into.
//
// `sec` is the time since the onset and `dur` the note's own length, both in the
// same seconds; past `dur` (a legato note carried into its target) it stays landed.
// `to` is a shift/legato target in semitones. `steps: false` is the finger's own
// path, which glides between the frets the pitch steps across.
export const SLIDE = { into: 4, out: 5, eighth: 0.25 };   // eighth: 120 BPM, when no tempo is known
export const SLIDES_TO_NEXT = new Set(["shift", "legato"]);
export const SLIDE_IN = new Set(["inBelow", "inAbove"]);
export const SLIDE_OUT = new Set(["outDown", "outUp"]);

// How long a slide takes, in the seconds `dur` is in.
export const slideSeconds = (n, dur, eighth = SLIDE.eighth) =>
  SLIDE_IN.has(n.slide) || SLIDE_OUT.has(n.slide) ? Math.min(eighth, dur / 2) : dur;

export function slideAt(n, sec, dur, { to = 0, steps = true, eighth = SLIDE.eighth } = {}) {
  const round = steps ? Math.round : (v) => v;
  const kind = n?.slide;
  if (!kind) return 0;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const len = slideSeconds(n, dur, eighth);
  if (SLIDE_IN.has(kind)) {
    const p = len > 0 ? clamp01(sec / len) : 1;
    return round((kind === "inBelow" ? -1 : 1) * SLIDE.into * (1 - p)) || 0;
  }
  const p = len > 0 ? clamp01((sec - (dur - len)) / len) : 1;
  const fret = n.pos?.fret;
  const down = fret > 0 ? -Math.min(SLIDE.out, fret - 1) : -SLIDE.out;
  const span = kind === "outDown" ? down : kind === "outUp" ? SLIDE.out : to;
  return round(span * p) || 0;   // never -0
}

// Bend, vibrato and slide together: the whole pitch offset of a note at `sec`.
export const pitchMoves = (n) => !!(bendCurve(n) || n?.fx?.vibrato || n?.slide);
export const noteOffsetAt = (n, sec, dur, slide = {}) =>
  pitchOffsetAt(n, dur > 0 ? Math.min(1, sec / dur) : 0, sec) + slideAt(n, sec, dur, slide);

// Which note each shift/legato slide lands on: in the next chord along, the note on
// the same string when both are placed, otherwise the nearest pitch. The editor
// draws a slide to the next note in time; for a chord that is the matching voice.
export function slideTargets(notes) {
  const out = new Map();
  if (!notes.some((n) => SLIDES_TO_NEXT.has(n.slide))) return out;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  for (const n of sorted) {
    if (!SLIDES_TO_NEXT.has(n.slide)) continue;
    const next = sorted.find((m) => m.start > n.start + 1e-4);
    if (!next) continue;
    const column = sorted.filter((m) => Math.abs(m.start - next.start) < 1e-4);
    const string = n.pos?.string;
    const target = (string != null && column.find((m) => m.pos?.string === string))
      || column.reduce((best, m) => (Math.abs(m.pitch - n.pitch) < Math.abs(best.pitch - n.pitch) ? m : best));
    out.set(n, target);
  }
  return out;
}

// A slide joins its source to the next attack's position, even across a rest.
// The renderer uses the same ribbon geometry as bends; playback stays separate.
export function slideRibbon(note, target) {
  if (!SLIDES_TO_NEXT.has(note.slide) || !target || target.start <= note.start) return null;
  return { end: target.start, points: [[0, 0], [1, target.pitch - note.pitch]] };
}

export const bendPeak = (pts) => pts.reduce((m, p) => Math.max(m, p[1]), 0);

// Semitone offset at fraction t, linear between control points — how every
// target (canvas, alphaTab, GP, exporters) reads the curve between points.
export function bendAt(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
    if (t <= t1) return t1 === t0 ? v1 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
  }
  return pts[pts.length - 1][1];
}

export const clampSemi = (v) => Math.max(-MAX_SEMI, Math.min(MAX_SEMI, v));

export const snapTo = (v, step) => Math.round(v / step) * step;

// Sorted, clamped, capped copy. bendPoints are always *replaced*, never mutated
// in place, so the {...note} undo snapshots taken earlier stay intact.
export const normalizeCurve = (pts) => pts
  .map((p) => [Math.max(0, Math.min(1, p[0])), clampSemi(p[1])])
  .sort((a, b) => a[0] - b[0])
  .slice(0, MAX_POINTS);

// Which of the five note-bend presets a curve looks like. GP and alphaTab both
// need one to pick the glyph they draw; the enum *numbers* differ, so callers map
// this id onto their own. Read off the curve's direction changes, not its
// extremes: a bend that releases and then pushes past its first peak is still
// bend-release-bend. Mirrored by _bend_type in tab.py.
export function bendShape(pts) {
  const v = pts.map((p) => p[1]);
  if (v[0] > 0) return v[v.length - 1] < v[0] ? "prebendRelease" : "prebend";
  const turns = [];
  for (let i = 1; i < v.length; i++) {
    const d = Math.sign(v[i] - v[i - 1]);
    if (d && turns[turns.length - 1] !== d) turns.push(d);
  }
  if (turns.length >= 3) return "bendReleaseBend";
  return turns.length === 2 && turns[0] === 1 ? "bendRelease" : "bend";
}
