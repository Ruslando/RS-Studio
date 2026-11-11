import { inRefBox, occurrenceBox } from './reference-core.js';

// A hand anchor belongs to the first attack at or after its timestamp, even
// when it was placed in the gap just before the capture box.
export function referenceHands(notes, holds, box, anchor, clock, minIn) {
  if (!holds?.length) return [];
  const ordered = [...notes].sort((a, b) => a.start - b.start);
  return (holds || []).flatMap(hold => {
    const next = ordered.find(n => n.start >= hold.t - 1e-6);
    if (!next || !ordered.some(n => Math.abs(n.start - next.start) < 1e-4 && inRefBox(n, box, minIn))) return [];
    return [{ dt: clock.beatAt(next.start) - clock.beatAt(anchor), fret: hold.fret, hold }];
  }).sort((a, b) => a.dt - b.dt);
}
export const referenceHandSig = pattern => JSON.stringify(pattern.map(p => [Math.round(p.dt * 1e6), p.fret]));

export function mirrorReferenceHands(lane, group, index, pattern, clock, minIn, mintId, previousPattern = null) {
  const anchor = group.anchors[index], box = occurrenceBox(group, index, clock);
  const current = previousPattern || referenceHands(lane.notes, lane.handHolds, box, anchor, clock, minIn);
  if (referenceHandSig(current) === referenceHandSig(pattern)) return;
  const removed = new Set(current.map(p => p.hold));
  const added = pattern.map(p => ({ id: current.find(q => Math.abs(q.dt - p.dt) < 1e-6)?.hold.id || `anchor_${mintId()}`,
    t: clock.timeAt(clock.beatAt(anchor) + p.dt), fret: p.fret }));
  lane.handHolds = [...(lane.handHolds || []).filter(h => !removed.has(h)), ...added].sort((a, b) => a.t - b.t);
}
