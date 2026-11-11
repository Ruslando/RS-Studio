// Capture authored hand anchors by the attack they govern, not just by whether
// their timestamp happens to fall inside the copied time range.
export function noteHandAnchors(notes, holds = []) {
  const ordered = [...notes].sort((a, b) => a.start - b.start), anchors = new Map();
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
  const added = anchors.map(h => ({ id: `anchor_${mintId()}`, ...h }));
  lane.handHolds = [...(lane.handHolds || []).filter(h => !anchors.some(a => Math.abs(a.t - h.t) <= 1e-6)), ...added].sort((a, b) => a.t - b.t);
}
