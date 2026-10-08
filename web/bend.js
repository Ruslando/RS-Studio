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
