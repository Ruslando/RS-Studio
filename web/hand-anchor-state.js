// The saved hand is a sequence of changes, shared by editing, loading and export.
import { chordColumns } from './voicing-core.js';

export const HAND_ANCHOR_VERSION = 1;
const EPS = 1e-6;

export function handAnchorAt(holds, time) {
  let active = null;
  for (const hold of holds || []) if (hold.t <= time + EPS && (!active || hold.t >= active.t)) active = hold;
  return active;
}

export function nearestHandStart(notes, time) {
  const starts = chordColumns(notes).map(c => c.t0);
  return starts.reduce((best, t) => best == null || Math.abs(t - time) < Math.abs(best - time) ? t : best, null);
}

export function normalizeHandAnchors(notes, holds = [], initial = null) {
  const starts = chordColumns(notes).map(c => c.t0);
  if (!starts.length) return [];
  const ordered = (Array.isArray(holds) ? holds : []).filter(h => h && typeof h === 'object')
    .sort((a, b) => Number(a.t) - Number(b.t));
  const byTime = new Map();
  for (const hold of ordered) {
    if (!Number.isFinite(Number(hold.t)) || !Number.isInteger(Number(hold.fret)) || Number(hold.fret) < 1) continue;
    const t = starts.find(t => t >= Number(hold.t) - EPS);
    if (t == null) continue;
    byTime.set(t, { ...hold, id: hold.id || `anchor_${t}`, t, fret: Number(hold.fret) });
  }
  if (!byTime.has(starts[0])) byTime.set(starts[0], {
    id: `anchor_start_${notes.find(n => n.start === starts[0])?.id || starts[0]}`,
    t: starts[0], fret: Math.max(1, Math.round(initial ?? ordered.find(h => Number.isInteger(Number(h.fret)) && Number(h.fret) > 0)?.fret ?? 1) || 1),
  });
  const out = [], ids = new Set();
  for (const hold of [...byTime.values()].sort((a, b) => a.t - b.t)) {
    if (out.at(-1)?.fret === hold.fret) continue;
    const base = String(hold.id);
    let id = base, suffix = 1;
    while (ids.has(id)) id = `${base}_${suffix++}`;
    hold.id = id; ids.add(id); out.push(hold);
  }
  return out;
}

// Capture the current answer once. Slide travel is an animation of this hand,
// not an extra draggable change in the middle of a note.
export function initialHandAnchors(notes, seats, existing = []) {
  const changes = [];
  for (const column of chordColumns(notes)) {
    const fret = column.notes.map(n => seats.get(n)).find(Number.isFinite) ?? changes.at(-1)?.fret ?? 1;
    if (changes.at(-1)?.fret === fret) continue;
    changes.push({ id: existing.find(h => Math.abs(h.t - column.t0) < EPS)?.id || `anchor_${column.notes[0].id || column.t0}`,
      t: column.t0, fret: Math.max(1, Math.round(fret)) });
  }
  return normalizeHandAnchors(notes, changes);
}

export function changedHandAnchor(notes, holds, time, fret, id) {
  const current = normalizeHandAnchors(notes, holds);
  const t = nearestHandStart(notes, time);
  if (t == null) return current;
  const existing = current.find(h => Math.abs(h.t - t) < EPS);
  if (fret == null && existing === current[0]) return current;
  const next = current.filter(h => Math.abs(h.t - t) >= EPS);
  if (fret != null) next.push({ id: existing?.id || id || `anchor_${t}`, t, fret });
  return normalizeHandAnchors(notes, next, current[0]?.fret);
}

export function movedHandAnchor(notes, holds, id, time) {
  const current = normalizeHandAnchors(notes, holds);
  const hold = current.find(h => h.id === id);
  if (!hold || hold === current[0]) return current;
  const t = nearestHandStart(notes, time);
  // The initial value stays visible and cannot be replaced by dragging another flag.
  if (t == null || t <= current[0].t + EPS) return current;
  return normalizeHandAnchors(notes, [...current.filter(h => h.id !== id && Math.abs(h.t - t) >= EPS), { ...hold, t }], current[0].fret);
}
