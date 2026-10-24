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

// Seconds <-> beats along a tempo map (segments as grid.js builds them). Beats
// count from the first segment and run at each segment's own tempo, so a passage
// measured in beats keeps its rhythm wherever it is placed. Before the first
// segment the first tempo extends backwards.
export function beatClock(segs) {
  const sec = (seg) => segBeatSec(seg) || 0.5;
  const starts = [0];
  for (let k = 1; k < segs.length; k++) starts.push(starts[k - 1] + (segs[k].t - segs[k - 1].t) / sec(segs[k - 1]));
  const last = (pred) => { let k = 0; for (let j = 1; j < segs.length; j++) if (pred(j)) k = j; else break; return k; };
  return {
    beatAt(t) { const k = last((j) => segs[j].t <= t + 1e-9); return starts[k] + (t - segs[k].t) / sec(segs[k]); },
    timeAt(b) { const k = last((j) => starts[j] <= b + 1e-9); return segs[k].t + (b - starts[k]) * sec(segs[k]); },
  };
}

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

// Every beat line of a tempo map (segments as grid.js builds them) up to `end`.
export function beatLines(segs, end) {
  const out = [];
  segs.forEach((seg, k) => {
    const step = segBeatSec(seg), stop = k + 1 < segs.length ? segs[k + 1].t : end;
    if (!(step > 0)) return;
    for (let i = 0; seg.t + i * step < stop - 1e-6; i++) out.push(seg.t + i * step);
  });
  return out;
}

// Times on one grid -> the same place on another: each old beat goes to the
// nearest new beat, and a time between two beats keeps its place between them.
// Before the first beat and after the last, the nearest beat's shift applies.
// Two old beats on one new beat (the new grid is half the tempo) keep the first.
export function beatWarp(oldBeats, newBeats) {
  const pairs = [];
  let j = 0;
  for (const o of oldBeats) {
    while (j + 1 < newBeats.length && Math.abs(newBeats[j + 1] - o) <= Math.abs(newBeats[j] - o)) j++;
    if (j < newBeats.length && (!pairs.length || newBeats[j] > pairs.at(-1)[1] + 1e-9)) pairs.push([o, newBeats[j]]);
  }
  if (!pairs.length) return (t) => t;
  return (t) => {
    if (t <= pairs[0][0]) return t + pairs[0][1] - pairs[0][0];
    if (t >= pairs.at(-1)[0]) return t + pairs.at(-1)[1] - pairs.at(-1)[0];
    let lo = 0, hi = pairs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pairs[mid][0] <= t) lo = mid; else hi = mid; }
    const [o0, n0] = pairs[lo], [o1, n1] = pairs[hi];
    return n0 + (t - o0) * (n1 - n0) / (o1 - o0);
  };
}

// Move everything timed in `lanes` (and the section markers) through `warp`:
// what retimeSpan moves, for a whole new tempo map. Times at 0 stay (a tone
// marker there is the base tone); notes stay within [floor, dur].
export function warpTimes(lanes, sectionMarkers, dur, minCell, warp, floor = 0) {
  const at = (t) => (t <= 1e-9 ? t : Math.max(0, Math.min(dur, warp(t))));
  const marks = (list) => { for (const m of list || []) m.t = at(+m.t); };
  for (const lane of lanes) {
    for (const group of Object.values(lane.refBoxes || {})) {
      if (!group || !Array.isArray(group.anchors) || !group.anchors.length || typeof group.rt0 !== "number") continue;
      const a = group.anchors[0];
      group.rt0 = at(a + group.rt0) - at(a);
      group.rt1 = at(a + group.rt1) - at(a);
      group.anchors = group.anchors.map(at);
    }
    for (const n of lane.notes) {
      const s = Math.max(floor, Math.min(at(n.start), dur - minCell));
      n.end = Math.max(s + minCell, Math.min(dur, at(n.end)));
      n.start = s;
    }
    for (const h of lane.handHolds || []) h.t = Math.max(floor, at(+h.t));   // same arithmetic as the note starts they sit on
    marks(lane.toneMarkers);
    marks(lane.phraseBoundaries);
  }
  marks(sectionMarkers);
}
