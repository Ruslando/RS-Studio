import { paintMarkerFlag, paintWarningSymbol } from "./canvas-components.js";
import { placeFloating } from "./floating-position.js";
// Per-lane amp tone switches. A marker selects a preset from its time
// onward; the next marker replaces it. They are audio-time annotations, snapped
// to the current beat grid like phrase boundaries.

import { stageUi } from "./constants.js";
import { inTourCard, mmctx as minimapCtx, scroll, sctx, stage, toneMarkerDelete, toneMarkerPop, toneMarkerPopClose, toneMarkerPreset, toneMarkerTime } from "./dom.js";
import { draw } from "./repaint.js";
import { STATE_RESTORED } from "./edit.js";
import { timeAt, xOf } from "./geometry.js";
import { snap } from "./grid.js";
import { inRailBand, railBand, registerLaneField, registerMarkerRail } from "./marker-rails.js";
import { refreshSaveState } from "./project.js";
import { toast } from "./notify.js";
import { PAINT } from "./stage-paint.js";
import { normalizeToneMarkers, startTone, tonePresetLabel, tonePresetMissing } from "./tone-marker-core.js";
import { S } from "./store.js";
import { timingIdOf, withTiming } from "./timing.js";
import { readAvailableSoundPresets } from "./sound-presets-core.js";

const TONE_MARK_H = 22;
const bandY = () => railBand("tone").y;
const inBand = (localY) => inRailBand("tone", localY);

let markerRects = [];
let editMarker = null;
let editLaneId = null;
const editingLane = () => S.state?.editLanes.find(lane => lane.id === editLaneId);

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

export function openToneMarkerPop(clientX, clientY, marker, lane = activeToneLane()) {
  editLaneId = lane?.id;
  editMarker = marker;
  refreshPresetOptions(marker);
  toneMarkerPreset.value = marker.tone;
  toneMarkerTime.value = String(+Number(marker.t).toFixed(3));
  toneMarkerPop.hidden = false;
  placeFloating(toneMarkerPop, clientX, clientY);
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
    tone: startTone(lane) || "",
  };
  const preset = readAvailableSoundPresets().find(entry => entry.id === marker.tone);
  if (!preset) {
    toast("No tone presets are available. Add a preset in Settings > Tone presets.", 6000, "warn");
    return;
  }
  markers(lane).push(marker);
  changed(lane);
  openToneMarkerPop(clientX, clientY, lane.toneMarkers.find((item) => item.id === marker.id) || marker);
}

function applyPreset() {
  if (!editMarker) return;
  editMarker.tone = toneMarkerPreset.value;
  const preset = readAvailableSoundPresets().find(entry => entry.id === editMarker.tone);
  if (preset) delete editMarker.toneData;
  changed(editingLane());
}

function applyTime() {
  if (!editMarker) return;
  const lane = editingLane();
  if (!lane) return;
  editMarker.t = withTiming(timingIdOf(lane), () => snapToneTime(toneMarkerTime.value));
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
  const presets = readAvailableSoundPresets();
  sctx.save();
  for (const normalized of normalizeToneMarkers(markers(lane))) {
    const marker = markers(lane).find((item) => item.id === normalized.id) || normalized;
    const x = xOf(normalized.t), text = tonePresetLabel(normalized.tone, normalized.toneData, presets);
    const missing = tonePresetMissing(normalized.tone, presets, normalized.toneData);
    // 11/700, the same as every other flag: three rails were drawing at 9, 10
    // and 11, all three in a font the app stopped loading in pass 1.
    sctx.font = stageUi(11, 600);
    const width = Math.max(52, Math.ceil(sctx.measureText(text).width) + 18 + (missing ? 14 : 0));
    const rect = { marker, lane, x0: x, x1: x + width, y0: top + 2, y1: top + TONE_MARK_H - 2 };
    markerRects.push(rect);
    if (rect.x0 > right || rect.x1 < left) continue;
    paintMarkerFlag(sctx, rect, PAINT.tone);
    if (missing) paintWarningSymbol(sctx, x + 7, top + 6, 10);
    sctx.fillStyle = PAINT.text; sctx.textBaseline = "middle";
    sctx.fillText(text, x + 9 + (missing ? 14 : 0), top + TONE_MARK_H / 2);
  }
  sctx.restore();
}

export function drawMinimapToneMarkers(at, mmctx = minimapCtx) {
  const lane = activeToneLane();
  if (!S.state || !lane) return;
  const presets = readAvailableSoundPresets();
  for (const marker of normalizeToneMarkers(markers(lane))) {
    const x = at(marker.t);
    mmctx.fillStyle = tonePresetMissing(marker.tone, presets, marker.toneData) ? PAINT.warn : PAINT.tone;
    mmctx.fillRect(x - 1, 26, 3, 8);
  }
}

function refreshPresetOptions(marker = editMarker) {
  toneMarkerPreset.replaceChildren();
  const presets = readAvailableSoundPresets();
  const missing = marker && tonePresetMissing(marker.tone, presets, marker.toneData);
  const current = presets.find(preset => preset.id === marker?.tone);
  const editButton = document.getElementById('toneMarkerEditPreset');
  editButton.disabled = !current && !marker?.toneData;
  editButton.title = editButton.disabled ? 'Choose an available preset first' : 'Open Tone Designer';
  if (missing) {
    const option = new Option(`\u26a0 Missing preset: ${tonePresetLabel(marker.tone, marker.toneData)}`, marker.tone);
    option.disabled = true;
    toneMarkerPreset.append(option);
  } else if (marker?.toneData && !current) {
    toneMarkerPreset.append(new Option(marker.toneData.Name, marker.tone));
  }
  for (const preset of presets) toneMarkerPreset.append(new Option(preset.tone.Name, preset.id));
  if (marker) toneMarkerPreset.value = marker.tone;
}

export function init_tone_markers() {
  document.getElementById('toneMarkerEditPreset').addEventListener('click', () => {
    const lane = editingLane();
    if (!lane || !editMarker) return;
    const detail = { laneId: lane.id, markerId: editMarker.id };
    closeToneMarkerPop();
    window.dispatchEvent(new CustomEvent('cw-open-tone-designer', { detail }));
  });
  window.addEventListener(STATE_RESTORED, closeToneMarkerPop);   // undo replaced the marker it holds
  window.addEventListener("cw-project-opened", closeToneMarkerPop);
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
  refreshPresetOptions();
  window.addEventListener("sound-presets-changed", () => { refreshPresetOptions(); draw(); });
  toneMarkerPreset.addEventListener("change", () => {
    applyPreset(); refreshPresetOptions();
  });
  toneMarkerTime.addEventListener("change", applyTime);
  toneMarkerDelete.addEventListener("click", () => {
    if (!editMarker) return;
    const lane = editingLane();
    if (!lane) return;
    lane.toneMarkers = markers(lane).filter((marker) => marker !== editMarker);
    closeToneMarkerPop();
    changed(lane);
  });
  toneMarkerPopClose.addEventListener("click", closeToneMarkerPop);

  // Marker editors stay open until their close button is pressed.
}
