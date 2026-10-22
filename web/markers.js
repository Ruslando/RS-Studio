import { paintMarkerFlag } from "./canvas-components.js";
import { placeFloating } from "./floating-position.js";
// Tempo/meter markers ("FMOD-style" flags pinned to the top of the spectrogram).
// Rendering + hit-testing + the little editor popover. The timing math and the
// data model (S.state.tempoMap) live in grid.js; this file is only the UI on top.
// A marker starts a new bar at its own tempo/meter, tiling forward to the next.

import { MM_HEAD, stageMono, stageUi } from "./constants.js";
import { bpmInput, inTourCard, markerBpm, markerDeleteBtn, markerPop, markerPopClose, markerPopTitle, markerSubdiv, markerSubdivCustom, markerSubdivCustomWrap, markerTime, markerTsDen, markerTsNum, mmctx, offsetInput, scroll, sctx, stage, tsDenInput, tsNumInput } from "./dom.js";
import { draw } from "./repaint.js";
import { STATE_RESTORED, commitStructure, snapshotEdit } from "./edit.js";
import { addMarker, currentGridState, gridOffset, gridSegments, snap, removeMarker, retimeTempoSpan, setSubdiv, setSubdivControls, subdivValue, syncSubdivControls } from "./grid.js";
import { toast } from "./notify.js";
import { refreshTabIfOpen } from "./tablature.js";
import { timeAt, xOf } from "./geometry.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";
import { projectStart } from "./project-position-core.js";
import { railScale, railsHidden, timedLaneMarkers } from "./marker-rails.js";
import { editLanes } from "./lanes.js";
import { onLiveTiming, SONG, withTiming } from "./timing.js";
import { sectionMarkersChanged } from "./section-markers.js";
import { gridDivLabelFor } from "./ui.js";
import { refreshSaveState } from "./project.js";

export const MARK_H = 24;   // marker-flag band height (px), pinned to the viewport top

let markerRects = [];       // {seg, x0,x1,y0,y1} in world px, rebuilt each draw() for hit-testing
let editSeg = null;         // the segment currently open in the popover
let editTiming = null;
const inEditTiming = fn => (...args) => withTiming(editTiming || S.state.liveTiming || SONG, () => fn(...args));

// Editing in the popover is a session, not a keystroke: every character typed
// into the BPM field fires an input event, and all of them are one Ctrl+Z. Take
// the snapshot before the session's first mutation, commit when the popover
// closes, and drop it uncommitted when undo is what closed it.
let popSnapshot = null;
let popSeg = null;          // the segment as it was when the session began: its bpm is the old tempo
let popRiders = null;       // what a time edit carries along (spanRiders), taken at the session's first one
const beginPopEdit = () => { if (!popSnapshot) { popSnapshot = snapshotEdit(); popSeg = editSeg; } };
const endPopEditInTiming = inEditTiming(() => {
  const prev = popSnapshot, seg = popSeg;
  popSnapshot = popSeg = popRiders = null;
  if (!prev) return;
  retimeSession(seg);
  commitStructure(prev);
  refreshTabIfOpen();
});
const endPopEdit = () => { if (popSnapshot) endPopEditInTiming(); };

// A BPM change re-times what sits under the marker, once, when the session ends —
// not per keystroke, where typing "1" on the way to "125" would mean 1 BPM.
function retimeSession(seg) {
  if (!seg || (!seg.seg0 && !S.state.tempoMap?.includes(seg.ref))) return;   // deleted: nothing to stretch
  const t0 = seg.seg0 ? gridOffset() : +seg.ref.t;
  const bpm = seg.seg0 ? parseFloat(bpmInput.value) : +seg.ref.bpm;
  const t1 = gridSegments().find((s) => s.t > t0 + 1e-6)?.t ?? Infinity;
  if (bpm === seg.bpm) return;
  const spilled = retimeTempoSpan(t0, t1, seg.bpm, bpm);
  sectionMarkersChanged();   // the retime moved section flags in place
  draw(); refreshTabIfOpen();   // the notes moved; nothing else repaints until the next mouse move
  if (spilled) toast(`${spilled} note${spilled === 1 ? "" : "s"} moved past the next tempo marker — check them`, 6000, "warn");
}

const fmtBpm = (b) => String(+(+b).toFixed(2));   // label only; the popup shows the exact value

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

// Everything from a tempo flag up to the next one — notes, hand holds, reference
// boxes and section/phrase/tone markers — as closures that put it at its original
// time plus `delta`. Content past the next flag belongs to that one and stays put.
function spanRiders(seg) {
  const t1 = gridSegments().find((s) => s.t > seg.t + 1e-6)?.t ?? Infinity;
  const inSpan = (t) => t >= seg.t - 1e-6 && t < t1 - 1e-6;
  const dur = S.state.duration, clamp = (t) => Math.max(projectStart(S.state), Math.min(dur, t));
  const lanes = editLanes().filter(onLiveTiming), riders = [];   // a layer with its own timing stays
  const marks = [...(S.state.sectionMarkers || []), ...timedLaneMarkers(lanes), ...lanes.flatMap((l) => l.handHolds || [])];
  for (const m of marks) {
    const t = +m.t;
    if (inSpan(t)) riders.push((d) => { m.t = clamp(t + d); });
  }
  for (const lane of lanes) {
    for (const n of lane.notes) {
      const { start, end } = n;
      if (inSpan(start)) riders.push((d) => { n.start = clamp(start + d); n.end = clamp(end + d); });
    }
    for (const g of Object.values(lane.refBoxes || {})) {
      const anchors = g?.anchors;
      if (Array.isArray(anchors) && inSpan(anchors[0])) riders.push((d) => { g.anchors = anchors.map((a) => a + d); });
    }
  }
  return riders;
}

// Called first from the stage mousedown. Only the flag (top rail) is a handle, so
// clicks below it fall through to the normal playhead/note editing. Drag a flag to
// move it, carrying its span along (see spanRiders) — the start flag drags the grid
// origin (offset); a plain click opens the editor. Set a marker's exact time in that editor instead.
export function markerMouseDown(e) {
  if (!S.state || e.button !== 0) return false;
  const [x, y] = toCanvas(e.clientX, e.clientY);
  if (y - scroll.scrollTop > MARK_H + 2) return false;    // only the flag rail grabs
  const hit = markerAt(x, y);
  if (!hit) return false;                                 // empty rail → fall through; dbl-click adds
  e.preventDefault();
  const seg = hit.seg;
  const grabDT = timeAt(x) - seg.t;
  const dragGrid = gridSegments().map(segment => ({ ...segment }));
  let moved = null;   // the pre-drag snapshot, taken lazily: a click must not pay for one
  let riders = null;  // (delta) => void, one per thing inside this tempo span: it moves with the flag
  // This flag's popover is open: the drag is that session typing into its
  // Position field — live readout, one undo step at close, revert still works.
  const viaPop = !markerPop.hidden && editSeg && (seg.seg0 ? editSeg.seg0 : editSeg.ref === seg.ref);
  const onMove = (ev) => {
    const [mx] = toCanvas(ev.clientX, ev.clientY);
    const nt = snap(timeAt(mx) - grabDT, dragGrid);
    if (viaPop) {
      moved = true;
      markerTime.value = Math.max(0, nt).toFixed(3);
      applyMarkerTime(); syncReverts();
      return;
    }
    if (!moved) {
      endPopEdit();             // another marker's open session ends before this edit
      moved = snapshotEdit();   // before the first write, so it captures the original time
      riders = spanRiders(seg);
    }
    if (seg.seg0)   // dragging the start flag moves the grid origin (the offset)
      offsetInput.value = Math.max(projectStart(S.state), Math.min(S.state.duration - 1e-3, nt)).toFixed(3);
    else
      seg.ref.t = Math.max(gridOffset() + 1e-3, Math.min(S.state.duration - 1e-3, nt));
    const delta = (seg.seg0 ? gridOffset() : seg.ref.t) - seg.t;
    for (const ride of riders) ride(delta);
    sectionMarkersChanged();
    draw();
  };
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (!moved) { openMarkerPop(ev.clientX, ev.clientY, seg); return; }   // a click (no drag) edits
    if (viaPop) { refreshTabIfOpen(); return; }   // the popover session commits when it closes
    // The notes already rode along, so the offset's own change handler (which
    // shifts every note in the song) must not run — just re-baseline it.
    if (seg.seg0) {
      S.appliedOffset = gridOffset();
      if (S.appliedGrid) S.appliedGrid.offset = S.appliedOffset;
    }
    commitStructure(moved); draw(); refreshTabIfOpen(); refreshSaveState();
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

export function openMarkerPop(clientX, clientY, seg, timing = S.state.liveTiming || SONG) {
  endPopEdit();   // opening a popover starts a session, so close whichever was open
  editTiming = timing;
  editSeg = seg;
  S.taps = [];
  document.getElementById("tapInfo").hidden = true;
  markerPopTitle.textContent = seg.seg0 ? "Tempo (start)" : "Tempo marker";
  markerBpm.value = String(seg.bpm);   // exact: applyPop reads it back
  markerTsNum.value = seg.tsNum;
  markerTsDen.value = seg.tsDen;
  setSubdivControls(markerSubdiv, markerSubdivCustom, markerSubdivCustomWrap, seg.subdiv || 1);
  markerTime.value = String(+seg.t.toFixed(3));   // exact seconds, not a rounded m:ss
  markerDeleteBtn.hidden = !!seg.seg0;   // the anchor can't be deleted (it's the base grid)
  markerPop.hidden = false;
  syncReverts();
  placeFloating(markerPop, clientX, clientY);
}

// Each field offers to go back to what it held when the popover opened. editSeg is
// that snapshot: edits land on editSeg.ref (or the grid inputs), never on editSeg.
const revertBtns = () => markerPop.querySelectorAll(".field-revert");
const popValues = {
  bpm: () => parseFloat(markerBpm.value),
  ts: () => `${parseInt(markerTsNum.value, 10)}/${parseInt(markerTsDen.value, 10)}`,
  subdiv: () => subdivValue(markerSubdiv, markerSubdivCustom),
  time: () => +(+markerTime.value).toFixed(3),
};
const origValues = (seg) => ({ bpm: seg.bpm, ts: `${seg.tsNum}/${seg.tsDen}`, subdiv: seg.subdiv || 1, time: +seg.t.toFixed(3) });
const origLabel = (seg, k) => ({ bpm: `${seg.bpm} BPM`, ts: `${seg.tsNum}/${seg.tsDen}`,
  subdiv: gridDivLabelFor(seg.subdiv || 1), time: `${+seg.t.toFixed(3)} s` })[k];

function syncReverts() {
  if (!editSeg) return;
  const orig = origValues(editSeg);
  for (const b of revertBtns()) {
    const k = b.dataset.revert;
    b.hidden = popValues[k]() === orig[k];
    b.title = `Revert to ${origLabel(editSeg, k)}`;
  }
}

function revertField(k) {
  if (!editSeg) return;
  const seg = editSeg;
  if (k === "bpm") markerBpm.value = String(seg.bpm);
  if (k === "ts") { markerTsNum.value = seg.tsNum; markerTsDen.value = seg.tsDen; }
  if (k === "subdiv") setSubdivControls(markerSubdiv, markerSubdivCustom, markerSubdivCustomWrap, seg.subdiv || 1);
  if (k === "time") { markerTime.value = String(+seg.t.toFixed(3)); applyMarkerTime(); }
  else applyPop();
  syncReverts();
}

/** Reopen the first marker when the walkthrough pages back to its settings. */
export function openFirstMarkerPop() {
  const seg = gridSegments()[0];
  if (!seg) return;
  const rect = firstMarkerViewportRect();
  const box = stage.getBoundingClientRect();
  openMarkerPop(rect?.left ?? box.left + 16, rect ? rect.top + rect.height : box.top + MARK_H, seg);
}

export function closeMarkerPop() {
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

// Set a marker's exact time from the popover — the same move as dragging its flag:
// what sits in its span rides along (spanRiders), live while typing. Every value
// is measured from where the session began, so "1" on the way to "1.5" is harmless.
function applyMarkerTime() {
  if (!editSeg) return;
  const t = parseFloat(markerTime.value);
  if (!Number.isFinite(t)) return;
  beginPopEdit();
  if (!popRiders) popRiders = spanRiders(editSeg);
  if (editSeg.seg0) {
    offsetInput.value = Math.max(projectStart(S.state), Math.min(S.state.duration - 1e-3, t)).toFixed(3);
    // The notes ride here, so the offset's own change handler (which shifts every
    // note in the song) must see nothing left to do.
    S.appliedOffset = gridOffset();
    if (S.appliedGrid) S.appliedGrid.offset = S.appliedOffset;
  } else {
    editSeg.ref.t = Math.max(gridOffset() + 1e-3, Math.min(S.state.duration - 1e-3, t));
  }
  const delta = (editSeg.seg0 ? gridOffset() : editSeg.ref.t) - editSeg.t;
  for (const ride of popRiders) ride(delta);
  sectionMarkersChanged();
  draw();
  refreshSaveState();
}

// DAW-style scrub: press on a number field and drag sideways to change it —
// 10 ms per pixel, 1 ms with Shift. A press without a drag still focuses it for typing.
function scrubField(input, apply, { step = 0.01, min = 0, max = Infinity, decimals = 3 } = {}) {
  input.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, v0 = parseFloat(input.value) || 0;
    let scrubbing = false;
    const onMove = (ev) => {
      if (!scrubbing) {
        if (Math.abs(ev.clientX - x0) < 3) return;
        scrubbing = true;
        input.blur();
        document.body.classList.add("scrubbing");
      }
      const v = Math.max(min, Math.min(max, v0 + (ev.clientX - x0) * step * (ev.shiftKey ? 0.1 : 1)));
      input.value = v.toFixed(decimals);
      apply();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("scrubbing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
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
  [markerBpm, markerTsNum, markerTsDen].forEach((el) => el.addEventListener("input", inEditTiming(applyPop)));
  markerSubdiv.addEventListener("change", inEditTiming(() => { syncSubdivControls(markerSubdiv, markerSubdivCustom, markerSubdivCustomWrap); applyPop(); }));
  markerSubdivCustom.addEventListener("input", inEditTiming(applyPop));
  markerTime.addEventListener("input", inEditTiming(applyMarkerTime));
  scrubField(markerTime, inEditTiming(() => { applyMarkerTime(); syncReverts(); }));
  scrubField(markerBpm, inEditTiming(() => { applyPop(); syncReverts(); }),
    { step: 0.1, min: 20, max: 320, decimals: 2 });
  markerPop.addEventListener("input", syncReverts);
  markerPop.addEventListener("change", syncReverts);
  for (const b of revertBtns()) b.addEventListener("click", inEditTiming((e) => { e.preventDefault(); revertField(b.dataset.revert); }));
  markerDeleteBtn.addEventListener("click", inEditTiming(() => { if (editSeg && editSeg.ref) { beginPopEdit(); removeMarker(editSeg.ref); closeMarkerPop(); draw(); refreshSaveState(); } }));
  markerPopClose.addEventListener("click", closeMarkerPop);
  // Undo replaced S.state.tempoMap, so editSeg.ref points at an object no longer
  // in it. Drop the session without committing and shut the popover.
  window.addEventListener(STATE_RESTORED, () => { popSnapshot = popRiders = null; closeMarkerPop(); });
  // Marker editors stay open until their close button is pressed.
}
