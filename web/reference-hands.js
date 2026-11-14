import { inRefBox, occurrenceBox } from './reference-core.js';
import { HAND_ANCHOR_VERSION, handAnchorAt } from './hand-anchor-state.js';

// A hand anchor belongs to the first attack at or after its timestamp, even
// when it was placed in the gap just before the capture box.
export function referenceHands(notes, holds, box, anchor, clock, minIn, changes = false) {
  if (!holds?.length) return [];
  const ordered = [...notes].sort((a, b) => a.start - b.start);
  const pattern = (holds || []).flatMap(hold => {
    const next = ordered.find(n => n.start >= hold.t - 1e-6);
    if (!next || !ordered.some(n => Math.abs(n.start - next.start) < 1e-4 && inRefBox(n, box, minIn))) return [];
    return [{ dt: clock.beatAt(next.start) - clock.beatAt(anchor), fret: hold.fret, hold }];
  }).sort((a, b) => a.dt - b.dt);
  if (changes) {
    const first = ordered.find(n => inRefBox(n, box, minIn)), active = first && handAnchorAt(holds, first.start);
    if (active && !pattern.some(p => p.hold === active)) pattern.unshift({
      dt: clock.beatAt(first.start) - clock.beatAt(anchor), fret: active.fret, hold: active, inherited: true,
    });
  }
  return pattern;
}
export const referenceHandSig = pattern => JSON.stringify(pattern.map(p => [Math.round(p.dt * 1e6), p.fret]));

export function mirrorReferenceHands(lane, group, index, pattern, clock, minIn, mintId, previousPattern = null) {
  const anchor = group.anchors[index], box = occurrenceBox(group, index, clock);
  const current = previousPattern || referenceHands(lane.notes, lane.handHolds, box, anchor, clock, minIn,
    lane.handAnchorVersion === HAND_ANCHOR_VERSION);
  if (referenceHandSig(current) === referenceHandSig(pattern)) return;
  const removed = new Set(current.filter(p => !p.inherited).map(p => p.hold));
  const after = lane.handAnchorVersion === HAND_ANCHOR_VERSION
    && [...lane.notes].sort((a, b) => a.start - b.start).find(n => n.start >= box.t1 - 1e-6);
  const resume = after && handAnchorAt(lane.handHolds, after.start);
  const added = pattern.map(p => ({ id: current.find(q => Math.abs(q.dt - p.dt) < 1e-6)?.hold.id || `anchor_${mintId()}`,
    t: clock.timeAt(clock.beatAt(anchor) + p.dt), fret: p.fret }));
  // An inherited source value needs a distinct event at the destination.
  for (let i = 0; i < added.length; i++) if (current.some(p => p.inherited && p.hold.id === added[i].id))
    added[i].id = `anchor_${mintId()}`;
  if (resume && !added.some(h => Math.abs(h.t - after.start) < 1e-6)
    && !(lane.handHolds || []).some(h => !removed.has(h) && Math.abs(h.t - after.start) < 1e-6))
    added.push({ id: `anchor_${mintId()}`, t: after.start, fret: resume.fret });
  lane.handHolds = [...(lane.handHolds || []).filter(h => !removed.has(h)), ...added].sort((a, b) => a.t - b.t);
}
