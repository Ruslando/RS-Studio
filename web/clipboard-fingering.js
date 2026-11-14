import { HAND_ANCHOR_VERSION, handAnchorAt, normalizeHandAnchors } from './hand-anchor-state.js';
// Capture authored hand anchors by the attack they govern, not just by whether
// their timestamp happens to fall inside the copied time range.
export function noteHandAnchors(notes, holds = [], changes = false) {
  const ordered = [...notes].sort((a, b) => a.start - b.start), anchors = new Map();
  if (changes) {
    for (const note of ordered) {
      const hold = handAnchorAt(holds, note.start);
      if (hold) anchors.set(note, hold.fret);
    }
    return anchors;
  }
  for (const hold of [...holds].sort((a, b) => a.t - b.t)) {
    const next = ordered.find(n => n.start >= hold.t - 1e-6);
    if (next) for (const note of ordered) if (Math.abs(note.start - next.start) < 1e-4) anchors.set(note, hold.fret);
  }
  return anchors;
}
export function pasteHandAnchors(lane, clip, placed, mintId) {
  const anchors = [];
  clip.map((note, i) => ({ t: placed[i].start, fret: note.handAnchor })).sort((a, b) => a.t - b.t).forEach(h => {
    if (Number.isFinite(h.fret) && h.fret >= 1 && !anchors.some(a => Math.abs(a.t - h.t) < 1e-4)) anchors.push(h);
  });
  if (!anchors.length) return;
  const original = lane.handHolds || [];
  const end = Math.max(...placed.map(n => n.end));
  const after = [...lane.notes].sort((a, b) => a.start - b.start).find(n => n.start >= end - 1e-6);
  const resume = after && handAnchorAt(original, after.start);
  if (resume && !anchors.some(h => Math.abs(h.t - after.start) < 1e-6))
    anchors.push({ t: after.start, fret: resume.fret });
  const added = anchors.map(h => ({ id: `anchor_${mintId()}`, ...h }));
  lane.handHolds = [...(lane.handHolds || []).filter(h => !anchors.some(a => Math.abs(a.t - h.t) <= 1e-6)), ...added].sort((a, b) => a.t - b.t);
  lane.handHolds = normalizeHandAnchors(lane.notes, lane.handHolds, original[0]?.fret ?? anchors[0].fret);
  lane.handAnchorVersion = HAND_ANCHOR_VERSION;
}
