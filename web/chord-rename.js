// Renaming a chord, from its name on the stage, the fretboard's bar or the note
// menu. The field offers the engine's readings (a native datalist) and takes any
// text. One undoable step; an empty name returns to the engine's.
import { setChordName } from "./chord-names.js";
import { commit, snapshotEdit } from "./edit.js";
import { refreshSaveState } from "./project.js";
import { draw } from "./repaint.js";

// Name `chord` `text` as one undo step; the engine's own name clears a given one.
export function renameChord(chord, text) {
  const prev = snapshotEdit();
  setChordName(chord, text);
  commit(prev); refreshSaveState(); draw();
}

// Rocksmith keeps 31 bytes of a chord name.
const MAX_NAME = 31;

// A text field laid over `rect` (client px). Enter or leaving commits, Escape cancels.
export function beginChordRename(chord, rect) {
  const input = document.createElement("input");
  input.type = "text"; input.className = "artifact-rename chord-rename";
  input.maxLength = MAX_NAME;
  input.setAttribute("aria-label", "Chord name");
  // Starts empty, so the list shows every reading; the current name is the hint.
  input.placeholder = chord.name || "Chord name";
  const list = document.createElement("datalist");
  list.id = "chordRenameNames";
  const offered = [...new Set([chord.auto, ...chord.alternatives].filter(Boolean))];
  list.append(...offered.map((name) => new Option(name)));
  input.setAttribute("list", list.id);
  input.title = chord.own && chord.auto ? `Pick ${chord.auto} for the automatic name` : "Pick a name or type your own";
  input.style.left = rect.left + "px"; input.style.top = rect.top + rect.height / 2 + "px";
  input.style.width = Math.max(160, rect.width) + "px";
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const text = input.value.trim();
    input.remove(); list.remove();
    // The field starts empty, so Enter on it keeps the shown name. The way back to
    // the engine's name is picking it, first in the list; a chord the engine cannot
    // name has no such entry, so there an empty field clears the given name.
    const clear = !text && chord.own && !chord.auto;
    if (!save || (!text && !clear) || text === chord.name) return;
    renameChord(chord, text);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  document.body.append(list, input);
  input.focus();
  // Open the list at once: a datalist otherwise waits for the Down key.
  try { input.showPicker(); } catch { /* no picker without a user gesture */ }
}
