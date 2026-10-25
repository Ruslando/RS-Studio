// Remember a rhythmic length, rather than seconds, so drawing the same note
// value in a different tempo still produces the same musical duration.
const bpmAt = (time, segments) => {
  const segment = [...segments].reverse().find(item => item.t <= time) || segments[0];
  return Number(segment?.bpm) > 0 ? Number(segment.bpm) : 120;
};

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
