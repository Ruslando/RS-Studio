import { FINE_SUBDIV, gridAt, minDur, snap } from "./grid-read.js";
import { gridBpm, gridOffset, syncSubdivCustom, currentGridState } from "./grid-controls.js";
// Tempo grid: marker-owned BPM / subdivision / meter state and note quantization
// against it, plus the transport-bar timing readout.

import { retimeSpan } from "./bars.js";
import { markerBpm, offsetInput, tapBtn, tapInfo } from "./dom.js";
import { draw } from "./repaint.js";
import { commit, snapshotEdit } from "./edit-history.js";
import { editLanes, refreshCounts, renderLanes } from "./lanes.js";
import { onLiveTiming, sectionsOnLiveTempo } from "./timing.js";

// The layers the live grid belongs to; a layer with its own timing is not moved by it.
const timedLanes = () => editLanes().filter(onLiveTiming);
import { refreshSaveState } from "./save-state.js";
import { S } from "./store.js";
import { projectStart } from "./project-position-core.js";

let tapReadoutTimer = 0;

function showTapReadout(message) {
  tapInfo.textContent = message;
  tapInfo.hidden = false;
  clearTimeout(tapReadoutTimer);
  tapReadoutTimer = setTimeout(() => { tapInfo.hidden = true; }, 6000);
}

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
  const sections = sectionsOnLiveTempo().filter(marker => !S.state.stems?.length || marker.sectionType !== 'end');
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
