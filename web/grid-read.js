// Grid queries and quantization. Reads the live grid but never imports its
// editing controller, lane UI or undo transactions.
import { gridBpm, gridSubdiv, beatsPerBar, gridTsDen, gridOffset } from "./grid-controls.js";
import { segBeatSec } from "./bars.js";
import { MIN_DUR } from "./constants.js";
import { S } from "./store.js";
import { paintMemo } from "./paint-memo.js";
import { projectStart } from "./project-position-core.js";
import { autoGridStep } from "./auto-grid.js";

// ---- tempo grid ----
const segSubdiv = (seg) => Math.max(1, parseInt(seg && seg.subdiv, 10) || gridSubdiv() || 1);

export const gridStep = () => segStep({ bpm: gridBpm(), tsDen: gridTsDen(), subdiv: gridSubdiv() });

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function lcm(a, b) {
  return Math.abs(a * b) / gcd(a, b);
}

function requiredResolution(tsDen, subdiv) {
  const den = Math.max(1, parseInt(tsDen, 10) || 4) * Math.max(1, parseInt(subdiv, 10) || 1);
  return Math.max(1, den / gcd(den, 4));
}

export function exportResolution() {
  return gridSegments().reduce((res, seg) => lcm(res, requiredResolution(seg.tsDen, seg.subdiv)), 1);
}

// ---- tempo map (per-song tempo/meter markers) ----
// The whole song used to run at one tempo/meter. A song can now carry markers
// (S.state.tempoMap) that each start a NEW bar at their own bpm/meter/subdivision,
// tiling forward until the next marker. The hidden global inputs are segment 0
// (the anchor at `offset`) for backward compatibility with old saves.
// Convention matches the old code and the export: bpm = beats/min, a bar = tsNum
// beats of 60/bpm; tsDen only affects how the beat is notated on export.
const extraMarkers = () => (S.state && S.state.tempoMap) || [];

export const gridSegments = paintMemo(function gridSegments() {
  const seg0 = { t: gridOffset(), bpm: gridBpm(), tsNum: beatsPerBar(), tsDen: gridTsDen(), subdiv: gridSubdiv(), seg0: true };
  return segmentsFrom(seg0, extraMarkers());
});

// Read another timing without switching the live editor grid during a paint.
export function timingSegments(timing) {
  return segmentsFrom({ ...timing.grid, t: Number(timing.grid.offset) || 0, seg0: true }, timing.tempoMap || []);
}

function segmentsFrom(seg0, markers) {
  const raw = markers
    .map((m) => ({ t: +m.t, bpm: +m.bpm, tsNum: parseInt(m.tsNum, 10), tsDen: parseInt(m.tsDen, 10), subdiv: parseInt(m.subdiv, 10), ref: m }))
    .filter((m) => Number.isFinite(m.t) && m.t > seg0.t + 1e-6)
    .sort((a, b) => a.t - b.t);
  const segs = [seg0];
  for (const m of raw) {
    const prev = segs[segs.length - 1];
    segs.push({
      t: m.t,
      bpm: m.bpm || prev.bpm,
      tsNum: m.tsNum || prev.tsNum,
      tsDen: m.tsDen || prev.tsDen,
      subdiv: m.subdiv || prev.subdiv,
      ref: m.ref,
    });
  }
  return segs;
}

// The segment (tempo/meter) in force at time t.
export function gridAt(t) {
  const segs = gridSegments();
  let cur = segs[0];
  for (let i = 1; i < segs.length; i++) { if (segs[i].t <= t + 1e-6) cur = segs[i]; else break; }
  return cur;
}

// segBeatSec/segBarSec live in bars.js — pure arithmetic the voicing worker and the
// corpus tests need without the DOM this module reaches for. Re-exported so every
// caller keeps importing the grid from the grid.
export { segBarSec, segBeatSec } from "./bars.js";
export const segStep = (seg) => segBeatSec(seg) / segSubdiv(seg);        // one grid cell
export const displayGridStep = seg => autoGridStep(seg, S.pxPerSec);

// Shortest a note may be: one cell of the current grid division. Without a
// tempo grid there's no division to measure against, so fall back to MIN_DUR.
export const minDur = () => gridStep() || MIN_DUR;

// A segment's last cell stops at the next marker, even when that marker is
// between its regular grid lines. The marker competes as an exact snap point.
function snapInSegments(t, segments, stepAt, round = Math.round) {
  let index = 0;
  while (index + 1 < segments.length && segments[index + 1].t <= t) index++;
  const seg = segments[index], step = stepAt(seg), boundary = segments[index + 1]?.t;
  if (!step) return t;
  let snapped = seg.t + round((t - seg.t) / step) * step;
  if (boundary != null) {
    snapped = Math.min(snapped, boundary);
    if (round === Math.round && Math.abs(boundary - t) < Math.abs(snapped - t)) snapped = boundary;
  }
  return snapped;
}

function snapTail(start, end, roundedEnd, step, segments, stepAt, round = Math.round) {
  const boundary = segments.find(segment => segment.t > start && segment.t <= Math.max(end, roundedEnd));
  if (!boundary) return roundedEnd;
  const cellEnd = start + Math.ceil((boundary.t - start) / step - 1e-9) * step;
  // The final old-grid cell is truncated, including when the next tempo is
  // faster. Longer spans can continue onto the next segment's own grid.
  if (Math.max(end, roundedEnd) <= cellEnd + 1e-9) return boundary.t;
  return snapInSegments(end, segments, stepAt, round);
}

export function snap(t, segments = null) {
  // A tempo-flag drag uses its starting grid, so its moving origin cannot
  // pull subsequent pointer events onto a different set of snap positions.
  return Math.max(projectStart(S.state), snapInSegments(t, segments || gridSegments(), displayGridStep));
}

// Precision gestures use eight subdivisions of the authored grid cell,
// independently of how zoom coarsens the visible grid.
export function snapFine(t) {
  return Math.max(projectStart(S.state), snapInSegments(t, gridSegments(), seg => segStep(seg) / 8));
}

// Move a note's start onto the visible grid without stretching its rhythm to a
// coarse zoom level. Length retains the underlying musical resolution.
export function snapNote(start, end, { adaptive = true, preserveDuration = false } = {}) {
  const segments = gridSegments(), stepAt = adaptive ? displayGridStep : segStep;
  const seg = gridAt(start), step = stepAt(seg);
  if (preserveDuration) {
    const duration = end - start;
    const latest = S.state ? S.state.duration - duration : Infinity;
    const s = Math.max(projectStart(S.state), Math.min(latest, snapInSegments(start, segments, stepAt)));
    return { start: s, end: s + duration };
  }
  if (!step) {
    const s = Math.max(projectStart(S.state), start);
    return { start: s, end: end + s - start };
  }
  const s = Math.max(projectStart(S.state), snapInSegments(start, segments, stepAt));
  const lengthAt = segment => Math.min(segStep(segment) || step, stepAt(segment) || step);
  const lengthStep = lengthAt(gridAt(s));
  const cells = Math.max(1, Math.round((end - start) / lengthStep));
  const e = snapTail(s, end + s - start, s + cells * lengthStep, lengthStep, segments, lengthAt);
  return { start: s, end: S.state ? Math.min(S.state.duration, e) : e };
}

// After every committed edit: a note whose start fell off its grid — a tempo flag
// dragged it into another tempo's span, an offset change slid it, a meter change
// moved the lines under it — is pulled back on exactly as touching it would. A
// start on a 1/24-of-a-quarter line counts as on-grid: that holds 1/32 and the
// 1/8 and 1/16 triplets, so detected notes and imported tuplets keep their rhythm.
// Hand holds on a snapped note's start follow it. Returns how many notes moved.
// ponytail: start-only check, a note whose end alone is off is left as it is
export function snapStrayNotes(lanes, previous = {}) {
  const on = (t, seg, step) => { const k = (t - seg.t) / step; return Math.abs(k - Math.round(k)) * step < 1e-4; };
  let moved = 0;
  for (const lane of lanes) {
    const oldNotes = new Map((previous[lane.id] || []).map(note => [note.id, note]));
    for (const n of lane.notes) {
      // Unrelated edits must not quantize an earlier freely placed edge.
      if (oldNotes.get(n.id)?.start === n.start) continue;
      const seg = gridAt(n.start);
      if (n.start >= projectStart(S.state) && (!seg.bpm || on(n.start, seg, segStep(seg)) || on(n.start, seg, 60 / seg.bpm / 24))) continue;
      const q = snapNote(n.start, n.end, { adaptive: false, preserveDuration: true });
      for (const h of lane.handHolds || []) if (Math.abs(+h.t - n.start) < 1e-6) h.t = q.start;
      n.start = q.start; n.end = q.end;
      moved++;
    }
  }
  return moved;
}

// Pull a detected note onto the 1/32 grid (the finest division): snap its
// start, then round its length DOWN to a whole number of 1/32 cells (min one)
// so the note never grows past what was detected. Because the start is on-grid
// and the length is a multiple of the step, the end lands on-grid too. With no
// tempo grid there's nothing to quantize against, so pass through unchanged.
export const FINE_SUBDIV = 8;          // 1/32 note

export function quantizeFine(start, end) {
  const seg = gridAt(start);
  if (!seg.bpm) {
    const s = Math.max(projectStart(S.state), start);
    return { start: s, end: end + s - start };
  }
  const segments = gridSegments(), fineStep = segment => segment.bpm ? 60 / segment.bpm / FINE_SUBDIV : 0;
  const s = Math.max(projectStart(S.state), snapInSegments(start, segments, fineStep));
  const step = fineStep(gridAt(s)) || fineStep(seg);
  const cells = Math.max(1, Math.floor((end - start) / step));
  const e = snapTail(s, end + s - start, s + cells * step, step, segments, fineStep, Math.floor);
  return { start: s, end: Math.min(S.state.duration, e) };
}

