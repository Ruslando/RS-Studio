import { segBeatSec, segBarSec } from './bars.js';

// The smallest regular division the adaptive grid can display.
export const finestGridStep = segment => Math.max(segBeatSec(segment) / 8, (60 / segment.bpm) / 8);

// Pick the finest division with at least 12 screen pixels per cell. At small
// scales use whole beats/bars; zooming never changes stored note positions.
export function autoGridStep(segment, pixelsPerSecond) {
  const beat = segBeatSec(segment), bar = segBarSec(segment);
  if (!(beat > 0) || !(pixelsPerSecond > 0)) return 0;
  const finest = (60 / segment.bpm) / 8; // 1/32 note
  // The tempo marker's own division is the finest line, and every coarser one is
  // made of its cells: a note snapped here is never between the lines the
  // off-grid check counts (note-issues.js). A 1/16 grid stays 1/16 zoomed in.
  const subdiv = parseInt(segment.subdiv, 10), cell = subdiv > 0 ? beat / subdiv : 0;
  const fits = step => !cell || Math.abs(step / cell - Math.round(step / cell)) < 1e-6;
  const count = Math.max(1, Math.min(32, parseInt(segment.tsNum, 10) || 4));
  const groups = Array.from({ length: count - 1 }, (_, i) => i + 2).filter(size => count % size === 0);
  const steps = [...(cell ? [cell] : []), beat / 8, beat / 4, beat / 2, beat, ...groups.map(size => beat * size)]
    .filter(step => step >= Math.max(finest, cell) - 1e-9 && fits(step));
  let step = steps.find(value => value * pixelsPerSecond >= 12) || bar;
  while (step * pixelsPerSecond < 12) step *= 2;
  return step;
}

export function gridLineKind(time, segment) {
  const near = step => Math.abs((time - segment.t) / step - Math.round((time - segment.t) / step)) < 1e-6;
  return near(segBarSec(segment)) ? 'bar' : near(segBeatSec(segment)) ? 'beat' : 'sub';
}
