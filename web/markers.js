import { paintMarkerFlag } from "./canvas-components.js";
import { placeFloating } from "./floating-position.js";
// Tempo/meter markers ("FMOD-style" flags pinned to the top of the spectrogram).
// Rendering + hit-testing + the little editor popover. The timing math and the
// data model (S.state.tempoMap) live in grid.js; this file is only the UI on top.
// A marker starts a new bar at its own tempo/meter, tiling forward to the next.

import { MM_HEAD, stageMono, stageUi } from "./constants.js";
import { bpmInput, inTourCard, markerAtEl, markerBpm, markerDeleteBtn, markerPop, markerPopClose, markerPopTitle, markerSubdiv, markerSubdivCustom, markerSubdivCustomWrap, markerTime, markerTsDen, markerTsNum, mmctx, offsetInput, scroll, sctx, stage, tsDenInput, tsNumInput } from "./dom.js";
import { draw } from "./repaint.js";
import { STATE_RESTORED, commitStructure, snapshotEdit } from "./edit.js";
import { addMarker, currentGridState, gridOffset, gridSegments, removeMarker, setSubdiv, setSubdivControls, subdivValue, syncSubdivControls } from "./grid.js";
import { timeAt, xOf } from "./geometry.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";
import { railScale, railsHidden } from "./marker-rails.js";
import { gridDivLabelFor } from "./ui.js";
import { refreshSaveState } from "./project.js";

export const MARK_H = 24;   // marker-flag band height (px), pinned to the viewport top

let markerRects = [];       // {seg, x0,x1,y0,y1} in world px, rebuilt each draw() for hit-testing
let editSeg = null;         // the segment currently open in the popover

// Editing in the popover is a session, not a keystroke: every character typed
// into the BPM field fires an input event, and all of them are one Ctrl+Z. Take
// the snapshot before the session's first mutation, commit when the popover
// closes, and drop it uncommitted when undo is what closed it.
let popSnapshot = null;
const beginPopEdit = () => { if (!popSnapshot) popSnapshot = snapshotEdit(); };
const endPopEdit = () => { const prev = popSnapshot; popSnapshot = null; if (prev) commitStructure(prev); };

const fmtBpm = (b) => (Number.isInteger(b) ? String(b) : (+b).toFixed(1));

const markerFields = (seg) => ([
  { value: `${fmtBpm(seg.bpm)} BPM`, font: stageMono(11, 500), color: PAINT.text },
  { value: `${seg.tsNum}/${seg.tsDen}`, font: stageMono(), color: PAINT.label },
  { value: `Grid ${gridDivLabelFor(seg.subdiv || 1)}`, font: stageUi(10), color: PAINT.label },
]);

// One line: tempo leads, meter and editing-grid division stay secondary.
function markerWidth(fields) {
  let w = 18;
  for (const field of fields) {
    sctx.font = field.font;
    w += Math.ceil(sctx.measureText(field.value).width);
  }
  return w + Math.max(0, fields.length - 1) * 14;
}

function toCanvas(cx, cy) {
  const r = stage.getBoundingClientRect();
  return [cx - r.left + scroll.scrollLeft, cy - r.top + scroll.scrollTop];
}

// Flags overlay the top of the stage. Drawn in draw()'s world transform, pinned
// to the viewport top by anchoring at scrollTop (like the detect-region chip).
export function drawMarkers() {
  markerRects = [];
  // Clearing the rects first is what takes the whole strip out of the hit tests
  // below, so hiding the layer needs nothing else from this file except the
  // double-click in init_markers, which does not consult them.
  if (!S.state || railScale() <= 0) return;
  const vy0 = scroll.scrollTop, vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  const y = vy0 + 2, h = MARK_H - 4;
  sctx.save();
  sctx.textBaseline = "middle";
  for (const seg of gridSegments()) {
    const x = xOf(seg.t);
    const fields = markerFields(seg);
    const w = markerWidth(fields);
    const rect = { seg, x0: x, x1: x + w, y0: y, y1: y + h };
    markerRects.push(rect);
    if (x > vx1 + 4 || x + w < vx0 - 4) continue;   // off-screen: keep the rect (never hit), skip paint
    paintMarkerFlag(sctx, rect, seg.seg0 ? PAINT.markerIdle : PAINT.marker);

    let cx = x + 9;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      sctx.font = field.font;
      sctx.fillStyle = field.color;
      sctx.fillText(field.value, cx, y + h / 2);
      cx += Math.ceil(sctx.measureText(field.value).width);
      if (i < fields.length - 1) {
        sctx.fillStyle = PAINT.label;
        sctx.beginPath(); sctx.arc(cx + 7, y + h / 2, .75, 0, Math.PI * 2); sctx.fill();
        cx += 14;
      }
    }
  }
  sctx.restore();
}

function markerAt(x, y) {
  if (railsHidden() || railScale() < 1) return null;
  for (const r of markerRects) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r;
  return null;
}

/** Viewport box of the first tempo flag, for the walkthrough's click target. */
export function firstMarkerViewportRect() {
  const marker = markerRects.find((rect) => rect.seg.seg0);
  if (!marker || railsHidden()) return null;
  const box = stage.getBoundingClientRect();
  return {
    left: box.left + marker.x0 - scroll.scrollLeft,
    top: box.top + marker.y0 - scroll.scrollTop,
    width: marker.x1 - marker.x0,
    height: marker.y1 - marker.y0,
  };
}

// Cursor hint for draw()'s hover cascade: over a flag → "grab".
export function markerCursorAt(x, y) {
  if (!S.state || !markerRects.length) return null;
  if (y - scroll.scrollTop <= MARK_H + 2 && markerAt(x, y)) return "grab";
  return null;
}

// Called first from the stage mousedown. Only the flag (top rail) is a handle, so
// clicks below it fall through to the normal playhead/note editing. Drag a flag to
// move it — the start flag drags the grid origin (offset), others move freely; a
// plain click opens the editor. Set a marker's exact time in that editor instead.
export function markerMouseDown(e) {
  if (!S.state || e.button !== 0) return false;
  const [x, y] = toCanvas(e.clientX, e.clientY);
  if (y - scroll.scrollTop > MARK_H + 2) return false;    // only the flag rail grabs
  const hit = markerAt(x, y);
  if (!hit) return false;                                 // empty rail → fall through; dbl-click adds
  e.preventDefault();
  const seg = hit.seg;
  const grabDT = timeAt(x) - seg.t;
  let moved = null;   // the pre-drag snapshot, taken lazily: a click must not pay for one
  const onMove = (ev) => {
    if (!moved) moved = snapshotEdit();   // before the first write, so it captures the original time
    const [mx] = toCanvas(ev.clientX, ev.clientY);
    const nt = timeAt(mx) - grabDT;
    if (seg.seg0)   // dragging the start flag moves the grid origin (the offset)
      offsetInput.value = Math.max(0, Math.min(S.state.duration - 1e-3, nt)).toFixed(3);
    else
      seg.ref.t = Math.max(gridOffset() + 1e-3, Math.min(S.state.duration - 1e-3, nt));
    draw();
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (!moved) openMarkerPop(ev.clientX, ev.clientY, seg);   // a click (no drag) edits
    // seg0's time IS the grid offset, and the offset input's change handler does
    // its own snapshot + note shift — so hand it over rather than commit twice.
    else if (seg.seg0) offsetInput.dispatchEvent(new Event("change"));
    else { commitStructure(moved); draw(); refreshSaveState(); }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return true;
}

// Right-click menu entry point: drop a marker at a chosen time and open its editor.
export function addMarkerAtTime(t, clientX, clientY) {
  if (!Number.isFinite(t)) return;
  endPopEdit();   // a popover can be open over the rail; that edit ends here
  const prev = snapshotEdit();
  const m = addMarker(t);
  if (!m) return;   // rejected (duplicate time / past the end) — nothing to undo
  commitStructure(prev);   // the add is its own step; the popover edits are the next
  draw();
  refreshSaveState();
  const seg = gridSegments().find((s) => s.ref === m);
  if (seg) openMarkerPop(clientX, clientY, seg);
}

// Little flags in the minimap headroom so tempo/meter changes show at a glance.
export function drawMinimapMarkers(sx) {
  if (!S.state) return;
  for (const seg of gridSegments()) {
    const x = xOf(seg.t) * sx;
    mmctx.fillStyle = seg.seg0 ? PAINT.markerIdle : PAINT.marker;
    mmctx.beginPath();
    mmctx.moveTo(x, 1); mmctx.lineTo(x + 5, 1); mmctx.lineTo(x, MM_HEAD - 2); mmctx.closePath();
    mmctx.fill();
  }
}

function openMarkerPop(clientX, clientY, seg) {
  endPopEdit();   // opening a popover starts a session, so close whichever was open
  editSeg = seg;
  S.taps = [];
  document.getElementById("tapInfo").hidden = true;
  markerPopTitle.textContent = seg.seg0 ? "Tempo (start)" : "Tempo marker";
  markerBpm.value = fmtBpm(seg.bpm);
  markerTsNum.value = seg.tsNum;
  markerTsDen.value = seg.tsDen;
  setSubdivControls(markerSubdiv, markerSubdivCustom, markerSubdivCustomWrap, seg.subdiv || 1);
  markerTime.value = String(+seg.t.toFixed(3));   // exact seconds, not a rounded m:ss
  markerAtEl.textContent = seg.seg0 ? "start marker" : "";
  markerDeleteBtn.hidden = !!seg.seg0;   // the anchor can't be deleted (it's the base grid)
  markerPop.hidden = false;
  placeFloating(markerPop, clientX, clientY);
  markerBpm.focus();
}

/** Reopen the first marker when the walkthrough pages back to its settings. */
export function openFirstMarkerPop() {
  const seg = gridSegments()[0];
  if (!seg) return;
  const rect = firstMarkerViewportRect();
  const box = stage.getBoundingClientRect();
  openMarkerPop(rect?.left ?? box.left + 16, rect ? rect.top + rect.height : box.top + MARK_H, seg);
}

function closeMarkerPop() {
  markerPop.hidden = true;
  editSeg = null;
  endPopEdit();
}

function applyPop() {
  if (!editSeg) return;
  const bpm = parseFloat(markerBpm.value) || editSeg.bpm;
  const tsNum = parseInt(markerTsNum.value, 10) || editSeg.tsNum;
  const tsDen = parseInt(markerTsDen.value, 10) || editSeg.tsDen;
  const subdiv = subdivValue(markerSubdiv, markerSubdivCustom) || editSeg.subdiv || 1;
  beginPopEdit();
  if (editSeg.seg0) {
    // The anchor is the hidden base marker. Updating it moves the grid, not
    // authored audio notes; offset changes are handled separately by marker time.
    bpmInput.value = bpm; tsNumInput.value = tsNum; tsDenInput.value = String(tsDen);
    setSubdiv(subdiv);
    S.appliedGrid = currentGridState();
    draw();
  } else {
    editSeg.ref.bpm = bpm; editSeg.ref.tsNum = tsNum; editSeg.ref.tsDen = tsDen; editSeg.ref.subdiv = subdiv;
    draw();
  }
  refreshSaveState();
}

// Set a marker's exact time from the popover. For an extra marker this is a live
// nudge (cheap, no retiming). seg0's time IS the global grid offset, which shifts
// placed notes — so that runs only on commit (change/blur), reusing the offset
// input's own handler rather than duplicating its note-shift + undo logic.
function applyMarkerTime(commit) {
  if (!editSeg) return;
  let t = parseFloat(markerTime.value);
  if (!Number.isFinite(t)) return;
  if (editSeg.seg0) {
    const bounded = Math.max(0, Math.min(S.state.duration - 1e-3, t));
    if (!commit) {
      // Preview the new grid origin while typing. The committed offset remains
      // untouched until change/blur, when the existing handler shifts notes and
      // records the edit for undo.
      offsetInput.value = String(+bounded.toFixed(3));
      draw();
      return;
    }
    offsetInput.value = bounded.toFixed(3);
    offsetInput.dispatchEvent(new Event("change"));   // shifts notes, updates the grid + undo
    draw();
  } else {
    beginPopEdit();
    editSeg.ref.t = Math.max(gridOffset() + 1e-3, Math.min(S.state.duration - 1e-3, t));
    draw();
    refreshSaveState();
  }
}

export function init_markers() {
  // Double-click the flag band (and not on an existing flag) to drop a marker.
  stage.addEventListener("dblclick", (e) => {
    if (!S.state || railsHidden() || railScale() < 1) return;
    const [x, y] = toCanvas(e.clientX, e.clientY);
    if (y - scroll.scrollTop > MARK_H + 2) return;
    if (markerAt(x, y)) return;   // dbl-click on a flag = edit, handled by mousedown
    addMarkerAtTime(timeAt(x), e.clientX, e.clientY);
  });
  [markerBpm, markerTsNum, markerTsDen].forEach((el) => el.addEventListener("input", applyPop));
  markerSubdiv.addEventListener("change", () => { syncSubdivControls(markerSubdiv, markerSubdivCustom, markerSubdivCustomWrap); applyPop(); });
  markerSubdivCustom.addEventListener("input", applyPop);
  markerTime.addEventListener("input", () => applyMarkerTime(false));
  markerTime.addEventListener("change", () => applyMarkerTime(true));
  markerDeleteBtn.addEventListener("click", () => { if (editSeg && editSeg.ref) { beginPopEdit(); removeMarker(editSeg.ref); closeMarkerPop(); draw(); refreshSaveState(); } });
  markerPopClose.addEventListener("click", closeMarkerPop);
  // Undo replaced S.state.tempoMap, so editSeg.ref points at an object no longer
  // in it. Drop the session without committing and shut the popover.
  window.addEventListener(STATE_RESTORED, () => { popSnapshot = null; closeMarkerPop(); });
  // Marker editors stay open until their close button is pressed.
}
