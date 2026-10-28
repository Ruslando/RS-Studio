// Rocksmith grip frames over notes, as EOF's Arpeggio and Handshape markers.
// Only the user sets them; nothing here detects one. A shape is the notes carrying
// one `shapeId`; `shapeKind` says how the game frames them: "arpeggio" (dashed,
// "-arp" chord) or "handshape" (solid grip held over single notes). A name the
// user gave rides on the notes as `shapeName`, like a motif's. The export reads all
// three (rocksmith/chart.py). DOM-free, so the rules can be tested.

import { detectChord } from "./chords.js";

export const SHAPE_KINDS = { arpeggio: "Arpeggio", handshape: "Handshape" };
export const isShapeKind = (kind) => Object.hasOwn(SHAPE_KINDS, kind);

// Shapes with at least two notes. One left over after a delete or a move frames
// nothing, so it is not a shape: not drawn, not exported, not offered in menus.
export function shapeGroups(notes) {
  const groups = new Map();
  for (const note of notes || []) {
    if (!note.shapeId || !isShapeKind(note.shapeKind)) continue;
    if (!groups.has(note.shapeId)) groups.set(note.shapeId, []);
    groups.get(note.shapeId).push(note);
  }
  for (const [id, members] of groups) if (members.length < 2) groups.delete(id);
  return groups;
}

// The grip's name in the game: the user's, else the chord of every pitch it holds.
export const shapeChord = (notes) =>
  notes.find((n) => n.shapeName)?.shapeName || detectChord([...new Set(notes.map((n) => n.pitch))]);

// The name the stage shows. An arpeggio reads "Am arp", as the game marks it.
export function shapeLabel(notes) {
  const kind = notes[0]?.shapeKind, chord = shapeChord(notes);
  return kind === "arpeggio" ? `${chord || "Arpeggio"} arp` : chord || "Handshape";
}

// What the name field offers before the user types: the automatic chord name.
export const shapeDefaultName = (notes) => detectChord([...new Set(notes.map((n) => n.pitch))]);

export function renameShape(all, id, name) {
  for (const note of all) if (note.shapeId === id) {
    if (name) note.shapeName = name; else delete note.shapeName;
  }
}

// One shape per note: marking takes the notes out of any shape they were in.
export function markShape(notes, id, kind) {
  if (!isShapeKind(kind) || notes.length < 2) return false;
  for (const note of notes) { note.shapeId = id; note.shapeKind = kind; delete note.shapeName; }
  return true;
}

export function unmarkShape(all, id) {
  for (const note of all) if (note.shapeId === id) clearShape(note);
}

export function clearShape(note) {
  delete note.shapeId; delete note.shapeKind; delete note.shapeName;
}

// Copies and moved notes get their own shape ids, so they are independent of the
// notes they came from. `pairs` is [source, copy]; source and copy may be one note.
export function remintShapes(pairs, mint) {
  const ids = new Map();
  for (const [source, copy] of pairs) {
    const id = source.shapeId, kind = source.shapeKind, name = source.shapeName;
    if (!id || !isShapeKind(kind)) { clearShape(copy); continue; }
    if (!ids.has(id)) ids.set(id, mint());
    copy.shapeId = ids.get(id);
    copy.shapeKind = kind;
    if (name) copy.shapeName = name; else delete copy.shapeName;
  }
}

// The stage label under the pointer, if any: { lane, id, x, y, w, h } in world px.
export const shapeLabelAt = (labels, x, y) =>
  (labels || []).find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) || null;
