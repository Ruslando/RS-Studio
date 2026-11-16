// Remember a rhythmic length, rather than seconds, so drawing the same note
// value in a different tempo still produces the same musical duration.
import { finestGridStep } from './auto-grid.js';
import { segBeatSec } from './bars.js';

const bpmAt = (time, segments) => {
  const segment = [...segments].reverse().find(item => item.t <= time) || segments[0];
  return Number(segment?.bpm) > 0 ? Number(segment.bpm) : 120;
};

// Precision is an explicit editing choice, not a consequence of trimming a
// note, changing the tempo, or landing between grid divisions.
export function hasFreeNoteLength(note) {
  return note?.preciseLength === true;
}

// Returning a note to normal length keeps its onset and moves only the end.
// Tempo markers are grid lines too, even when they truncate a regular cell.
export function nearestGridEnd(start, end, segments, stepAt) {
  if (!(end > start) || !segments?.length) return null;
  const candidates = segments.map(segment => segment.t).filter(time => time > start + 1e-6);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i], step = stepAt(segment), boundary = segments[i + 1]?.t;
    if (!(step > 0)) continue;
    const center = Math.round((end - segment.t) / step);
    for (let k = center - 1; k <= center + 1; k++) {
      const time = segment.t + k * step;
      if (time > start + 1e-6 && (boundary == null || time < boundary - 1e-6)) candidates.push(time);
    }
  }
  return candidates.sort((a, b) => Math.abs(a - end) - Math.abs(b - end) || a - b)[0] ?? null;
}

// Classify a length only when an explicit precision resize is performed.
export function isIrregularNoteLength(note, segments) {
  if (!segments.length || !(note.end > note.start)) return false;
  let time = note.start, cells = 0, shortest = Infinity, authoredCells = 0, authoredShortest = Infinity;
  for (const end of [...segments.filter(segment => segment.t > time && segment.t < note.end).map(segment => segment.t), note.end]) {
    const seg = [...segments].reverse().find(segment => segment.t <= time) || segments[0];
    const step = finestGridStep(seg);
    if (!(step > 0)) return false;
    cells += (end - time) / step;
    const authoredStep = segBeatSec(seg) / Math.max(1, Number(seg.subdiv) || 1);
    authoredCells += (end - time) / authoredStep;
    authoredShortest = Math.min(authoredShortest, authoredStep);
    shortest = Math.min(shortest, step);
    time = end;
  }
  return Math.abs(cells - Math.round(cells)) * shortest > 1e-4
    && Math.abs(authoredCells - Math.round(authoredCells)) * authoredShortest > 1e-4;
}

export function lengthInBeats(start, end, segments) {
  let time = start, beats = 0;
  for (const boundary of [...segments.filter(item => item.t > start && item.t < end).map(item => item.t), end]) {
    beats += Math.max(0, boundary - time) * bpmAt(time, segments) / 60;
    time = boundary;
  }
  return beats;
}

export function endAfterBeats(start, beats, segments) {
  let time = start, remaining = beats;
  for (const next of segments.filter(item => item.t > start)) {
    const bpm = bpmAt(time, segments), span = (next.t - time) * bpm / 60;
    if (remaining <= span) return time + remaining * 60 / bpm;
    remaining -= span;
    time = next.t;
  }
  return time + remaining * 60 / bpmAt(time, segments);
}

export class NoteLengthMemory {
  lengths = new WeakMap();
  remember(project, note, segments) {
    if (!project || !note || !(note.end > note.start)) return;
    const beats = lengthInBeats(note.start, note.end, segments);
    if (Number.isFinite(beats) && beats > 0) this.lengths.set(project, beats);
  }
  end(project, start, segments) {
    return endAfterBeats(start, this.lengths.get(project) ?? 1, segments);
  }
}

// One memory for every place notes are drawn: the stage and the fretboard.
export const noteLength = new NoteLengthMemory();
