import { paintMarkerFlag } from "./canvas-components.js";
import { placeFloating } from "./floating-position.js";
// Per-lane amp tone switches. A marker selects a preset from its time
// onward; the next marker replaces it. They are audio-time annotations, snapped
// to the current beat grid like phrase boundaries.

import { stageUi } from "./constants.js";
import { inTourCard, mmctx, scroll, sctx, stage, toneMarkerDelete, toneMarkerPop, toneMarkerPopClose, toneMarkerPreset, toneMarkerTime } from "./dom.js";
import { draw } from "./repaint.js";
import { timeAt, xOf } from "./geometry.js";
import { snap } from "./grid.js";
import { inRailBand, railBand, registerLaneField, registerMarkerRail } from "./marker-rails.js";
import { refreshSaveState } from "./project.js";
import { PAINT } from "./stage-paint.js";
import { INTERNAL_TONE_PRESETS, normalizeToneMarkers, tonePresetLabel } from "./tone-marker-core.js";
import { S } from "./store.js";

const TONE_MARK_H = 22;
const bandY = () => railBand("tone").y;
const inBand = (localY) => inRailBand("tone", localY);

let markerRects = [];
let editMarker = null;

function activeToneLane() {
  const lanes = S.state?.editLanes || [];
  return lanes.find((lane) => lane.active) || lanes[0] || null;
}

function markers(lane = activeToneLane()) {
  if (!lane) return [];
  if (!lane.toneMarkers) lane.toneMarkers = [];
  return lane.toneMarkers;
}

function toCanvas(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  return [clientX - rect.left + scroll.scrollLeft, clientY - rect.top + scroll.scrollTop];
}

export function snapToneTime(value) {
  const duration = Number(S.state?.duration) || Number(S.state?.scoreDuration) || Infinity;
  return Math.max(0, Math.min(duration, snap(Number(value) || 0)));
}

function changed(lane = activeToneLane()) {
  if (!lane) return;
  const editingId = editMarker?.id;
  lane.toneMarkers = normalizeToneMarkers(markers(lane),
    Number(S.state?.duration) || Number(S.state?.scoreDuration) || Infinity);
  if (editingId) editMarker = lane.toneMarkers.find((marker) => marker.id === editingId) || null;
  refreshSaveState();
  draw();
}

function openToneMarkerPop(clientX, clientY, marker) {
  editMarker = marker;
  toneMarkerPreset.value = marker.tone;
  toneMarkerTime.value = String(+Number(marker.t).toFixed(3));
  toneMarkerPop.hidden = false;
  placeFloating(toneMarkerPop, clientX, clientY);
  toneMarkerPreset.focus();
}

export function closeToneMarkerPop() {
  toneMarkerPop.hidden = true;
  editMarker = null;
}

export function addToneMarkerAtTime(time, clientX, clientY) {
  if (!S.state || !Number.isFinite(Number(time))) return;
  const lane = activeToneLane();
  if (!lane) return;
  const snapped = snapToneTime(time);
  const existing = markers(lane).find((marker) => Math.abs(Number(marker.t) - snapped) < 1e-5);
  if (existing) return openToneMarkerPop(clientX, clientY, existing);
  const marker = {
    id: `tone_${Date.now()}_${Math.round(snapped * 1000)}`,
    t: snapped,
    tone: String(lane.instrument || "").toLowerCase().includes("bass") ? "bass" : "lead",
  };
  markers(lane).push(marker);
  changed(lane);
  openToneMarkerPop(clientX, clientY, lane.toneMarkers.find((item) => item.id === marker.id) || marker);
}

function applyPreset() {
  if (!editMarker) return;
  editMarker.tone = toneMarkerPreset.value;
  changed();
}

function applyTime() {
  if (!editMarker) return;
  const lane = activeToneLane();
  editMarker.t = snapToneTime(toneMarkerTime.value);
  toneMarkerTime.value = String(+editMarker.t.toFixed(3));
  changed(lane);
}

function markerAt(x, y) {
  return markerRects.find((rect) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) || null;
}

export function toneMarkerCursorAt(x, y) {
  if (!S.state || !inBand(y - scroll.scrollTop)) return null;
  return markerAt(x, y) ? "grab" : null;
}

export function toneMarkerMouseDown(event) {
  if (!S.state || event.button !== 0) return false;
  const [x, y] = toCanvas(event.clientX, event.clientY);
  if (!inBand(y - scroll.scrollTop)) return false;
  const hit = markerAt(x, y);
  if (!hit) return false;
  event.preventDefault();
  const { marker, lane } = hit;
  const grabDelta = timeAt(x) - Number(marker.t);
  let moved = false;
  const onMove = (moveEvent) => {
    const [moveX] = toCanvas(moveEvent.clientX, moveEvent.clientY);
    marker.t = snapToneTime(timeAt(moveX) - grabDelta);
    moved = true;
    draw();
  };
  const onUp = (upEvent) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (moved) changed(lane);
    else openToneMarkerPop(upEvent.clientX, upEvent.clientY, marker);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return true;
}

export function drawToneMarkers() {
  markerRects = [];
  if (!S.state) return;
  const lane = activeToneLane();
  if (!lane) return;
  const top = scroll.scrollTop + bandY();
  const left = scroll.scrollLeft, right = left + scroll.clientWidth;
  sctx.save();
  for (const normalized of normalizeToneMarkers(markers(lane))) {
    const marker = markers(lane).find((item) => item.id === normalized.id) || normalized;
    const x = xOf(normalized.t), text = tonePresetLabel(normalized.tone);
    // 11/700, the same as every other flag: three rails were drawing at 9, 10
    // and 11, all three in a font the app stopped loading in pass 1.
    sctx.font = stageUi(11, 600);
    const width = Math.max(52, Math.ceil(sctx.measureText(text).width) + 18);
    const rect = { marker, lane, x0: x, x1: x + width, y0: top + 2, y1: top + TONE_MARK_H - 2 };
    markerRects.push(rect);
    if (rect.x0 > right || rect.x1 < left) continue;
    paintMarkerFlag(sctx, rect, PAINT.tone);
    sctx.fillStyle = PAINT.text; sctx.textBaseline = "middle";
    sctx.fillText(text, x + 9, top + TONE_MARK_H / 2);
  }
  sctx.restore();
}

export function drawMinimapToneMarkers(scale) {
  const lane = activeToneLane();
  if (!S.state || !lane) return;
  for (const marker of normalizeToneMarkers(markers(lane))) {
    const x = xOf(marker.t) * scale;
    mmctx.fillStyle = PAINT.tone;
    mmctx.fillRect(x - 1, 26, 3, 8);
  }
}

export function init_tone_markers() {
  registerMarkerRail({
    id: "tone",
    height: TONE_MARK_H,
    count: () => (activeToneLane()?.toneMarkers || []).length,
    draw: drawToneMarkers,
    drawMinimap: drawMinimapToneMarkers,
    cursorAt: toneMarkerCursorAt,
    mouseDown: toneMarkerMouseDown,
    menuLabel: "Add tone switch",
    addAt: addToneMarkerAtTime,
  });
  registerLaneField("toneMarkers", { normalize: normalizeToneMarkers });
  for (const [key, label] of INTERNAL_TONE_PRESETS) toneMarkerPreset.append(new Option(label, key));
  toneMarkerPreset.addEventListener("change", applyPreset);
  toneMarkerTime.addEventListener("change", applyTime);
  toneMarkerDelete.addEventListener("click", () => {
    if (!editMarker) return;
    const lane = activeToneLane();
    if (!lane) return;
    lane.toneMarkers = markers(lane).filter((marker) => marker !== editMarker);
    closeToneMarkerPop();
    changed(lane);
  });
  toneMarkerPopClose.addEventListener("click", closeToneMarkerPop);
  stage.addEventListener("dblclick", (event) => {
    if (!S.state) return;
    const [x, y] = toCanvas(event.clientX, event.clientY);
    if (!inBand(y - scroll.scrollTop) || markerAt(x, y)) return;
    addToneMarkerAtTime(timeAt(x), event.clientX, event.clientY);
  });
  // Marker editors stay open until their close button is pressed.
}
