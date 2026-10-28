// Per-layer Rocksmith crowd events (EOF's Place RS Event): crowd speed and
// applause. The export fills in what a layer leaves out, as DLC Builder does
// (chart._crowd_events). The rail shows those too, paler: touching one makes it
// the layer's own, with the event that ends it, since a kind the layer sets
// replaces the export's of that kind.
import { paintMarkerFlag } from "./canvas-components.js";
import { placeFloating } from "./floating-position.js";
import { stageUi } from "./constants.js";
import { crowdEventCode, crowdEventDelete, crowdEventPop, crowdEventPopClose, crowdEventTime, mmctx as minimapCtx, scroll, sctx, stage } from "./dom.js";
import { draw } from "./repaint.js";
import { STATE_RESTORED, commitStructure, snapshotEdit } from "./edit.js";
import { timeAt, xOf } from "./geometry.js";
import { snap } from "./grid.js";
import { inRailBand, railBand, registerLaneField, registerMarkerRail } from "./marker-rails.js";
import { refreshSaveState } from "./project.js";
import { CROWD_EVENTS, normalizeCrowdEvents } from "./section-marker-core.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";
import { rocksmithEvents } from "./rocksmith-check.js";
import { timingIdOf, withTiming } from "./timing.js";

const RAIL_H = 22;
const inBand = (localY) => inRailBand("crowd", localY);
const NAMES = new Map(CROWD_EVENTS);

let rects = [];
let editEvent = null, editLaneId = null;
const editingLane = () => S.state?.editLanes.find((lane) => lane.id === editLaneId);

// One popover session is one undo step, as on the phrase rail.
let popSnapshot = null;
const beginPopEdit = () => { if (!popSnapshot) popSnapshot = snapshotEdit(); };
function endPopEdit() {
  const prev = popSnapshot;
  popSnapshot = null;
  if (prev) commitStructure(prev);
}

const activeLane = () => S.state?.editLanes?.find((lane) => lane.active) || S.state?.editLanes?.[0] || null;
function events(lane = activeLane()) {
  if (!lane) return [];
  if (!lane.crowdEvents) lane.crowdEvents = [];
  return lane.crowdEvents;
}
// The export's crowd events for a layer that are not the layer's own, each with
// the events that go with it: a speed alone, an applause with its end.
export function automaticCrowdEvents(lane = activeLane()) {
  // A kind the layer sets replaces the export's of that kind (chart._crowd_events),
  // so those are left out at once, not when the next check comes back.
  const own = new Set((lane?.crowdEvents || []).map((e) => (/^e[0-2]$/.test(e.code) ? "speed" : e.code)));
  const auto = rocksmithEvents(lane).filter((item) => NAMES.has(item.code));
  const out = [];
  auto.forEach((item, k) => {
    const kind = /^e[0-2]$/.test(item.code) ? "speed" : item.code;
    if (kind === "E13" || own.has(kind)) return;
    const end = kind === "speed" ? null : auto.slice(k + 1).find((other) => other.code === "E13");
    const group = end ? [item, end] : [item];
    for (const member of group) out.push({ ...member, auto: true, group });
  });
  return out.sort((a, b) => a.t - b.t);
}

// An automatic event becomes the layer's own, with its group; returns the own copy.
function adopt(lane, item) {
  let mine = null;
  for (const member of item.group) {
    const copy = { id: `crowd_${Date.now()}_${member.code}_${Math.round(member.t * 1000)}`, t: member.t, code: member.code };
    events(lane).push(copy);
    if (member.t === item.t && member.code === item.code) mine = copy;
  }
  return mine;
}

// Opens the editor on an event, own or automatic (the Artifacts list uses it too).
export function editCrowdEvent(clientX, clientY, item, lane = activeLane()) {
  if (!item.auto) return openCrowdEventPop(clientX, clientY, item, lane);
  endPopEdit();
  popSnapshot = snapshotEdit();   // adopting and editing are one undo step
  const mine = adopt(lane, item);
  changed(lane);
  const held = popSnapshot;
  popSnapshot = null;   // openCrowdEventPop ends the previous session; this one carries on
  openCrowdEventPop(clientX, clientY, events(lane).find((e) => e.id === mine.id) || mine, lane);
  popSnapshot = held;
}

const duration = () => Number(S.state?.duration) || Number(S.state?.scoreDuration) || Infinity;
const snapTime = (value) => Math.max(0, Math.min(duration(), snap(Math.max(0, Number(value) || 0))));

function toCanvas(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  return [clientX - rect.left + scroll.scrollLeft, clientY - rect.top + scroll.scrollTop];
}

function changed(lane) {
  const id = editEvent?.id;
  lane.crowdEvents = normalizeCrowdEvents(events(lane), duration());
  if (id) editEvent = lane.crowdEvents.find((item) => item.id === id) || null;
  refreshSaveState();
  draw();
}

export const crowdEventLabel = (event) => NAMES.get(event.code) || event.code;

export function openCrowdEventPop(clientX, clientY, event, lane = activeLane()) {
  endPopEdit();
  editLaneId = lane?.id;
  editEvent = event;
  crowdEventCode.value = event.code;
  crowdEventTime.value = String(+Number(event.t).toFixed(3));
  crowdEventPop.hidden = false;
  placeFloating(crowdEventPop, clientX, clientY);
}

export function closeCrowdEventPop() {
  endPopEdit();
  crowdEventPop.hidden = true;
  editEvent = null;
}

function apply() {
  const lane = editingLane();
  if (!editEvent || !lane) return;
  beginPopEdit();
  editEvent.code = crowdEventCode.value;
  editEvent.t = withTiming(timingIdOf(lane), () => snapTime(crowdEventTime.value));
  crowdEventTime.value = String(+editEvent.t.toFixed(3));
  changed(lane);
}

function addAt(time, clientX, clientY) {
  const lane = activeLane();
  if (!lane || !Number.isFinite(Number(time))) return;
  const t = snapTime(time);
  const prev = snapshotEdit();
  // Applause after the first, a crowd speed before it: the likelier next one.
  const code = events(lane).some((item) => item.code === "E3") ? "e1" : "E3";
  const event = { id: `crowd_${Date.now()}_${Math.round(t * 1000)}`, t, code };
  events(lane).push(event);
  changed(lane);
  commitStructure(prev);
  openCrowdEventPop(clientX, clientY, events(lane).find((item) => item.id === event.id) || event, lane);
}

const hitAt = (x, y) => rects.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) || null;

function mouseDown(event) {
  if (!S.state || event.button !== 0) return false;
  const [x, y] = toCanvas(event.clientX, event.clientY);
  if (!inBand(y - scroll.scrollTop)) return false;
  const hit = hitAt(x, y);
  if (!hit) return false;
  event.preventDefault();
  const grab = timeAt(x) - Number(hit.event.t);
  let moved = null;
  const onMove = (e) => {
    if (!moved) {
      moved = snapshotEdit();
      if (hit.event.auto) hit.event = adopt(hit.lane, hit.event);
    }
    hit.event.t = snapTime(timeAt(toCanvas(e.clientX, e.clientY)[0]) - grab);
    draw();
  };
  const onUp = (e) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (moved) { changed(hit.lane); commitStructure(moved); }
    else editCrowdEvent(e.clientX, e.clientY, hit.event, hit.lane);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return true;
}

function drawRail() {
  rects = [];
  const lane = activeLane();
  if (!S.state || !lane) return;
  const top = scroll.scrollTop + railBand("crowd").y;
  const left = scroll.scrollLeft, right = left + scroll.clientWidth;
  sctx.save();
  sctx.font = stageUi(11, 600);
  sctx.textBaseline = "middle";
  for (const event of [...events(lane), ...automaticCrowdEvents(lane)]) {
    const x = xOf(event.t), label = crowdEventLabel(event);
    sctx.globalAlpha = event.auto ? 0.55 : 1;
    const rect = { event, lane, x0: x, x1: x + Math.ceil(sctx.measureText(label).width) + 18,
      y0: top + 2, y1: top + RAIL_H - 2 };
    rects.push(rect);
    if (rect.x0 > right || rect.x1 < left) continue;
    paintMarkerFlag(sctx, rect, PAINT.marker);
    sctx.fillStyle = PAINT.text;
    sctx.fillText(label, x + 9, top + RAIL_H / 2);
  }
  sctx.restore();
}

function drawMinimap(at, mmctx = minimapCtx) {
  for (const event of [...events(), ...automaticCrowdEvents()]) {
    mmctx.fillStyle = PAINT.marker;
    mmctx.fillRect(at(event.t) - 1, 43, 3, 5);
  }
}

export function init_crowd_events() {
  crowdEventCode.replaceChildren(...CROWD_EVENTS.map(([code, name]) =>
    Object.assign(document.createElement("option"), { value: code, textContent: name })));
  window.addEventListener(STATE_RESTORED, () => { popSnapshot = null; closeCrowdEventPop(); });
  registerMarkerRail({
    id: "crowd",
    height: RAIL_H,
    count: () => (activeLane()?.crowdEvents || []).length + automaticCrowdEvents().length,
    draw: drawRail,
    drawMinimap,
    cursorAt: (x, y) => (S.state && inBand(y - scroll.scrollTop) && hitAt(x, y) ? "grab" : null),
    mouseDown,
    menuLabel: "Add crowd event",
    addAt,
  });
  registerLaneField("crowdEvents", { normalize: normalizeCrowdEvents });
  crowdEventCode.addEventListener("change", apply);
  crowdEventTime.addEventListener("change", apply);
  crowdEventDelete.addEventListener("click", () => {
    const lane = editingLane();
    if (!editEvent || !lane) return;
    beginPopEdit();
    lane.crowdEvents = events(lane).filter((item) => item !== editEvent);
    closeCrowdEventPop();
    changed(lane);
  });
  crowdEventPopClose.addEventListener("click", closeCrowdEventPop);
}
