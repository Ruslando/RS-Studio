// User-remappable single-key hotkeys. Ctrl/Cmd combos (save, undo, copy, paste…)
// stay fixed — they're OS conventions, not worth rebinding. Overrides persist in
// localStorage. Pure module (no DOM) so it's unit-testable: see keymap.test.mjs.

export const KEY_COMMANDS = [
  { id: "playPause",   label: "Play / pause",            def: "Space" },
  { id: "delete",      label: "Delete selection",        def: "Delete" },
  { id: "muteLayer",   label: "Mute note layer (Shift: audio layer)", def: "M" },
  // The fretboard gets F. It had G — for guitar — while F belonged to Find similar,
  // and that was the wrong way round: the neck is opened and closed many times in a
  // session where finding a passage is something you do once and then work inside,
  // and it is the letter of the thing. Find similar has no key at all now; it is in
  // the Edit menu and in the selection's own context menu, which is where the rest of
  // its four steps live. The marker lanes keep L for lanes.
  { id: "fretboard",   label: "Fretboard",               def: "F" },
  { id: "markerLanes", label: "Marker lanes",            def: "L" },
  { id: "resetZoom",   label: "Reset zoom",              def: "0" },
];

const LS = typeof localStorage !== "undefined" ? localStorage : null;   // Limitation: undefined under node test
const STORE = "cw.keymap";
const load = () => { try { return JSON.parse(LS && LS.getItem(STORE)) || {}; } catch { return {}; } };
let overrides = load();

// Display-only reference for shortcuts that aren't remappable: OS-convention
// Ctrl/Cmd combos and mode-specific keys. `key` (when present) is the normalized
// single key it occupies, so the editor won't let a rebind shadow it.
export const FIXED_SHORTCUTS = [
  { keys: "Left click", label: "Move playhead in empty space" },
  { keys: "Ctrl+Z", label: "Undo" },
  { keys: "Ctrl+Shift+Z · Ctrl+Y", label: "Redo" },
  { keys: "Ctrl+C", label: "Copy" },
  { keys: "Ctrl+X", label: "Cut" },
  { keys: "Ctrl+V", label: "Paste" },
  { keys: "Ctrl+Shift+V", label: "Paste as reference" },
  { keys: "Ctrl+S", label: "Save project" },
  { keys: "Ctrl+Shift+S", label: "Export .chart…" },
  { keys: "Ctrl+N", label: "New project" },
  { keys: "Ctrl+O", label: "Import .chart…" },
  { keys: "Esc", label: "Cancel · close · clear selection" },
  { keys: "Tab", key: "Tab", label: "Open selected-note effects menu" },
  { keys: "Hold S + drag", key: "S", label: "Slice notes along a line" },
  { keys: "← / →", label: "Previous / next chord — or match, while find-similar is live" },
  { keys: "↑ / ↓", label: "Between simultaneous notes" },
  { keys: "P", key: "P", label: "Preview focused match (find similar)" },
  { keys: "A", key: "A", label: "Accept all matches (find similar)" },
  { keys: "Enter", key: "Enter", label: "Accept focused match (find similar)" },
];

export const keyOf = (id) => overrides[id] || KEY_COMMANDS.find((c) => c.id === id).def;

// Command already bound to `key` (excluding `exceptId`), or null. Covers both the
// editable hotkeys and the reserved fixed single-keys, so the editor's "already
// used by …" guard stops a rebind from shadowing either.
export const conflictOf = (key, exceptId) =>
  KEY_COMMANDS.find((c) => c.id !== exceptId && keyOf(c.id) === key)
  || FIXED_SHORTCUTS.find((f) => f.key === key)
  || null;

export function setKey(id, key) { overrides[id] = key; if (LS) LS.setItem(STORE, JSON.stringify(overrides)); }
export function resetKeys() { overrides = {}; if (LS) LS.removeItem(STORE); }

// The shortcuts editor is a scrimmed modal, so it is staged (rule 17): it takes
// a snapshot when it opens and puts the bindings back if you Cancel. Rebinding
// has to apply as you go — you press the key to bind it — so the revert is what
// makes the scrim honest, not a deferred write.
export const keySnapshot = () => ({ ...overrides });
export function restoreKeys(snap) {
  overrides = { ...snap };
  if (LS) LS.setItem(STORE, JSON.stringify(overrides));
}

// Normalize a keydown event to a binding string: "Space", "Delete", "F", "[", "0".
// Backspace folds into Delete so the default delete binding covers both keys.
export function eventKey(e) {
  if (e.code === "Space" || e.key === " ") return "Space";
  if (e.key === "Delete" || e.key === "Backspace") return "Delete";
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

// Does this event fire command `id`? Ctrl/Cmd/Alt never match a single-key
// hotkey; Shift is allowed through (it's a sub-modifier, e.g. Shift+M = stem).
export function matchKey(e, id) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return eventKey(e) === keyOf(id);
}
