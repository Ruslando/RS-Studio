// The server's separation backends and what each can produce, fetched once.
//
// Three UIs offer separation and all three read this list: the Stems tab strip's
// Add-stem menu, the stem settings panel, and the New Project modal. It was a
// module-level `let` in project.js while all three lived there; it moved out with
// the second of them, which is the point at which sharing stops being free.
//
// `separators` is an exported binding that loadSeparators() reassigns. Importers
// see the live value, so a UI can read it directly at render time without
// subscribing to anything.

export let separators = [];

// Which part a backend should offer first when the user hasn't chosen one.
// First match wins, so a guitar-focused app defaults to "guitar" over "other".
export const DEFAULT_PART_ORDER = ["guitar", "bass", "vocals", "drums", "piano", "other"];

// Never throws: with no backends, each caller shows its own "unavailable" copy.
export async function loadSeparators() {
  try { separators = await (await fetch("/api/separators")).json(); }
  catch { separators = []; }
  return separators;
}

export function backendLabel(id) {
  const b = separators.find((s) => s.id === id);
  return b ? b.label : id;
}
