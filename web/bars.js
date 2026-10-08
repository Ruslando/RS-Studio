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
