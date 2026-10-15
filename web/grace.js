// Before-the-beat grace notes: one quick hammer-on from below. Keep their
// timing and open-string limit identical in audio, notation and the fretboard.
export function graceBefore(note, bpm = 120, fret = note?.pos?.fret) {
  const interval = note?.grace === "whole" ? 2 : note?.grace === "half" ? 1 : 0;
  const duration = Math.min(0.08, 15 / (bpm || 120), Math.max(0, note?.start || 0));
  if (!interval || !duration) return null;
  return { start: note.start - duration, duration,
    offset: -Math.min(interval, fret ?? interval) };
}
