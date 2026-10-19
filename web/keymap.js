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
  { id: "sidebar",     label: "Layer sidebar",           def: "B" },
  { id: "artifacts",   label: "Artifacts sidebar",       def: "R" },
  { id: "zoomIn",      label: "Zoom in",                 def: "+" },
  { id: "zoomOut",     label: "Zoom out",                def: "-" },
  { id: "resetZoom",   label: "Reset zoom",              def: "0" },
  // Existing actions offered for binding, without choosing defaults for the user.
  ...[
    ["slower", "Playback: slower"], ["faster", "Playback: faster"],
    ["normalSpeed", "Playback: normal speed"], ["metronome", "Metronome"],
    ["songStart", "Go to song start"], ["songEnd", "Go to song end"],
    ["rangeStart", "Go to range start"], ["clearRange", "Clear loop / detection range"],
    ["addTempo", "Add tempo / meter marker at playhead"],
    ["addSection", "Add section marker at playhead"],
    ["addPhrase", "Add phrase boundary at playhead"],
    ["addTone", "Add tone switch at playhead"],
    ["detectNotes", "Open note detection"], ["findSimilar", "Find similar passage"],
    ["groupReference", "Group selection into reference"],
    ["detachReference", "Detach selected reference occurrences (keep notes)"],
    ["markMotif", "Mark selection as motif"], ["selectMotif", "Select entire motif"],
    ["unmarkMotif", "Unmark selected motifs (keep notes)"],
    ["fretboardShape", "Fretboard: build a grip"],
    ["applyFretboardShape", "Fretboard: apply custom grip"],
    ["chooseFretboardAlternative", "Fretboard: use previewed alternative"],
    ["autoFretboard", "Fretboard: return to automatic"],
    ["palmMute", "Toggle palm mute"], ["hammer", "Toggle hammer-on / pull-off"],
    ["vibrato", "Toggle vibrato"], ["dead", "Toggle dead note"],
    ["accent", "Toggle accent"], ["letRing", "Toggle let ring"],
    ["previousLayer", "Previous note layer"], ["nextLayer", "Next note layer"],
    ["addLayer", "Add note layer"], ["layerSettings", "Active note layer settings"],
    ["layerVisible", "Show / hide active note layer"], ["layerLock", "Lock / unlock active note layer"],
    ["tablature", "Open tablature view"], ["editorSettings", "Editor settings"],
    ["projectDetails", "Project details"], ["tunings", "Manage tunings"],
    ["toneDesigner", "Tone designer"], ["keyboardSettings", "Keyboard shortcuts"],
    ["projectLibrary", "Open project from library"], ["closeProject", "Close project"],
    ["importGuitarPro", "Import Guitar Pro tracks"], ["attachAudio", "Attach audio"],
    ["exportGuitarPro", "Export Guitar Pro (.gp)"],
    ["exportLegacyGuitarPro", "Export legacy Guitar Pro (.gp5)"],
    ["exportRocksmith", "Export Rocksmith CDLC (.psarc)"],
  ].map(([id, label]) => ({ id, label, def: null })),
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
  { keys: "Esc", key: "Escape", label: "Cancel · close · clear selection" },
  { keys: "Tab", key: "Tab", label: "Open selected-note effects menu" },
  { keys: "Hold S + drag", key: "S", label: "Slice notes along a line" },
  { keys: "← / →", reserved: ['ArrowLeft', 'ArrowRight'], label: "Previous / next chord — or match, while find-similar is live" },
  { keys: "Ctrl+← / Ctrl+→", label: "Previous / next marker of the active layer" },
  { keys: "↑ / ↓", reserved: ['ArrowUp', 'ArrowDown'], label: "Between simultaneous notes" },
  { keys: "P", key: "P", label: "Preview focused match (find similar)" },
  { keys: "A", key: "A", label: "Accept all matches (find similar)" },
  { keys: "Enter", key: "Enter", label: "Accept focused match (find similar)" },
  { keys: "Ctrl+click", label: "Add / remove note from selection" },
  { keys: "Ctrl+left drag", label: "Draw notes along the spectrogram" },
  { keys: "Left drag in empty space", label: "Pan the spectrogram" },
  { keys: "Shift+drag", label: "Select notes in a rectangle" },
  { keys: "Alt+drag", label: "Set loop / detection range" },
  { keys: "Wheel · Shift+wheel", label: "Scroll time · scroll pitch" },
  { keys: "Ctrl+wheel · Ctrl+Shift+wheel", label: "Zoom both axes · zoom pitch" },
  { keys: "← / → · Shift+← / →", label: "Focused overview: seek 0.1 s · 1 s" },
  { keys: "Home / End", label: "Focused overview: song start / end" },
  { keys: "← / → · Shift+← / →", label: "Focused project start: move 0.01 s · 0.1 s" },
  { keys: "← / →", label: "Fretboard editing: previous / next alternative or grip note" },
  { keys: "↑ / ↓", label: "Focused capo / hand field: decrease / increase fret" },
  { keys: "Alt+← / → · Delete", label: "Tone designer effect: reorder · remove" },
  { keys: "Space / Enter · Esc", label: "Focused artifact preview: play · stop" },
  { keys: "Shift+F10 · Menu key", label: "Focused artifact preview: open actions" },
  { keys: "Arrow keys", label: "Focused volume control: adjust volume" },
  { keys: "↑ / ↓ · Enter", label: "Note effects search: choose result · apply" },
];

export function keyOf(id) {
  if (Object.hasOwn(overrides, id)) return overrides[id];
  const key = KEY_COMMANDS.find(command => command.id === id)?.def ?? null;
  // A newly introduced default must never take a user's existing custom key.
  return key && Object.entries(overrides).some(([other, value]) => other !== id && value === key &&
    KEY_COMMANDS.some(command => command.id === other)) ? null : key;
}

// Command already bound to `key` (excluding `exceptId`), or null. Covers both the
// editable hotkeys and the reserved fixed single-keys, so the editor's "already
// used by …" guard stops a rebind from shadowing either.
export const conflictOf = (key, exceptId) =>
  key && (KEY_COMMANDS.find((c) => c.id !== exceptId && keyOf(c.id) === key)
  || FIXED_SHORTCUTS.find((f) => f.key === key || f.reserved?.includes(key)))
  || null;

const changed = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('cw-keymap-changed')); };
export function shortcutTitle(label, id) { const key = keyOf(id); return key ? `${label} (${key})` : label; }
export function setKey(id, key) { overrides[id] = key; if (LS) LS.setItem(STORE, JSON.stringify(overrides)); changed(); }
export function resetKeys() { overrides = {}; if (LS) LS.removeItem(STORE); changed(); }

// The shortcuts editor is a scrimmed modal, so it is staged (rule 17): it takes
// a snapshot when it opens and puts the bindings back if you Cancel. Rebinding
// has to apply as you go — you press the key to bind it — so the revert is what
// makes the scrim honest, not a deferred write.
export const keySnapshot = () => ({ ...overrides });
export function restoreKeys(snap) {
  overrides = { ...snap };
  if (LS) LS.setItem(STORE, JSON.stringify(overrides));
  changed();
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
