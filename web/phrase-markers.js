import { paintMarkerFlag } from "./canvas-components.js";
import { placeFloating } from "./floating-position.js";
// Per-layer practice-phrase boundaries. These subdivide the global song
// sections for exporters that model repeatable practice phrases; Guitar Pro has
// no equivalent and intentionally ignores them.

import { stageUi } from "./constants.js";
import { inTourCard, mmctx, phraseMarkerDelete, phraseMarkerPop, phraseMarkerPopClose, phraseMarkerTime, scroll, sctx, stage } from "./dom.js";
import { draw } from "./repaint.js";
import { timeAt, xOf } from "./geometry.js";
import { gridSegments, segBeatSec } from "./grid.js";
import { inRailBand, railBand, registerLaneField, registerMarkerRail } from "./marker-rails.js";
import { refreshSaveState } from "./project.js";
import { beatStartsFromScoreBars, normalizePhraseBoundaries } from "./section-marker-core.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";

const PHRASE_MARK_H = 22;
const bandY = () => railBand("phrase").y;
const inBand = (localY) => inRailBand("phrase", localY);

let markerRects = [];
let editBoundary = null;

function activePhraseLane() {
  const lanes = S.state?.editLanes || [];
  return lanes.find((lane) => lane.active) || lanes[0] || null;
}

function boundaries(lane = activePhraseLane()) {
  if (!lane) return [];
  if (!lane.phraseBoundaries) lane.phraseBoundaries = [];
  return lane.phraseBoundaries;
}

function toCanvas(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  return [
    clientX - rect.left + scroll.scrollLeft,
    clientY - rect.top + scroll.scrollTop,
  ];
}

function changed(lane = activePhraseLane()) {
  if (!lane) return;
  const editingId = editBoundary?.id;
  lane.phraseBoundaries = normalizePhraseBoundaries(boundaries(lane),
    Number(S.state.duration) || Number(S.state.scoreDuration) || Infinity);
  // normalize replaces the array, so the open popover is holding an object that
  // is no longer in it — the same re-find the tone rail does.
  if (editingId) editBoundary = lane.phraseBoundaries.find((item) => item.id === editingId) || null;
  refreshSaveState();
  draw();
}

function openPhraseMarkerPop(clientX, clientY, boundary) {
  editBoundary = boundary;
  phraseMarkerTime.value = String(+Number(boundary.t).toFixed(3));
  phraseMarkerPop.hidden = false;
  placeFloating(phraseMarkerPop, clientX, clientY);
  phraseMarkerTime.focus();
}

export function closePhraseMarkerPop() {
  phraseMarkerPop.hidden = true;
  editBoundary = null;
}

function applyTime() {
  if (!editBoundary) return;
  const lane = activePhraseLane();
  editBoundary.t = snapPhraseTime(phraseMarkerTime.value);
  phraseMarkerTime.value = String(+editBoundary.t.toFixed(3));
  changed(lane);
}

function phraseBeatStarts() {
  const duration = Math.max(0,
    Number(S.state?.duration) || Number(S.state?.scoreDuration) || 0);
  const bars = S.state?.scoreBars || [];
  if (bars.length) return beatStartsFromScoreBars(bars);
  const starts = [];
  const segments = gridSegments();
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const end = segments[index + 1]?.t ?? duration;
    const step = segBeatSec(segment);
    if (!(step > 0)) continue;
    for (let time = segment.t, guard = 0;
      time < end - 1e-5 && time <= duration + 1e-5 && guard++ < 100000;
      time += step) starts.push(Math.max(0, time));
  }
  return starts;
}

export function snapPhraseTime(value) {
  const duration = Number(S.state?.duration) || Number(S.state?.scoreDuration) || Infinity;
  const time = Math.max(0, Math.min(duration, Number(value) || 0));
  const starts = phraseBeatStarts();
  if (!starts.length) return time;
  return starts.reduce((best, candidate) =>
    Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best, starts[0]);
}

export function addPhraseBoundaryAtTime(time, clientX, clientY) {
  if (!S.state || !Number.isFinite(Number(time))) return;
  const lane = activePhraseLane();
  if (!lane) return;
  const snapped = snapPhraseTime(time);
  const existing = boundaries(lane).find((boundary) =>
    Math.abs(Number(boundary.t) - snapped) < 1e-5);
  if (existing) return openPhraseMarkerPop(clientX, clientY, existing);
  const boundary = {
    id: `phrase_${Date.now()}_${Math.round(snapped * 1000)}`,
    t: snapped,
  };
  boundaries(lane).push(boundary);
  changed(lane);
  openPhraseMarkerPop(clientX, clientY,
    boundaries(lane).find((item) => item.id === boundary.id) || boundary);
}

function markerAt(x, y) {
  return markerRects.find((rect) =>
    x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) || null;
}

export function phraseMarkerCursorAt(x, y) {
  if (!S.state || !inBand(y - scroll.scrollTop)) return null;
  return markerAt(x, y) ? "grab" : null;
}

export function phraseMarkerMouseDown(event) {
  if (!S.state || event.button !== 0) return false;
  const [x, y] = toCanvas(event.clientX, event.clientY);
  if (!inBand(y - scroll.scrollTop)) return false;
  const hit = markerAt(x, y);
  if (!hit) return false;
  event.preventDefault();
  const { boundary, lane } = hit;
  const grabDelta = timeAt(x) - Number(boundary.t);
  let moved = false;
  const onMove = (moveEvent) => {
    const [moveX] = toCanvas(moveEvent.clientX, moveEvent.clientY);
    boundary.t = snapPhraseTime(timeAt(moveX) - grabDelta);
    moved = true;
    draw();
  };
  const onUp = (upEvent) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (moved) changed(lane);
    else openPhraseMarkerPop(upEvent.clientX, upEvent.clientY, boundary);   // a click (no drag) edits
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return true;
}

export function drawPhraseMarkers() {
  markerRects = [];
  if (!S.state) return;
  const lane = activePhraseLane();
  if (!lane) return;
  const top = scroll.scrollTop + bandY();
  const left = scroll.scrollLeft;
  const right = left + scroll.clientWidth;
  sctx.save();
  for (const normalized of normalizePhraseBoundaries(boundaries(lane))) {
    const boundary = boundaries(lane).find((item) => item.id === normalized.id) || normalized;
    const x = xOf(normalized.t);
    // A flag floats free of any note, so 11, and the same 700 the section rail
    // uses: it is the only text on its chip and has nothing to be quieter than.
    // The width is measured, not the 58 that used to be assumed — rule 13, and
    // the reason "Phrase" sat left in its pill while "Crunch" looked centred.
    sctx.font = stageUi(11, 600);
    const width = Math.max(52, Math.ceil(sctx.measureText("Phrase").width) + 18);
    const rect = {
      boundary, lane, x0: x, x1: x + width,
      y0: top + 2, y1: top + PHRASE_MARK_H - 2,
    };
    markerRects.push(rect);
    if (rect.x0 > right || rect.x1 < left) continue;
    paintMarkerFlag(sctx, rect, PAINT.phrase);
    sctx.fillStyle = PAINT.text;
    sctx.textBaseline = "middle";
    sctx.fillText("Phrase", x + 9, top + PHRASE_MARK_H / 2);
  }
  sctx.restore();
}

export function drawMinimapPhraseMarkers(scale) {
  if (!S.state) return;
  const lane = activePhraseLane();
  if (!lane) return;
  for (const boundary of normalizePhraseBoundaries(boundaries(lane))) {
    const x = xOf(boundary.t) * scale;
    mmctx.fillStyle = PAINT.phrase;
    mmctx.fillRect(x - 1, 15, 3, 9);
  }
}

export function init_phrase_markers() {
  registerMarkerRail({
    id: "phrase",
    height: PHRASE_MARK_H,
    count: () => (activePhraseLane()?.phraseBoundaries || []).length,
    draw: drawPhraseMarkers,
    drawMinimap: drawMinimapPhraseMarkers,
    cursorAt: phraseMarkerCursorAt,
    mouseDown: phraseMarkerMouseDown,
    menuLabel: "Add phrase boundary",
    addAt: addPhraseBoundaryAtTime,
  });
  // `practiceBoundaries` is the pre-rename key; the alias belongs to this
  // feature, not to core's persistence code.
  registerLaneField("phraseBoundaries", {
    normalize: normalizePhraseBoundaries,
    aliases: ["practiceBoundaries"],
  });
  phraseMarkerTime.addEventListener("change", applyTime);
  // Deleting was a double-click on the flag, which is not a thing the app does
  // anywhere else and which nothing on screen said. It is the popover's bin now,
  // where the section and tone rails keep theirs.
  phraseMarkerDelete.addEventListener("click", () => {
    if (!editBoundary) return;
    const lane = activePhraseLane();
    if (!lane) return;
    lane.phraseBoundaries = boundaries(lane).filter((boundary) => boundary !== editBoundary);
    closePhraseMarkerPop();
    changed(lane);
  });
  phraseMarkerPopClose.addEventListener("click", closePhraseMarkerPop);
  stage.addEventListener("dblclick", (event) => {
    if (!S.state) return;
    const [x, y] = toCanvas(event.clientX, event.clientY);
    if (!inBand(y - scroll.scrollTop) || markerAt(x, y)) return;
    addPhraseBoundaryAtTime(timeAt(x), event.clientX, event.clientY);
  });
  // Marker editors stay open until their close button is pressed.
}
