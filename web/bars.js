// Bar lines, as times — the one piece of the tempo grid that is pure arithmetic
// over a tempo/meter segment list, with no DOM and no store behind it.
//
// It lives apart from grid.js because two callers cannot reach grid.js at all:
// the voicing worker, which has no document, and the corpus tests, which read a
// project.json off disk. Both need to know where the bars are — the voicer plans
// the hand a bar at a time (planSeats) — and neither can pull in the editor's
// input elements to find out.

import { MAX_BARS_SCANNED } from "./constants.js";

// bpm is the quarter-note tempo (what detection gives and what GP stores). A beat
// is one denominator note = (4/tsDen) quarters, so 4/4 is unchanged (beat = 60/bpm)
// and e.g. 6/8 beats an eighth — the same convention the .gp5 export uses.
export const segBeatSec = (seg) => (seg.bpm ? (4 / (parseInt(seg.tsDen, 10) || 4)) * (60 / seg.bpm) : 0);
export const segBarSec = (seg) => segBeatSec(seg) * (parseInt(seg.tsNum, 10) || 4);  // one bar

// Every bar start in the song, ascending. Each segment tiles its own bars forward
// until the next segment begins, which is the tempo map's own rule: a marker starts
// a new bar at its own tempo and meter.
export function barStartsFrom(segments, duration) {
  const segs = (segments || []).filter((seg) => Number.isFinite(+seg?.t));
  const end = Math.max(0, Number(duration) || 0);
  const starts = [];
  for (let index = 0; index < segs.length; index++) {
    const segment = segs[index], stop = segs[index + 1]?.t ?? end;
    const length = segBarSec(segment);
    if (!(length > 0)) continue;
    let guard = 0;
    for (let time = +segment.t; time < stop - 1e-5 && guard++ < MAX_BARS_SCANNED; time += length)
      starts.push(Math.max(0, time));
    if (guard >= MAX_BARS_SCANNED) console.warn("bar scan hit its ceiling; later bars are missing");
  }
  return [...new Set(starts.map((time) => +time.toFixed(6)))].sort((a, b) => a - b);
}

// The same list from a saved project's `grid` — the shape project.json stores and
// the shape the tests read. Segment 0 is the grid's own anchor; tempoMap markers
// follow it, each inheriting whatever it does not override.
export function barStartsFromGrid(grid, duration) {
  if (!grid) return [];
  const seg0 = {
    t: +grid.offset || 0, bpm: +grid.bpm || 0,
    tsNum: parseInt(grid.tsNum, 10) || 4, tsDen: parseInt(grid.tsDen, 10) || 4,
  };
  const segs = [seg0];
  for (const marker of (grid.tempoMap || []).slice().sort((a, b) => a.t - b.t)) {
    const prev = segs[segs.length - 1];
    if (!(+marker.t > seg0.t + 1e-6)) continue;
    segs.push({
      t: +marker.t, bpm: +marker.bpm || prev.bpm,
      tsNum: parseInt(marker.tsNum, 10) || prev.tsNum,
      tsDen: parseInt(marker.tsDen, 10) || prev.tsDen,
    });
  }
  return barStartsFrom(segs, duration);
}

// A tempo marker's BPM changed from `oldBpm` to `newBpm`: everything between it
// (t0) and the next tempo marker (t1) keeps its bar and beat, so it stretches with
// the beat. Notes on the old grid land exactly on the new one, no snapping needed.
// Tempo markers never move. Returns how many notes now start at or past t1.
export function retimeSpan(lanes, sectionMarkers, dur, minCell, t0, t1, oldBpm, newBpm) {
  if (!(oldBpm > 0) || !(newBpm > 0) || oldBpm === newBpm) return 0;
  const ratio = oldBpm / newBpm;
  const inSpan = (t) => t >= t0 - 1e-9 && t < t1 - 1e-9;
  const at = (t) => (inSpan(t) ? t0 + (t - t0) * ratio : t);
  const retimeMarks = (list) => { for (const m of list || []) m.t = at(+m.t); };
  let spilled = 0;
  for (const lane of lanes) {
    for (const group of Object.values(lane.refBoxes || {})) {
      if (!group || !Array.isArray(group.anchors) || !group.anchors.length || typeof group.rt0 !== "number") continue;
      if (inSpan(group.anchors[0])) { group.rt0 *= ratio; group.rt1 *= ratio; }
      group.anchors = group.anchors.map(at);
    }
    for (const n of lane.notes) {
      if (!inSpan(n.start)) continue;
      // ponytail: a note pushed past the song's end is pinned to its last cell
      const s = Math.min(at(n.start), dur - minCell);
      n.end = Math.min(dur, s + (n.end - n.start) * ratio);
      n.start = s;
      if (s >= t1 - 1e-9) spilled++;
    }
    for (const h of lane.handHolds || []) h.t = at(+h.t);   // same arithmetic as the note starts they sit on
    retimeMarks(lane.toneMarkers);
    retimeMarks(lane.phraseBoundaries);
  }
  retimeMarks(sectionMarkers);
  return spilled;
}
