// Per-layer timing. A timing is what places notes in time: the start grid (bpm,
// offset, meter, division), the tempo/meter markers, the section markers and the
// imported score bars. Every layer follows the song's timing unless lane.timing
// names one of its own in S.state.timings: split off by hand (Layer settings), or
// brought in by a Guitar Pro import whose tempo differs from the song's.
//
// The grid code everywhere reads ONE live timing: the grid inputs plus
// S.state.tempoMap / sectionMarkers / scoreBars. That is always the active layer's;
// switching layers swaps it (syncTiming), and S.state.timings holds the others.
// Code that touches every layer at once (snapping, export, the voicer) asks each
// layer's timing through timingIdOf / withTiming / timingData.

import { currentGridState, restoreGridState } from "./grid.js";
import { S } from "./store.js";

export const SONG = "song";
const liveId = () => S.state.liveTiming || SONG;
const stored = () => (S.state.timings ||= {});
const clone = (value) => JSON.parse(JSON.stringify(value));

// A lane naming a timing that no longer exists follows the song.
export function timingIdOf(lane) {
  const id = lane?.timing;
  return id && (id === liveId() || stored()[id]) ? id : SONG;
}
export const onLiveTiming = (lane) => timingIdOf(lane) === liveId();

function capture() {
  return { grid: currentGridState(), tempoMap: S.state.tempoMap || [],
    sectionMarkers: S.state.sectionMarkers || [], scoreBars: S.state.scoreBars || [] };
}

const flush = () => { stored()[liveId()] = capture(); };

function install(id) {
  const t = stored()[id];
  if (t) {
    restoreGridState(t.grid);
    S.state.tempoMap = t.tempoMap || [];
    S.state.sectionMarkers = t.sectionMarkers || [];
    S.state.scoreBars = t.scoreBars || [];
  }
  S.state.liveTiming = id;
}

// A timing's data without making it live — what the exporters and the voicer read.
export const timingData = (id) => (id === liveId() ? capture() : stored()[id] || capture());

// Make the active layer's timing the live one. Called wherever the active layer
// may have changed (renderLanes / rebuildLanes); a no-op when it already is.
export function syncTiming() {
  if (!S.state) return;
  const lanes = S.state.editLanes || [];
  const id = timingIdOf(lanes.find((lane) => lane.active) || lanes[0]);
  if (id === liveId()) return;
  flush();
  install(id);
}

// Run fn with timing `id` live, then put the previous one back. Whatever fn
// changes in that timing is kept.
export function withTiming(id, fn) {
  if (id === liveId()) return fn();
  const prev = liveId();
  flush();
  install(id);
  try { return fn(); } finally { flush(); install(prev); }
}

// fn(lanes) once per timing, with that timing live.
export function eachTiming(lanes, fn) {
  const groups = new Map();
  for (const lane of lanes) {
    const id = timingIdOf(lane);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(lane);
  }
  for (const [id, group] of groups) withTiming(id, () => fn(group));
}

// Add a timing (a copy of `data`) and return its id.
export function addTiming(data) {
  let id;
  do id = `timing_${S.uid++}`; while (stored()[id]);   // ids loaded from a save are not counted in S.uid
  stored()[id] = clone(data);
  return id;
}

// The layer gets its own copy of the timing it follows now, so nothing moves.
export function splitTiming(lane) {
  const id = addTiming(timingData(timingIdOf(lane)));
  const wasLive = onLiveTiming(lane);
  lane.timing = id;
  if (wasLive) { flush(); install(id); }
}

// The layer follows the song again. Its notes are snapped to the song's grid at
// the commit that follows (snapStrayNotes).
export function joinSongTiming(lane) {
  delete lane.timing;
  syncTiming();
}

// ---- undo ----
export function timingSnapshot() {
  return {
    live: liveId(),
    timings: clone({ ...stored(), [liveId()]: capture() }),
    lanes: Object.fromEntries((S.state.editLanes || []).map((lane) => [lane.id, lane.timing || null])),
  };
}

// Before the live fields are restored: they are the snapshot's live timing.
export function restoreTimingSnapshot(snap) {
  if (!snap) return;
  S.state.timings = clone(snap.timings);
  S.state.liveTiming = snap.live;
  for (const lane of S.state.editLanes || []) {
    if (!(lane.id in snap.lanes)) continue;
    if (snap.lanes[lane.id]) lane.timing = snap.lanes[lane.id];
    else delete lane.timing;
  }
}

// ---- save / load ----
const savedTempoMap = (map, subdiv) => (map || []).map((m) => (
  { t: +m.t, bpm: +m.bpm, tsNum: +m.tsNum, tsDen: +m.tsDen, subdiv: +m.subdiv || subdiv }));

// The timings layers use, other than the song's (which the project's own grid,
// sectionMarkers and scoreBars fields carry). Unused ones are dropped here.
export function timingsForSave() {
  const out = {};
  for (const lane of S.state.editLanes || []) {
    const id = timingIdOf(lane);
    if (id === SONG || out[id]) continue;
    const t = clone(timingData(id));
    out[id] = { grid: t.grid, tempoMap: savedTempoMap(t.tempoMap, t.grid.subdiv),
      sectionMarkers: t.sectionMarkers, scoreBars: t.scoreBars };
  }
  return out;
}

export function loadTimings(raw) {
  const out = {};
  for (const [id, t] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (id === SONG || !t?.grid) continue;
    out[id] = { grid: t.grid, tempoMap: Array.isArray(t.tempoMap) ? t.tempoMap : [],
      sectionMarkers: Array.isArray(t.sectionMarkers) ? t.sectionMarkers : [],
      scoreBars: Array.isArray(t.scoreBars) ? t.scoreBars : [] };
  }
  return out;
}
