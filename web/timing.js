// Per-layer timing. A timing is what places notes in time: the start grid (bpm,
// offset, meter, division), the tempo/meter markers, the section markers and the
// imported score bars. Every layer follows the song's timing unless lane.timing
// names one of its own in S.state.timings: split off by hand (Layer settings), or
// brought in by a Guitar Pro import into an existing project.
//
// A timing of its own may still follow the song in one half: `songTempo` takes the
// grid, tempo markers and bars from the song's, `songSections` its sections. Those
// halves are read from and written back to the song's, so they never drift apart.
//
// The grid code everywhere reads ONE live timing: the grid inputs plus
// S.state.tempoMap / sectionMarkers / scoreBars. That is always the active layer's;
// switching layers swaps it (syncTiming), and S.state.timings holds the others.
// Code that touches every layer at once (snapping, export, the voicer) asks each
// layer's timing through timingIdOf / withTiming / timingData.

import { currentGridState, restoreGridState } from "./grid.js";
import { S } from "./store.js";
import { withEndSection } from './section-marker-core.js';

export const SONG = "song";
const liveId = () => S.state.liveTiming || SONG;
const stored = () => (S.state.timings ||= {});
const clone = (value) => JSON.parse(JSON.stringify(value));

// A lane naming a timing that no longer exists follows the song.
export function timingIdOf(lane) {
  const id = lane?.timing;
  return id && (id === liveId() || stored()[id]) ? id : SONG;
}
// Where a timing's tempo half and section half really live.
const tempoSource = (id) => (id !== SONG && stored()[id]?.songTempo ? SONG : id);
const sectionSource = (id) => (id !== SONG && stored()[id]?.songSections ? SONG : id);
// The lane shares the live tempo (grid, markers, bars): it rides tempo edits.
export const onLiveTiming = (lane) => tempoSource(timingIdOf(lane)) === tempoSource(liveId());
export const onLiveSections = (lane) => sectionSource(timingIdOf(lane)) === sectionSource(liveId());
// The section lists that sit on the live tempo, and so move with its edits: the
// song's sections belong to the song's tempo, a layer's own to the tempo it follows.
export function sectionsOnLiveTempo() {
  const tempo = tempoSource(liveId()), seen = new Set(), out = [];
  for (const id of [SONG, ...(S.state.editLanes || []).map(timingIdOf)]) {
    const source = sectionSource(id);
    if (seen.has(source)) continue;
    seen.add(source);
    if (tempoSource(source) !== tempo) continue;
    out.push(...(source === sectionSource(liveId()) ? S.state.sectionMarkers || [] : stored()[source]?.sectionMarkers || []));
  }
  return out;
}
export const ownsTempo = (lane) => tempoSource(timingIdOf(lane)) !== SONG;
export const ownsSections = (lane) => sectionSource(timingIdOf(lane)) !== SONG;

const tempoPart = (t) => ({ grid: t.grid, tempoMap: t.tempoMap || [], scoreBars: t.scoreBars || [] });
function capture() {
  return { grid: currentGridState(), tempoMap: S.state.tempoMap || [],
    sectionMarkers: S.state.sectionMarkers || [], scoreBars: S.state.scoreBars || [] };
}

// Write the live fields into `into` (a timings map): each half to where it lives.
function writeLive(into) {
  const id = liveId(), live = capture();
  const put = (target, part) => { into[target] = { ...into[target], ...part }; };
  put(tempoSource(id), tempoPart(live));
  put(sectionSource(id), { sectionMarkers: live.sectionMarkers });
  if (id !== SONG) put(id, {});   // the record itself, flags and all, stays
}
const flush = () => writeLive(stored());

function install(id) {
  const tempo = stored()[tempoSource(id)], sections = stored()[sectionSource(id)];
  if (tempo?.grid) {
    restoreGridState(tempo.grid);
    S.state.tempoMap = tempo.tempoMap || [];
    S.state.scoreBars = tempo.scoreBars || [];
  }
  if (sections) S.state.sectionMarkers = sections.sectionMarkers || [];
  S.state.liveTiming = id;
}

// A timing's data without making it live — what the exporters and the voicer read.
export function timingData(id) {
  if (id === liveId()) return capture();
  const live = capture(), store = stored();
  const tempo = tempoSource(id) === tempoSource(liveId()) ? live : store[tempoSource(id)] || live;
  const sections = sectionSource(id) === sectionSource(liveId()) ? live : store[sectionSource(id)] || live;
  return { ...tempoPart(tempo), sectionMarkers: sections.sectionMarkers || [] };
}

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

// Which halves the layer keeps of its own. A half it takes on starts as a copy of
// the song's, so nothing moves; a half it gives up follows the song again, and its
// notes are snapped to the song's grid at the commit that follows (snapStrayNotes).
export function setOwnTiming(lane, { tempo, sections }) {
  flush();
  if (!tempo && !sections) { delete lane.timing; syncTiming(); return; }
  let id = timingIdOf(lane);
  // A timing other layers follow too (a Guitar Pro import's) is not changed under
  // them: this layer gets its own copy first.
  const shared = id !== SONG && (S.state.editLanes || []).some((other) => other !== lane && timingIdOf(other) === id);
  if (id === SONG || shared) {
    const { songTempo, songSections } = stored()[id] || {};
    id = addTiming({ ...timingData(id), ...(songTempo ? { songTempo } : {}), ...(songSections ? { songSections } : {}) });
    lane.timing = id;
  }
  const t = stored()[id], song = stored()[SONG];
  if (!tempo) t.songTempo = true;
  else if (t.songTempo) { delete t.songTempo; Object.assign(t, clone(tempoPart(song))); }
  if (!sections) t.songSections = true;
  else if (t.songSections) { delete t.songSections; t.sectionMarkers = clone(song.sectionMarkers || []); }
  if (id === liveId()) install(id); else syncTiming();
}

// ---- undo ----
export function timingSnapshot() {
  return {
    live: liveId(),
    timings: (() => { const all = clone(stored()); writeLive(all); return clone(all); })(),
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
    const { songTempo, songSections } = stored()[id] || {};
    out[id] = { grid: t.grid, tempoMap: savedTempoMap(t.tempoMap, t.grid.subdiv),
      sectionMarkers: t.sectionMarkers, scoreBars: t.scoreBars,
      ...(songTempo ? { songTempo } : {}), ...(songSections ? { songSections } : {}) };
  }
  return out;
}

export function loadTimings(raw, end = 0, duration = Infinity) {
  const out = {};
  for (const [id, t] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (id === SONG || !t?.grid) continue;
    out[id] = { grid: t.grid, tempoMap: Array.isArray(t.tempoMap) ? t.tempoMap : [],
      sectionMarkers: withEndSection(t.sectionMarkers, end, duration),
      scoreBars: Array.isArray(t.scoreBars) ? t.scoreBars : [],
      ...(t.songTempo === true ? { songTempo: true } : {}), ...(t.songSections === true ? { songSections: true } : {}) };
  }
  return out;
}
