import { paintMarkerFlag } from "./canvas-components.js";
import { placeFloating } from "./floating-position.js";
// Standalone song-section flags. Unlike tempo/meter markers, moving one never
// retimes the grid or notes: it is an audio-time annotation that snaps to the
// nearest current score-bar boundary.

import { inTourCard, mmctx, scroll, sctx, sectionMarkerDelete, sectionMarkerHelpIcon, sectionMarkerKind, sectionMarkerName, sectionMarkerNameWrap, sectionMarkerPop, sectionMarkerPopClose, sectionMarkerTime, sectionMarkerType, sectionMarkerTypeWrap, stage } from "./dom.js";
import { stageUi } from "./constants.js";
import { draw } from "./repaint.js";
import { STATE_RESTORED, commitStructure, snapshotEdit } from "./edit.js";
import { timeAt, xOf } from "./geometry.js";
import { songBarStarts } from "./song-bars.js";
import { MARK_H } from "./markers.js";
import { inRailBand, railBand, registerMarkerRail, setRailOrigin } from "./marker-rails.js";
import { refreshSaveState } from "./project.js";
import {
  SECTION_GROUPS, SECTION_HELP, normalizeSectionMarkers, sectionTypeLabel,
  validSectionType,
} from "./section-marker-core.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";

const SECTION_MARK_H = 25;
const bandY = () => railBand("section").y;
const inBand = (localY) => inRailBand("section", localY);

let markerRects = [];
let editMarker = null;
const commonSectionTypes = new Set(
  SECTION_GROUPS.flatMap(([, entries]) => entries.map(([value]) => value)));

// Editing a marker in the popover is a session, not a keystroke: typing a custom
// name fires an input event per character, and all of them are one Ctrl+Z. Take
// the snapshot before the session's first mutation and commit it when the
// popover closes. When *undo* is what closed it, the STATE_RESTORED listener
// clears popSnapshot first — committing there would push the very state being
// reverted back onto the stack.
let popSnapshot = null;
const beginPopEdit = () => { if (!popSnapshot) popSnapshot = snapshotEdit(); };
const endPopEdit = () => { const prev = popSnapshot; popSnapshot = null; if (prev) commitStructure(prev); };

function sectionMarkers() {
  if (!S.state.sectionMarkers) S.state.sectionMarkers = [];
  return S.state.sectionMarkers;
}

function toCanvas(cx, cy) {
  const rect = stage.getBoundingClientRect();
  return [cx - rect.left + scroll.scrollLeft, cy - rect.top + scroll.scrollTop];
}

function snapSectionTime(value) {
  const time = Math.max(0, Math.min(Number(S.state?.duration) || Number(S.state?.scoreDuration) || Infinity,
    Number(value) || 0));
  const starts = songBarStarts();
  if (!starts.length) return time;
  return starts.reduce((best, candidate) =>
    Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best, starts[0]);
}

function changed() {
  markersChanged();
  const editingId = editMarker?.id;
  S.state.sectionMarkers = normalizeSectionMarkers(sectionMarkers(),
    Number(S.state.duration) || Number(S.state.scoreDuration) || Infinity);
  if (editingId) editMarker = S.state.sectionMarkers.find((marker) => marker.id === editingId) || null;
  refreshSaveState();
  draw();
}

function kindIsCustom() { return sectionMarkerKind.value === "custom"; }

function syncCustomFields() {
  const custom = kindIsCustom();
  sectionMarkerNameWrap.hidden = !custom;
  sectionMarkerTypeWrap.hidden = !custom;
}

function syncSectionHelp() {
  const type = validSectionType(kindIsCustom() ? sectionMarkerType.value : sectionMarkerKind.value);
  const help = SECTION_HELP[type] || SECTION_HELP.riff;
  sectionMarkerHelpIcon.title = help;
}

function markerText(marker) {
  return marker.text || sectionTypeLabel(marker.sectionType);
}

function ensureImportedTypeOption(select, type) {
  if (commonSectionTypes.has(type) || [...select.options].some((option) => option.value === type)) return;
  const option = new Option(`${sectionTypeLabel(type)} (imported)`, type);
  option.title = SECTION_HELP[type] || "";
  select.append(option);
}

function openSectionMarkerPop(clientX, clientY, marker) {
  endPopEdit();   // opening a popover starts a session, so close whichever was open
  editMarker = marker;
  const type = validSectionType(marker.sectionType || marker.text);
  ensureImportedTypeOption(sectionMarkerKind, type);
  ensureImportedTypeOption(sectionMarkerType, type);
  const builtIn = !marker.custom;
  sectionMarkerKind.value = builtIn ? type : "custom";
  sectionMarkerName.value = markerText(marker);
  sectionMarkerType.value = validSectionType(marker.sectionType);
  sectionMarkerTime.value = String(+Number(marker.t).toFixed(3));
  syncCustomFields();
  syncSectionHelp();
  sectionMarkerPop.hidden = false;
  placeFloating(sectionMarkerPop, clientX, clientY);
  (kindIsCustom() ? sectionMarkerName : sectionMarkerKind).focus();
}

function closeSectionMarkerPop() {
  sectionMarkerPop.hidden = true;
  editMarker = null;
  endPopEdit();
}

function addSectionMarkerAtTime(time, clientX, clientY) {
  if (!S.state || !Number.isFinite(Number(time))) return;
  const snapped = snapSectionTime(time);
  const existing = sectionMarkers().find((marker) => Math.abs(Number(marker.t) - snapped) < 1e-5);
  if (existing) {
    openSectionMarkerPop(clientX, clientY, existing);
    return;
  }
  const prev = snapshotEdit();
  const type = sectionMarkers().length ? "riff" : "intro";
  const marker = {
    id: `section_${Date.now()}_${Math.round(snapped * 1000)}`,
    t: snapped,
    text: sectionTypeLabel(type),
    marker: "",
    sectionType: type,
    custom: false,
  };
  sectionMarkers().push(marker);
  markersChanged();
  commitStructure(prev);   // the add is its own step; the popover edits are the next
  changed();
  openSectionMarkerPop(clientX, clientY,
    sectionMarkers().find((item) => item.id === marker.id) || marker);
}

function applyFields() {
  if (!editMarker) return;
  const custom = kindIsCustom();
  const type = validSectionType(custom ? sectionMarkerType.value : sectionMarkerKind.value);
  const text = custom ? sectionMarkerName.value.trim() : sectionTypeLabel(type);
  if (!text) return;
  beginPopEdit();
  editMarker.text = text;
  editMarker.marker = custom ? editMarker.marker || text : text;
  editMarker.sectionType = type;
  editMarker.custom = custom;
  changed();
}

function applyTime() {
  if (!editMarker) return;
  beginPopEdit();
  editMarker.t = snapSectionTime(sectionMarkerTime.value);
  sectionMarkerTime.value = String(+editMarker.t.toFixed(3));
  changed();
}

function markerAt(x, y) {
  return markerRects.find((rect) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) || null;
}

function sectionMarkerCursorAt(x, y) {
  if (!S.state || !inBand(y - scroll.scrollTop)) return null;
  return markerAt(x, y) ? "grab" : null;
}

function sectionMarkerMouseDown(event) {
  if (!S.state || event.button !== 0) return false;
  const [x, y] = toCanvas(event.clientX, event.clientY);
  if (!inBand(y - scroll.scrollTop)) return false;
  const hit = markerAt(x, y);
  if (!hit) return false;
  event.preventDefault();
  const marker = hit.marker, grabDelta = timeAt(x) - Number(marker.t);
  let moved = null;   // the pre-drag snapshot, taken lazily: a click must not pay for one
  const onMove = (moveEvent) => {
    if (!moved) moved = snapshotEdit();   // before the first write, so it captures the original time
    const [moveX] = toCanvas(moveEvent.clientX, moveEvent.clientY);
    marker.t = snapSectionTime(timeAt(moveX) - grabDelta);
    markersChanged();
    draw();
  };
  const onUp = (upEvent) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (moved) { commitStructure(moved); changed(); }   // one undo entry for the whole drag
    else openSectionMarkerPop(upEvent.clientX, upEvent.clientY, marker);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return true;
}

// normalizeSectionMarkers allocates, runs a regex per marker and sorts. Both
// draw paths called it every frame, and one then did a linear `find` per marker
// to map the normalized copy back to the live object — O(n^2) on a path that
// runs on every mousemove of a marker drag.
//
// Invalidated explicitly rather than keyed on a revision counter: a drag mutates
// `marker.t` in place without going through changed(), so nothing else in the
// app would know. Every mutation site in this file calls markersChanged(); if
// you add one, call it there too or the rail draws the old positions.
let normalizedCache = null;
const markersChanged = () => { normalizedCache = null; };

function normalizedMarkers() {
  if (normalizedCache) return normalizedCache;
  const live = sectionMarkers();
  normalizedCache = {
    list: normalizeSectionMarkers(live),
    byId: new Map(live.map((marker) => [marker.id, marker])),
  };
  return normalizedCache;
}

function drawSectionMarkers() {
  markerRects = [];
  if (!S.state) return;
  const top = scroll.scrollTop + bandY();
  const left = scroll.scrollLeft, right = left + scroll.clientWidth;
  sctx.save();
  const { list, byId } = normalizedMarkers();
  for (const marker of list) {
    const x = xOf(marker.t), text = markerText(marker);
    // A flag floats free of any note, so 11. "Verse 2" is a name, not a value.
    // 700 stays: unlike the tempo card's label this is the only text on its chip,
    // so it has nothing to be quieter than.
    sctx.font = stageUi(11, 600);
    const width = Math.max(52, Math.ceil(sctx.measureText(text).width) + 18);
    const rect = { marker: byId.get(marker.id) || marker,
      x0: x, x1: x + width, y0: top + 2, y1: top + SECTION_MARK_H - 2 };
    markerRects.push(rect);
    if (rect.x0 > right || rect.x1 < left) continue;
    paintMarkerFlag(sctx, rect, PAINT.section);
    sctx.fillStyle = PAINT.text; sctx.textBaseline = "middle";
    sctx.fillText(text, x + 9, top + SECTION_MARK_H / 2);
  }
  sctx.restore();
}

function drawMinimapSectionMarkers(scale) {
  if (!S.state) return;
  for (const marker of normalizedMarkers().list) {
    const x = xOf(marker.t) * scale;
    mmctx.fillStyle = PAINT.section;
    mmctx.beginPath();
    mmctx.moveTo(x - 4, 13); mmctx.lineTo(x + 4, 13); mmctx.lineTo(x, 3); mmctx.closePath();
    mmctx.fill();
  }
}

export function init_section_markers() {
  // The rail stack begins below the tempo/meter flag strip.
  setRailOrigin(MARK_H);
  registerMarkerRail({
    id: "section",
    height: SECTION_MARK_H,
    count: () => (S.state?.sectionMarkers || []).length,
    draw: drawSectionMarkers,
    drawMinimap: drawMinimapSectionMarkers,
    cursorAt: sectionMarkerCursorAt,
    mouseDown: sectionMarkerMouseDown,
    menuLabel: "Add section marker",
    addAt: addSectionMarkerAtTime,
  });
  for (const [groupLabel, entries] of SECTION_GROUPS) {
    const kindGroup = document.createElement("optgroup");
    const typeGroup = document.createElement("optgroup");
    kindGroup.label = groupLabel;
    typeGroup.label = groupLabel;
    for (const [value, label] of entries) {
      const kindOption = new Option(label, value), typeOption = new Option(label, value);
      kindOption.title = SECTION_HELP[value] || "";
      typeOption.title = SECTION_HELP[value] || "";
      kindGroup.append(kindOption);
      typeGroup.append(typeOption);
    }
    sectionMarkerKind.append(kindGroup);
    sectionMarkerType.append(typeGroup);
  }
  sectionMarkerKind.append(new Option("Custom…", "custom"));
  sectionMarkerKind.addEventListener("change", () => { syncCustomFields(); syncSectionHelp(); applyFields(); });
  // `change`, not `input`: applyFields normalizes every marker in the project
  // and repaints the canvas, which is not something to do per keystroke.
  // syncSectionHelp on input keeps the help text live, and it is cheap.
  sectionMarkerName.addEventListener("input", syncSectionHelp);
  sectionMarkerName.addEventListener("change", applyFields);
  sectionMarkerType.addEventListener("change", () => { syncSectionHelp(); applyFields(); });
  sectionMarkerTime.addEventListener("change", applyTime);
  sectionMarkerDelete.addEventListener("click", () => {
    if (!editMarker) return;
    beginPopEdit();   // closeSectionMarkerPop commits it, so the delete is one entry
    S.state.sectionMarkers = sectionMarkers().filter((marker) => marker !== editMarker);
    closeSectionMarkerPop();
    changed();
  });
  // Undo replaced S.state.sectionMarkers, so editMarker points at an object that
  // is no longer in it. Drop the session without committing and shut the popover.
  window.addEventListener(STATE_RESTORED, () => {
    markersChanged();   // undo replaced the whole array
    popSnapshot = null;
    closeSectionMarkerPop();
  });
  sectionMarkerPopClose.addEventListener("click", closeSectionMarkerPop);
  stage.addEventListener("dblclick", (event) => {
    if (!S.state) return;
    const [x, y] = toCanvas(event.clientX, event.clientY);
    if (!inBand(y - scroll.scrollTop) || markerAt(x, y)) return;
    addSectionMarkerAtTime(timeAt(x), event.clientX, event.clientY);
  });
  // Marker editors stay open until their close button is pressed.
}
