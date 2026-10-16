// Motifs only label authored notes. They impose no fingering, timing, pitch,
// chord, or repeat constraints and remain meaningful with a single member.
export const validMotifId = value => typeof value === "string" && /^motif_(?:legacy_|v2_)?\d+$/.test(value);
export const motifLabel = id => `Motif #${id.split("_").at(-1)}`;

// The first format used the note/lane counter as its visible number. Upgrade
// those ids once, across the whole project (including written alternatives).
// v2 ids retain their numbers on later loads, even when earlier motifs are gone.
export function normalizeMotifIds(lanes) {
  const notes = [];
  const visit = list => {
    for (const note of list || []) {
      notes.push(note);
      visit(note.written);
    }
  };
  for (const lane of lanes) visit(lane.notes);
  let next = 1;
  for (const note of notes) {
    if (/^motif_v2_\d+$/.test(note.motifId || ''))
      next = Math.max(next, Number(note.motifId.split('_').at(-1)) + 1);
  }
  const replacements = new Map();
  for (const note of notes) {
    const id = note.motifId;
    if (!validMotifId(id) || id.startsWith('motif_v2_')) continue;
    if (!replacements.has(id)) replacements.set(id, `motif_v2_${next++}`);
    note.motifId = replacements.get(id);
  }
  return next;
}

export function motifGroups(notes) {
  const groups = new Map();
  for (const note of notes || []) {
    if (!validMotifId(note.motifId)) continue;
    if (!groups.has(note.motifId)) groups.set(note.motifId, []);
    groups.get(note.motifId).push(note);
  }
  return groups;
}

export function markMotif(notes, id) {
  if (!validMotifId(id)) return;
  for (const note of notes) note.motifId = id;
}

// Reuse an unambiguous, fully selected motif when adding more marked notes.
// Partial selections and selections spanning several motifs create a new one.
export function motifToExtend(notes, selected) {
  const selection = new Set(selected);
  const ids = new Set([...selection].map(note => note.motifId).filter(validMotifId));
  if (ids.size !== 1) return null;
  const [id] = ids;
  return notes.filter(note => note.motifId === id).every(note => selection.has(note)) ? id : null;
}

export function unmarkMotif(notes, id) {
  for (const note of notes) if (note.motifId === id) delete note.motifId;
}

export function migrateMotifs(notes) {
  for (const note of notes) {
    if (!validMotifId(note.motifId)) {
      if (typeof note.shapeId === "string" && /^shape_\d+$/.test(note.shapeId))
        note.motifId = `motif_legacy_${note.shapeId.slice(6)}`;
      else delete note.motifId;
    }
    // Existing authored fingering is preserved; motifs never manage it.
    delete note.shapeId; delete note.shapeSource;
    if (Array.isArray(note.written)) migrateMotifs(note.written);
  }
}
