// Renaming a reference or motif, from its artifact row or its label on the stage.
// One undoable step; an empty name returns to the numbered default.
import { commit, snapshotEdit } from "./edit.js";
import { motifLabel, motifName, renameMotif } from "./motifs.js";
import { refreshSaveState } from "./project.js";
import { refName } from "./references.js";
import { draw } from "./repaint.js";

export const artifactName = (kind, lane, ref) => kind === "motif"
  ? motifName(lane.notes, ref) : refName(lane.refBoxes?.[ref], ref);

function setName(kind, lane, ref, name) {
  const prev = snapshotEdit();
  if (kind === "motif") renameMotif(lane.notes, ref, name);
  else if (lane.refBoxes?.[ref]) {
    if (name) lane.refBoxes[ref].name = name; else delete lane.refBoxes[ref].name;
  }
  commit(prev); refreshSaveState(); draw();
}

// A text field laid over `rect` (client px). Enter or leaving commits, Escape cancels.
export function beginArtifactRename(kind, lane, ref, rect) {
  if (kind === "reference" && lane.refBoxes?.[ref]?.locked) return;
  const input = document.createElement("input");
  input.type = "text"; input.className = "artifact-rename";
  input.value = artifactName(kind, lane, ref);
  input.placeholder = kind === "motif" ? motifLabel(ref) : `Reference #${ref}`;
  input.setAttribute("aria-label", "Name");
  input.style.left = rect.left + "px"; input.style.top = rect.top + rect.height / 2 + "px";
  input.style.width = Math.max(160, rect.width) + "px";
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const name = input.value.trim(), defaultName = input.placeholder;
    input.remove();
    if (save && name !== artifactName(kind, lane, ref)) setName(kind, lane, ref, name === defaultName ? "" : name);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  document.body.append(input);
  input.focus(); input.select();
}
