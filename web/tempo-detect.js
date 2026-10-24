// File → Detect tempo map: the server finds beats and bars (pipeline.py
// detect_tempo_map) and this replaces the song's grid with them, as one undoable
// edit. Notes ride along like they do when a marker's tempo is edited: each
// keeps its place between the beats (bars.js beatWarp).
import { beatLines, beatWarp, warpTimes } from "./bars.js";
import { commitStructure, snapshotEdit } from "./edit.js";
import { currentGridState, gridSegments, gridSubdiv, minDur, restoreGridState } from "./grid.js";
import { editLanes } from "./lanes.js";
import { projectStart } from "./project-position-core.js";
import { toast } from "./notify.js";
import { operationRequest } from "./operation-progress.js";
import { refreshSaveState } from "./project.js";
import { draw } from "./repaint.js";
import { S } from "./store.js";
import { refreshTabIfOpen } from "./tablature.js";
import { SONG, onLiveTiming, withTiming } from "./timing.js";

export function applyTempoMap(grid) {
  const prev = snapshotEdit();
  withTiming(SONG, () => {
    const end = S.state.duration;
    const before = beatLines(gridSegments(), end);
    restoreGridState({ ...currentGridState(), bpm: grid.bpm, offset: grid.offset, tsNum: grid.tsNum, tsDen: grid.tsDen });
    const subdiv = gridSubdiv();
    S.state.tempoMap = (grid.tempoMap || []).map((m) => ({ t: +m.t, bpm: +m.bpm, tsNum: +m.tsNum, tsDen: +m.tsDen, subdiv }));
    // As retimeTempoSpan: with audio, the End section is the audio's and stays.
    const sections = (S.state.sectionMarkers || []).filter((m) => !S.state.stems?.length || m.sectionType !== "end");
    warpTimes(editLanes().filter(onLiveTiming), sections, end, minDur(), beatWarp(before, beatLines(gridSegments(), end)), projectStart(S.state));
  });
  commitStructure(prev);
  draw(); refreshTabIfOpen(); refreshSaveState();
}

export async function detectTempoMap() {
  const state = S.state;
  if (!state?.stems?.length) { toast("Add the song's audio first."); return; }
  let grid;
  try {
    grid = await operationRequest(`/api/projects/${state.job}/tempo-map`, {}, "Detecting tempo map", state.name || "Song");
  } catch { return; }   // operationRequest already said why
  if (S.state !== state) return;
  applyTempoMap(grid);
  const markers = grid.tempoMap.length;
  toast(`Tempo map: ${grid.bpm.toFixed(1)} BPM, ${grid.tsNum}/${grid.tsDen}`
    + (markers ? `, ${markers} marker${markers === 1 ? "" : "s"}` : "") + ". Ctrl+Z undoes it.", 5000);
}
