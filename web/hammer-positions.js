import { hammerLink } from './articulations.js';
import { chordColumns, placementLimits, shapeFault } from './voicing-core.js';

// Roles and adjacency come from the same relation the neck animates. In a
// chord, pair voices on their current string; a lone pair can also be repaired.
function hammerConnections(notes, positionOf = n => n.pos) {
  const columns = chordColumns(notes), edges = [];
  for (let i = 1; i < columns.length; i++) {
    const before = columns[i - 1].notes, after = columns[i].notes, used = new Set();
    for (const source of before) {
      const from = positionOf(source);
      const target = after.filter(n => !used.has(n) && hammerLink(source, n) &&
        (before.length === 1 && after.length === 1 || from && positionOf(n)?.string === from.string))
        .sort((a, b) => Math.abs(a.pitch - source.pitch) - Math.abs(b.pitch - source.pitch))[0];
      if (target) { edges.push([source, target]); used.add(target); }
    }
  }
  return edges;
}
export function hammerPositionGroup(notes, note, positionOf = n => n.pos) {
  const edges = hammerConnections(notes, positionOf), group = new Set([note]);
  for (const member of group) for (const [a, b] of edges) {
    if (member === a) group.add(b);
    if (member === b) group.add(a);
  }
  return [...group];
}
export function hammerPositionPreview(notes, focused, positionOf = n => n.pos) {
  const members = new Set(focused.flatMap(n => hammerPositionGroup(notes, n, positionOf)));
  return hammerConnections(notes, positionOf).filter(([a, b]) => members.has(a) && members.has(b))
    .flatMap(([a, b]) => {
      const from = positionOf(a), to = positionOf(b);
      return from && to && from.string === to.string ? [{ from: { note: a, ...from }, to: { note: b, ...to },
        kind: b.pitch > a.pitch ? 'H' : 'P' }] : [];
    });
}

// One prospective edit for the entire connection, including incoming notes.
// Validate the resulting columns before mutating any authored position.
export function hammerPositionPlan(lane, shape, tuning, positionOf, maxFret = 24) {
  const proposed = new Map(shape);
  let linked = false;
  for (const [note, pos] of shape) {
    const group = hammerPositionGroup(lane.notes, note, positionOf);
    linked ||= group.length > 1;
    for (const member of group) {
      const fret = member.pitch - tuning[pos.string], existing = proposed.get(member);
      if (!Number.isInteger(fret) || fret < 0 || fret > maxFret || existing && existing.string !== pos.string)
        return { linked, changes: [], error: 'The hammer-on/pull-off connection cannot be played on that string' };
      proposed.set(member, { string: pos.string, fret });
    }
  }
  if (!linked) return { linked: false, changes: [], error: null };
  // placementLimits reads authored pins as well as positionOf. Validate a
  // detached version of the complete proposed edit so an imported destination's
  // old pin does not incorrectly forbid its source from following it.
  const originalOf = new Map();
  const preview = lane.notes.map(note => {
    const copy = proposed.has(note) ? { ...note, pos: proposed.get(note) } : note;
    if (proposed.has(note)) delete copy.arrangement;
    originalOf.set(copy, note); return copy;
  });
  const columns = chordColumns(preview), at = n => proposed.get(originalOf.get(n)) || positionOf(originalOf.get(n));
  for (let i = 0; i < columns.length; i++) {
    if (!columns[i].notes.some(n => proposed.has(originalOf.get(n)))) continue;
    const limits = placementLimits(columns, i, tuning, at, maxFret);
    const error = shapeFault(columns[i].notes, tuning,
      new Map(columns[i].notes.flatMap(n => at(n) ? [[n, at(n)]] : [])), limits, maxFret);
    if (error) return { linked: true, changes: [], error };
  }
  return { linked: true, error: null, changes: [...proposed].map(([note, pos]) => ({ note,
    pos: { ...pos, scope: 'local', follow: 'guided' } })) };
}
