import { overrideFlow, placeNote } from './voicing-core.js';
import { applySharedPositionPlan, positionSelection, sharedPositionPlan } from './position-selection.js';
import { hammerPositionPlan } from './hammer-positions.js';

// Build the actual prospective edit on detached musical data. The normal lane
// fingering pipeline can then preview exactly what commit will calculate.
export function positionPreviewLane(lane, columnNotes, shape, selection, tuning, positionOf, maxFret, kind = 'note') {
  const group = positionSelection(lane, selection);
  const originals = new Map(lane.notes.map((n, i) => [n, i]));
  const notes = structuredClone(lane.notes);
  const copy = { ...lane, notes, handHolds: structuredClone(lane.handHolds || []),
    refBoxes: structuredClone(lane.refBoxes || {}) };
  const noteFor = note => notes[originals.get(note)];
  if (group.multiple) {
    const plan = sharedPositionPlan(lane, selection, columnNotes, shape, tuning, positionOf, maxFret);
    if (plan.error) return null;
    applySharedPositionPlan({ ...plan, changes: plan.changes.map(change => ({ ...change, note: noteFor(change.note) })) });
  } else {
    const linked = hammerPositionPlan(lane, shape, tuning, positionOf, maxFret);
    if (linked.error) return null;
    if (linked.linked) {
      for (const change of linked.changes) {
        const target = noteFor(change.note); placeNote(target, { ...change.pos }); delete target.arrangement;
      }
      return { lane: copy, noteFor };
    }
    const flow = overrideFlow(columnNotes);
    for (const note of columnNotes) {
      const target = noteFor(note), pos = shape.get(note);
      if (!target || !pos) return null;
      placeNote(target, { string: pos.string, fret: pos.fret, scope: 'local', follow: flow.follow });
      if (kind === 'chord') delete target.arrangement;
    }
  }
  return { lane: copy, noteFor };
}

export function positionPreviewHand(columnNotes, noteFor, fingering) {
  const fingers = new Map(), byString = new Map(), positions = new Map();
  let seat = null;
  for (const note of columnNotes) {
    const target = noteFor(note), position = fingering.voiced.get(target);
    if (!position) return null;
    const finger = fingering.fingers?.get(target) ?? -1;   // none (NO_FINGER)
    fingers.set(note, finger);
    positions.set(note, position);
    byString.set(position.string, finger);
    seat ??= fingering.seats?.get(target) ?? null;
  }
  return { fingers, byString, seat, positions };
}
