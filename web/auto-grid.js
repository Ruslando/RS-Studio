import { segBeatSec, segBarSec } from './bars.js';

// Pick the finest division with at least 12 screen pixels per cell. At small
// scales use whole beats/bars; zooming never changes stored note positions.
export function autoGridStep(segment, pixelsPerSecond) {
  const beat = segBeatSec(segment), bar = segBarSec(segment);
  if (!(beat > 0) || !(pixelsPerSecond > 0)) return 0;
  const finest = (60 / segment.bpm) / 8; // 1/32 note
  const count = Math.max(1, Math.min(32, parseInt(segment.tsNum, 10) || 4));
  const groups = Array.from({ length: count - 1 }, (_, i) => i + 2).filter(size => count % size === 0);
  const steps = [beat / 8, beat / 4, beat / 2, beat, ...groups.map(size => beat * size)]
    .filter(step => step >= finest - 1e-9);
  let step = steps.find(value => value * pixelsPerSecond >= 12) || bar;
  while (step * pixelsPerSecond < 12) step *= 2;
  return step;
}

export function gridLineKind(time, segment) {
  const near = step => Math.abs((time - segment.t) / step - Math.round((time - segment.t) / step)) < 1e-6;
  return near(segBarSec(segment)) ? 'bar' : near(segBeatSec(segment)) ? 'beat' : 'sub';
}

export function autoGridLabel(segment, step) {
  if (!(step > 0)) return 'Auto';
  const bar = segBarSec(segment);
  if (step >= bar - 1e-9) return `Auto · ${Math.round(step / bar)} bar${step > bar + 1e-9 ? 's' : ''}`;
  return `Auto · 1/${Math.round(240 / segment.bpm / step)}`;
}
