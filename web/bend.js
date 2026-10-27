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

// Where vibrato sets in, as a fraction of the note (`vibratoStart`, absent from
// the pick). Rocksmith has no such field; the export cuts the note there and
// links the vibrato part to the plain one (rocksmith/chart.py).
export const vibratoStartOf = (n) => n?.fx?.vibrato
  ? Math.max(0, Math.min(SLIDE_START_MAX, Number(n.vibratoStart) || 0)) : 0;

// How far the string is PUSHED (sideways): the bend curve at fraction u of the
// note plus the vibrato `sec` seconds after its onset (or after its own start).
// One answer for the fretboard's finger and the playback's pitch, so the two agree.
export function pitchOffsetAt(n, u, sec) {
  const pts = bendCurve(n);
  const from = vibratoStartOf(n) * Math.max(0, (n?.end ?? 0) - (n?.start ?? 0));
  return (pts ? bendAt(pts, u) : 0) + (n?.fx?.vibrato ? vibratoAt(sec - from) : 0);
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
// Onto the next note (shift/legato) the slide runs from `slideStart` (the pick,
// unless moved later) to the note's end, as Rocksmith plays it: the note's
// sustain is the slide (rocksmith/chart.py). Out of a note (outDown/outUp) it
// always runs over the whole note: Rocksmith's unpitched slide spans the sustain,
// and a late start would need a linked note carrying it, untried in the game.
// Into a note (inBelow/inAbove) it runs from the pick to `slideEnd`, by default an
// eighth note at the song's tempo there (`eighth`, in seconds), never more than
// half the note. Rocksmith has no slide-in: the export plays it as a short note
// a few frets away with a legato slide into this one.
//
// A slide into or out of a note spans `slideFrets` frets (SLIDE_FRETS unless
// set), as far as Rocksmith reaches from the note's fret: see slideReach.
//
// `sec` is the time since the onset and `dur` the note's own length, both in the
// same seconds; past `dur` (a legato note carried into its target) it stays landed.
// `to` is a shift/legato target in semitones. `steps: false` is the finger's own
// path, which glides between the frets the pitch steps across.
export const SLIDE = { eighth: 0.25 };   // 120 BPM, when no tempo is known
export const SLIDES_TO_NEXT = new Set(["shift", "legato"]);
export const SLIDE_IN = new Set(["inBelow", "inAbove"]);
export const SLIDE_OUT = new Set(["outDown", "outUp"]);
export const SLIDE_FRETS = { inBelow: 4, inAbove: 4, outDown: 5, outUp: 5 };
const SLIDE_SIGN = { inBelow: -1, inAbove: 1, outDown: -1, outUp: 1 };   // where the far end sits
// ponytail: Rocksmith's neck, not the lane's; a shorter neck is clamped by the export.
export const MAX_FRET = 24;

// How many frets a slide into or out of a note on `fret` can span in Rocksmith.
// A slide-out ends on fret 1 at the lowest (the game draws one onto the open
// string wrong) and 24 at the highest; a slide-in's lead-in note (chart.py) sits
// on the same frets. An open string slides nowhere. An unknown fret is unlimited.
export function slideReach(kind, fret) {
  if (!SLIDE_SIGN[kind]) return 0;
  if (fret == null) return Infinity;
  if (fret <= 0) return 0;
  return Math.max(0, SLIDE_SIGN[kind] < 0 ? fret - 1 : MAX_FRET - fret);
}

// Semitones from the note to its slide's far end (where a slide-in comes from,
// where a slide-out goes): signed, 0 when the slide cannot go anywhere.
export function edgeSlideSpan(n, fret = n?.pos?.fret) {
  const kind = n?.slide;
  if (!SLIDE_SIGN[kind]) return 0;
  const frets = Math.max(1, Math.round(Number(n.slideFrets) || SLIDE_FRETS[kind]));
  return SLIDE_SIGN[kind] * Math.min(frets, slideReach(kind, fret)) || 0;
}

// Where a shift/legato slide leaves its fret, as a fraction of the note: the
// note is held until then and slides over the rest. `slideStart` is absent for a
// slide over the whole note. Rocksmith has no such field; the export holds the
// note and links it to a second one that slides (rocksmith/chart.py).
export const SLIDE_START_MAX = 0.95;
export const slideStartOf = (n) => SLIDES_TO_NEXT.has(n?.slide)
  ? Math.max(0, Math.min(SLIDE_START_MAX, Number(n.slideStart) || 0)) : 0;

// Where a slide-in lands, as a fraction of the note.
export const SLIDE_END_MIN = 0.05;
export function slideEndOf(n, dur, eighth = SLIDE.eighth) {
  if (!SLIDE_IN.has(n?.slide)) return 0;
  const set = Number(n.slideEnd);
  if (set > 0) return Math.max(SLIDE_END_MIN, Math.min(SLIDE_START_MAX, set));
  return dur > 0 ? Math.min(eighth, dur / 2) / dur : 0.5;
}

export function slideAt(n, sec, dur, { to = 0, steps = true, eighth = SLIDE.eighth, fret = n?.pos?.fret } = {}) {
  const round = steps ? Math.round : (v) => v;
  const kind = n?.slide;
  if (!kind) return 0;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  if (SLIDE_IN.has(kind)) {
    const len = dur * slideEndOf(n, dur, eighth);
    const p = len > 0 ? clamp01(sec / len) : 1;
    return round(edgeSlideSpan(n, fret) * (1 - p)) || 0;
  }
  const len = dur * (1 - slideStartOf(n));
  const p = len > 0 ? clamp01((sec - (dur - len)) / len) : 1;
  const span = SLIDE_OUT.has(kind) ? edgeSlideSpan(n, fret) : to;
  return round(span * p) || 0;   // never -0
}

// Bend, vibrato and slide together: the whole pitch offset of a note at `sec`.
export const pitchMoves = (n) => !!(bendCurve(n) || n?.fx?.vibrato || n?.slide);
export const noteOffsetAt = (n, sec, dur, slide = {}) =>
  pitchOffsetAt(n, dur > 0 ? Math.min(1, sec / dur) : 0, sec) + slideAt(n, sec, dur, slide);

// Which note each shift/legato slide lands on: in the next chord along, the note on
// the same string when both are placed, otherwise the nearest pitch. The editor
// draws a slide to the next note in time; for a chord that is the matching voice.
//
// One string carries one slide, so a target is claimed once: known strings pair
// first (`positionOf`: pinned or voiced), then a chord sliding into a chord of the
// same size moves as a shape (k-th voice from the bottom onto the k-th), and
// anything else takes the nearest unclaimed pitch. The shape rule covers callers
// that know no strings.
export function slideTargets(notes, positionOf = (n) => n.pos) {
  const out = new Map();
  if (!notes.some((n) => SLIDES_TO_NEXT.has(n.slide))) return out;
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const cols = [];
  for (const n of sorted) {
    if (!cols.length || n.start - cols.at(-1)[0].start >= 1e-4) cols.push([]);
    cols.at(-1).push(n);
  }
  const near = (n, pool) => pool.reduce((best, m) => (Math.abs(m.pitch - n.pitch) < Math.abs(best.pitch - n.pitch) ? m : best));
  for (let i = 0; i + 1 < cols.length; i++) {
    const free = [...cols[i + 1]];
    const claim = (n, m) => { out.set(n, m); if (free.includes(m)) free.splice(free.indexOf(m), 1); };
    const rest = cols[i].filter((n) => {
      if (!SLIDES_TO_NEXT.has(n.slide)) return false;
      const string = positionOf(n)?.string;
      const same = string != null && free.find((m) => positionOf(m)?.string === string);
      if (same) claim(n, same);
      return !same;
    });
    if (rest.length > 1 && rest.length === free.length) { const shape = [...free]; rest.forEach((n, k) => claim(n, shape[k])); }
    else for (const n of rest) claim(n, near(n, free.length ? free : cols[i + 1]));
  }
  return out;
}

// A slide joins its source to the next attack's position, even across a rest.
// The renderer uses the same ribbon geometry as bends; playback stays separate.
// A late slide start holds the ribbon flat until the note's own fraction of it.
// A slide into or out of the note stays within it, from or to its far end;
// `fret` and `eighth` are what slideAt takes.
export function slideRibbon(note, target, { fret = note?.pos?.fret, eighth = SLIDE.eighth } = {}) {
  if (SLIDE_IN.has(note.slide) || SLIDE_OUT.has(note.slide)) {
    const span = edgeSlideSpan(note, fret);
    if (!span) return null;
    if (SLIDE_IN.has(note.slide)) {
      const e = slideEndOf(note, note.end - note.start, eighth);
      return { end: note.end, points: [[0, span], [e, 0], [1, 0]] };
    }
    return { end: note.end, points: [[0, 0], [1, span]] };
  }
  if (!SLIDES_TO_NEXT.has(note.slide) || !target || target.start <= note.start) return null;
  const to = target.pitch - note.pitch, s = slideStartOf(note);
  const hold = s * (note.end - note.start) / (target.start - note.start);
  return { end: target.start, points: hold > 0 && hold < 1 ? [[0, 0], [hold, 0], [1, to]] : [[0, 0], [1, to]] };
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

// The curve as the stage draws it (draw.js traceBendPath): flat runs straight,
// every other step eased by a cubic whose handles sit at the step's middle.
// Hit-testing reads this, so a note is grabbed exactly where it is seen.
export function easedCurveAt(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
    if (t > t1) continue;
    if (v0 === v1 || t1 === t0) return t1 === t0 ? v1 : v0;
    const tm = (t0 + t1) / 2, at = (u) => (1 - u) ** 3 * t0 + 3 * (1 - u) * u * tm + u ** 3 * t1;
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (at(mid) < t) lo = mid; else hi = mid; }
    const u = (lo + hi) / 2;
    return v0 + (v1 - v0) * (3 * (1 - u) * u * u + u ** 3);
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
