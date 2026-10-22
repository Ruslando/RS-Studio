// Tempo grid: marker-owned BPM / subdivision / meter state and note quantization
// against it, plus the transport-bar timing readout.

import { retimeSpan, segBeatSec } from "./bars.js";
import { MIN_DUR } from "./constants.js";
import { bpmInput, markerBpm, offsetInput, subdivCustom, subdivCustomWrap, subdivSel, tapBtn, tapInfo, tsDenInput, tsNumInput } from "./dom.js";
import { draw } from "./repaint.js";
import { commit, snapshotEdit } from "./edit.js";
import { editLanes, refreshCounts, renderLanes } from "./lanes.js";
import { onLiveTiming } from "./timing.js";

// The layers the live grid belongs to; a layer with its own timing is not moved by it.
const timedLanes = () => editLanes().filter(onLiveTiming);
import { refreshSaveState } from "./project.js";
import { S } from "./store.js";
import { projectStart } from "./project-position-core.js";
import { autoGridStep } from './auto-grid.js';

// ---- tempo grid ----
export const gridBpm = () => parseFloat(bpmInput.value) || 0;

export const subdivValue = (select, custom) => (select.value === "custom"
  ? Math.max(1, parseInt(custom.value, 10) || 1)
  : parseInt(select.value, 10) || 1);

export const gridSubdiv = () => subdivValue(subdivSel, subdivCustom);

export const beatsPerBar = () => parseInt(tsNumInput.value, 10) || 4;

export const gridTsDen = () => parseInt(tsDenInput.value, 10) || 4;

export const gridOffset = () => parseFloat(offsetInput.value) || 0;

export const segSubdiv = (seg) => Math.max(1, parseInt(seg && seg.subdiv, 10) || gridSubdiv() || 1);

export const gridStep = () => segStep({ bpm: gridBpm(), tsDen: gridTsDen(), subdiv: gridSubdiv() });

// Subdiv: a preset list of divisions-per-beat plus a "Custom..." free entry.
export const SUBDIV_PRESETS = new Set(["1", "2", "3", "4", "6", "8"]);

export function syncSubdivControls(select, custom, wrap) {
  wrap.hidden = select.value !== "custom";
}

export function setSubdivControls(select, custom, wrap, value) {
  const v = String(Math.max(1, parseInt(value, 10) || 1));
  if (SUBDIV_PRESETS.has(v)) {
    select.value = v;
  } else {
    select.value = "custom";
    custom.value = v;
  }
  syncSubdivControls(select, custom, wrap);
}

export const syncSubdivCustom = () => syncSubdivControls(subdivSel, subdivCustom, subdivCustomWrap);

export const setSubdiv = (value) => setSubdivControls(subdivSel, subdivCustom, subdivCustomWrap, value);

let tapReadoutTimer = 0;

function showTapReadout(message) {
  tapInfo.textContent = message;
  tapInfo.hidden = false;
  clearTimeout(tapReadoutTimer);
  tapReadoutTimer = setTimeout(() => { tapInfo.hidden = true; }, 6000);
}

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
export const extraMarkers = () => (S.state && S.state.tempoMap) || [];

export function gridSegments() {
  const seg0 = { t: gridOffset(), bpm: gridBpm(), tsNum: beatsPerBar(), tsDen: gridTsDen(), subdiv: gridSubdiv(), seg0: true };
  return segmentsFrom(seg0, extraMarkers());
}

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

// Add a marker at the nearest note-grid position. Inherits the tempo/meter in force
// there, so dropping it moves no beat; its grid division starts at 1/32. Returns
// the marker, or null if it can't sit here.
export function addMarker(t) {
  if (!S.state) return null;
  if (!S.state.tempoMap) S.state.tempoMap = [];
  const map = S.state.tempoMap;
  const mt = Math.max(gridOffset() + 1e-3, snap(t));
  if (mt >= S.state.duration || map.some((m) => Math.abs(+m.t - mt) < 1e-4)) return null;
  const seg = gridAt(mt);
  const m = { t: mt, bpm: seg.bpm || gridBpm() || 120, tsNum: seg.tsNum, tsDen: seg.tsDen, subdiv: FINE_SUBDIV };   // new markers start on the 1/32 grid
  map.push(m);
  return m;
}

export function removeMarker(m) {
  const map = S.state && S.state.tempoMap;
  if (!map) return;
  const i = map.indexOf(m);
  if (i >= 0) map.splice(i, 1);
}

export function currentGridState() {
  return {
    bpm: gridBpm(),
    offset: gridOffset(),
    subdiv: gridSubdiv(),
    tsNum: beatsPerBar(),
    tsDen: parseInt(tsDenInput.value, 10) || 4,
  };
}

function copyGridState(g) {
  return {
    bpm: +g.bpm || 0,
    offset: +g.offset || 0,
    subdiv: Math.max(1, parseInt(g.subdiv, 10) || 1),
    tsNum: parseInt(g.tsNum, 10) || 4,
    tsDen: parseInt(g.tsDen, 10) || 4,
  };
}

export function restoreGridState(g) {
  const grid = copyGridState(g);
  bpmInput.value = grid.bpm || "";
  offsetInput.value = grid.offset.toFixed(3);
  setSubdiv(grid.subdiv);
  tsNumInput.value = grid.tsNum;
  tsDenInput.value = String(grid.tsDen);
  S.appliedOffset = grid.offset;
  S.appliedGrid = currentGridState();
}

// Shortest a note may be: one cell of the current grid division. Without a
// tempo grid there's no division to measure against, so fall back to MIN_DUR.
export const minDur = () => gridStep() || MIN_DUR;

export function snap(t, segments = null) {
  // A tempo-flag drag uses its starting grid, so its moving origin cannot
  // pull subsequent pointer events onto a different set of snap positions.
  const seg = segments ? [...segments].reverse().find(s => s.t <= t) || segments[0] : gridAt(t);
  const step = displayGridStep(seg);
  if (!step) return Math.max(projectStart(S.state), t);
  return Math.max(projectStart(S.state), Math.round((t - seg.t) / step) * step + seg.t);
}

// Move a note's start onto the visible grid without stretching its rhythm to a
// coarse zoom level. Length retains the underlying musical resolution.
export function snapNote(start, end, { adaptive = true } = {}) {
  const seg = gridAt(start), step = adaptive ? displayGridStep(seg) : segStep(seg);
  if (!step) {
    const s = Math.max(projectStart(S.state), start);
    return { start: s, end: end + s - start };
  }
  const s = Math.max(projectStart(S.state), Math.round((start - seg.t) / step) * step + seg.t);
  const lengthStep = Math.min(segStep(seg) || step, step);
  const cells = Math.max(1, Math.round((end - start) / lengthStep));
  return { start: s, end: S.state ? Math.min(S.state.duration, s + cells * lengthStep) : s + cells * lengthStep };
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
      const q = snapNote(n.start, n.end, { adaptive: false });
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
  const step = 60 / seg.bpm / FINE_SUBDIV;
  const s = Math.max(projectStart(S.state), Math.round((start - seg.t) / step) * step + seg.t);
  const cells = Math.max(1, Math.floor((end - start) / step));
  return { start: s, end: Math.min(S.state.duration, s + cells * step) };
}

// The offset marks where beat 1 sits (it trims leading silence). Changing it
// re-defines the grid, so notes that were placed/snapped against the old offset
// must ride along by the same delta — otherwise correcting e.g. 0.16→0.14 leaves
// every snapped note a hair off the beat. Slide every note and its reference boxes.
function shiftEditLanesBy(delta) {
  const dur = S.state.duration;
  for (const lane of timedLanes()) {
    for (const n of lane.notes) {
      n.start = Math.max(projectStart(S.state), n.start + delta);
      n.end = Math.min(dur, n.end + delta);
    }
    if (lane.refBoxes)
      for (const g of Object.values(lane.refBoxes))
        if (g && Array.isArray(g.anchors)) g.anchors = g.anchors.map((a) => a + delta);
  }
}

function hasGridContent() {
  return timedLanes().some((l) => l.notes.length || (l.refBoxes && Object.keys(l.refBoxes).length));
}

// A tempo marker's BPM changed: re-time what sits under it (see retimeSpan).
export function retimeTempoSpan(t0, t1, oldBpm, newBpm) {
  if (!S.state) return 0;
  const sections = (S.state.sectionMarkers || []).filter(marker => !S.state.stems?.length || marker.sectionType !== 'end');
  return retimeSpan(timedLanes(), sections, S.state.duration, minDur(), t0, t1, oldBpm, newBpm);
}

export function init_grid() {
  // The grid fields are hidden state the marker popover writes; only the offset
  // still fires "change" (applyMarkerTime), so only it shifts notes from here.
  // A committed offset edit may not shift notes (empty project), so refresh the
  // unsaved dot directly.
  offsetInput.addEventListener("change", () => refreshSaveState());
  // Commit on "change" (blur / Enter / spinner step), not on every keystroke, so the
  // delta is measured against the last committed offset rather than half-typed values.
  offsetInput.addEventListener("change", () => {
    const cur = gridOffset(), old = S.appliedOffset, delta = cur - old;
    S.appliedOffset = cur;
    if (S.appliedGrid) S.appliedGrid.offset = cur;
    if (!S.state || Math.abs(delta) < 1e-9) return;
    if (!hasGridContent()) return;
    const prev = snapshotEdit();
    prev.grid = { ...(S.appliedGrid || currentGridState()), offset: old };
    prev.offset = old;            // undo should restore the offset that matched the un-shifted notes
    shiftEditLanesBy(delta);
    commit(prev);
    refreshCounts(); renderLanes(); draw();
  });
  syncSubdivCustom();
  // Prevent the mouse wheel from silently changing number fields on hover/scroll.
  document.querySelectorAll('input[type="number"]').forEach((el) =>
    el.addEventListener("wheel", (e) => { if (document.activeElement !== el) e.preventDefault(); }, { passive: false }));
  tapBtn.addEventListener("click", () => {
    const now = performance.now() / 1000;
    // Restart the tap session after a pause.
    if (S.taps.length && now - S.taps[S.taps.length - 1] > 2) S.taps = [];
    S.taps.push(now);
    // Bounded history: large enough to settle, still adapts if you drift.
    if (S.taps.length > 24) S.taps.shift();
    if (S.taps.length < 2) { showTapReadout("Tap again…"); return; }
  
    const iv = [];
    for (let i = 1; i < S.taps.length; i++) iv.push(S.taps[i] - S.taps[i - 1]);
  
    // Reject mis-taps via the median, then average the rest so it converges.
    const sorted = [...iv].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const good = iv.filter((d) => Math.abs(d - median) <= 0.35 * median);
    const use = good.length ? good : iv;
    const mean = use.reduce((a, b) => a + b, 0) / use.length;
    const bpm = 60 / mean;
  
    // Apply to the open tempo flag through its existing live-edit/undo path.
    const measured = Math.max(20, Math.min(320, bpm));
    markerBpm.value = measured.toFixed(1);
    markerBpm.dispatchEvent(new Event("input", { bubbles: true }));   // bubbles so the popover sees it (revert button)
    showTapReadout(`${measured.toFixed(1)} BPM · ${S.taps.length} taps`);
  });
}
