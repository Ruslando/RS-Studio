// Tempo grid: marker-owned BPM / subdivision / meter state and note quantization
// against it, plus the transport-bar timing readout.

import { segBeatSec } from "./bars.js";
import { MIN_DUR } from "./constants.js";
import { bpmInput, detectBpmBtn, markerBpm, offsetInput, subdivCustom, subdivCustomWrap, subdivSel, tapBtn, tapInfo, tsDenInput, tsNumInput } from "./dom.js";
import { draw } from "./repaint.js";
import { commit, snapshotEdit } from "./edit.js";
import { editLanes, refreshCounts, renderLanes } from "./lanes.js";
import { refreshSaveState } from "./project.js";
import { eachRefGroup } from "./references.js";
import { S } from "./store.js";

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
  const raw = extraMarkers()
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

// Add a marker at time t (placed freely — by ear against the audio, no snapping;
// the export quantizes the seam later). Inherits whatever tempo/meter is in force
// there so dropping it changes nothing until you edit it. Returns the marker, or
// null if it can't sit here.
export function addMarker(t) {
  if (!S.state) return null;
  if (!S.state.tempoMap) S.state.tempoMap = [];
  const map = S.state.tempoMap;
  const mt = Math.max(gridOffset() + 1e-3, t);
  if (mt >= S.state.duration || map.some((m) => Math.abs(+m.t - mt) < 1e-4)) return null;
  const seg = gridAt(mt);
  const m = { t: mt, bpm: seg.bpm || gridBpm() || 120, tsNum: seg.tsNum, tsDen: seg.tsDen, subdiv: seg.subdiv || gridSubdiv() };
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

function gridStepFor(g) {
  const grid = copyGridState(g);
  return segStep(grid);
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

export function snap(t) {
  const seg = gridAt(t), step = segStep(seg);
  if (!step) return t;
  return Math.max(0, Math.round((t - seg.t) / step) * step + seg.t);
}

// Pull a whole note onto the current display grid: snap the start to the nearest
// gridline AND round the length to a whole number of grid cells (min one), so both
// edges land on gridlines. This is the "enforce grid placement" primitive every
// note-moving operation funnels through. With no tempo grid the note is returned
// unchanged, which is how off-grid notes stay allowed only before timing exists.
export function snapNote(start, end) {
  const seg = gridAt(start), step = segStep(seg);
  if (!step) return { start, end };
  const s = Math.max(0, Math.round((start - seg.t) / step) * step + seg.t);
  const cells = Math.max(1, Math.round((end - start) / step));
  return { start: s, end: S.state ? Math.min(S.state.duration, s + cells * step) : s + cells * step };
}

// Pull a detected note onto the 1/32 grid (the finest division): snap its
// start, then round its length DOWN to a whole number of 1/32 cells (min one)
// so the note never grows past what was detected. Because the start is on-grid
// and the length is a multiple of the step, the end lands on-grid too. With no
// tempo grid there's nothing to quantize against, so pass through unchanged.
export const FINE_SUBDIV = 8;          // 1/32 note

export function quantizeFine(start, end) {
  const seg = gridAt(start);
  if (!seg.bpm) return { start, end };
  const step = 60 / seg.bpm / FINE_SUBDIV;
  const s = Math.max(0, Math.round((start - seg.t) / step) * step + seg.t);
  const cells = Math.max(1, Math.floor((end - start) / step));
  return { start: s, end: Math.min(S.state.duration, s + cells * step) };
}

// The offset marks where beat 1 sits (it trims leading silence). Changing it
// re-defines the grid, so notes that were placed/snapped against the old offset
// must ride along by the same delta — otherwise correcting e.g. 0.16→0.14 leaves
// every snapped note a hair off the beat. Slide every note and its reference boxes.
function shiftEditLanesBy(delta) {
  const dur = S.state.duration;
  for (const lane of editLanes()) {
    for (const n of lane.notes) {
      n.start = Math.max(0, n.start + delta);
      n.end = Math.min(dur, n.end + delta);
    }
    if (lane.refBoxes)
      for (const g of Object.values(lane.refBoxes))
        if (g && Array.isArray(g.anchors)) g.anchors = g.anchors.map((a) => a + delta);
  }
}

function hasGridContent() {
  return editLanes().some((l) => l.notes.length || (l.refBoxes && Object.keys(l.refBoxes).length));
}

function retimeGridTime(t, oldGrid, newGrid) {
  const newG = copyGridState(newGrid), oldG = copyGridState(oldGrid);
  const newStep = gridStepFor(newG);
  if (!newStep) return t;
  const oldStep = gridStepFor(oldG);
  if (!oldStep) return Math.max(0, newG.offset + Math.round((t - newG.offset) / newStep) * newStep);
  const beatPos = Math.round((t - oldG.offset) / oldStep) / oldG.subdiv;
  return Math.max(0, newG.offset + Math.round(beatPos * newG.subdiv) * newStep);
}

function retimeGridRelative(v, oldGrid, newGrid) {
  const newG = copyGridState(newGrid), oldG = copyGridState(oldGrid);
  const newStep = gridStepFor(newG);
  if (!newStep) return v;
  const oldStep = gridStepFor(oldG);
  if (!oldStep) return Math.round(v / newStep) * newStep;
  const beatOffset = Math.round(v / oldStep) / oldG.subdiv;
  return Math.round(beatOffset * newG.subdiv) * newStep;
}

function retimeGridDuration(d, oldGrid, newGrid) {
  const newStep = gridStepFor(newGrid);
  if (!newStep) return d;
  return Math.max(newStep, Math.abs(retimeGridRelative(d, oldGrid, newGrid)));
}

function changedTime(a, b) {
  return Math.abs((+a || 0) - (+b || 0)) > 1e-9;
}

export function retimeEditLanesToGrid(oldGrid, newGrid) {
  const counts = { notes: 0, boxes: 0 };
  const step = gridStepFor(newGrid);
  if (!step) return counts;
  eachRefGroup((lane, ref, group) => {
    group.anchors = group.anchors.map((a) => {
      const next = retimeGridTime(a, oldGrid, newGrid);
      if (changedTime(next, a)) counts.boxes++;
      return next;
    });
    const rt0 = retimeGridRelative(group.rt0, oldGrid, newGrid);
    const rt1 = Math.max(rt0 + step, retimeGridRelative(group.rt1, oldGrid, newGrid));
    if (changedTime(rt0, group.rt0)) { group.rt0 = rt0; counts.boxes++; }
    if (changedTime(rt1, group.rt1)) { group.rt1 = rt1; counts.boxes++; }
  });
  for (const lane of editLanes()) {
    for (const n of lane.notes) {
      const s = retimeGridTime(n.start, oldGrid, newGrid);
      const e = Math.min(S.state.duration, s + retimeGridDuration(n.end - n.start, oldGrid, newGrid));
      if (changedTime(s, n.start) || changedTime(e, n.end)) {
        n.start = s; n.end = e; counts.notes++;
      }
    }
  }
  return counts;
}

function commitGridTimingChange(oldGrid = S.appliedGrid || currentGridState()) {
  const oldG = copyGridState(oldGrid), newG = currentGridState();
  const sameTiming = !changedTime(oldG.bpm, newG.bpm) &&
    !changedTime(oldG.offset, newG.offset) &&
    oldG.subdiv === newG.subdiv;
  if (!S.state || sameTiming || !hasGridContent()) {
    S.appliedGrid = copyGridState(newG);
    S.appliedOffset = newG.offset;
    if (S.state) draw();
    return;
  }
  const prev = snapshotEdit();
  prev.grid = oldG;
  prev.offset = oldG.offset;
  const changed = retimeEditLanesToGrid(oldG, newG);
  S.appliedGrid = copyGridState(newG);
  S.appliedOffset = newG.offset;
  if (changed.notes || changed.boxes) {
    commit(prev);
    refreshCounts(); renderLanes();
  }
  draw();
}

export function init_grid() {
  // ---- marker-backed grid controls ----
  [bpmInput, offsetInput, subdivSel, subdivCustom, tsNumInput, tsDenInput]
    .forEach((el) => el.addEventListener("input", () => { draw(); }));
  // A committed grid edit (blur/Enter/step) may not retime notes (empty project,
  // meter-only change) so it can skip commit() — refresh the unsaved dot directly.
  [bpmInput, offsetInput, subdivSel, subdivCustom, tsNumInput, tsDenInput]
    .forEach((el) => el.addEventListener("change", () => refreshSaveState()));
  bpmInput.addEventListener("change", () => commitGridTimingChange());
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
  subdivSel.addEventListener("change", () => { syncSubdivCustom(); commitGridTimingChange(); });
  subdivCustom.addEventListener("change", () => commitGridTimingChange());
  syncSubdivCustom();
  // Prevent the mouse wheel from silently changing number fields on hover/scroll.
  document.querySelectorAll('input[type="number"]').forEach((el) =>
    el.addEventListener("wheel", (e) => { if (document.activeElement !== el) e.preventDefault(); }, { passive: false }));
  detectBpmBtn.addEventListener("click", () => {
    if (S.state && S.state.detectedTempo) {
      const oldGrid = S.appliedGrid || currentGridState();
      bpmInput.value = S.state.detectedTempo;
      commitGridTimingChange(oldGrid);
    }
  });
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
    markerBpm.dispatchEvent(new Event("input"));
    showTapReadout(`${measured.toFixed(1)} BPM · ${S.taps.length} taps`);
  });
}
