// File → Detect tempo map: the server finds beats and bars (pipeline.py
// detect_tempo_map) and this replaces the song's grid with them, as one undoable
// edit. Notes ride along like they do when a marker's tempo is edited: each
// keeps its place between the beats (bars.js beatWarp).
import { beatLines, beatWarp, warpTimes } from "./bars.js";
import { confirmChoice } from "./dialog.js";
import { commitStructure, snapshotEdit } from "./edit-history.js";
import { currentGridState, gridSubdiv, restoreGridState } from "./grid-controls.js";
import { gridSegments, minDur } from "./grid-read.js";
import { editLanes } from "./lanes.js";
import { projectStart } from "./project-position-core.js";
import { toast } from "./notify.js";
import { operationRequest } from "./operation-progress.js";
import { parameterSlider } from "./parameter-slider.js";
import { refreshSaveState } from "./save-state.js";
import { draw } from "./repaint.js";
import { S } from "./store.js";
import { refreshTabIfOpen } from "./tablature.js";
import { SONG, onLiveTiming, sectionsOnLiveTempo, withTiming } from "./timing.js";

function applyTempoMap(grid) {
  const prev = snapshotEdit();
  withTiming(SONG, () => {
    const end = S.state.duration;
    const before = beatLines(gridSegments(), end);
    restoreGridState({ ...currentGridState(), bpm: grid.bpm, offset: grid.offset, tsNum: grid.tsNum, tsDen: grid.tsDen });
    const subdiv = gridSubdiv();
    S.state.tempoMap = (grid.tempoMap || []).map((m) => ({ t: +m.t, bpm: +m.bpm, tsNum: +m.tsNum, tsDen: +m.tsDen, subdiv }));
    // As retimeTempoSpan: with audio, the End section is the audio's and stays.
    const sections = sectionsOnLiveTempo().filter((m) => !S.state.stems?.length || m.sectionType !== "end");
    warpTimes(editLanes().filter(onLiveTiming), sections, end, minDur(), beatWarp(before, beatLines(gridSegments(), end)), projectStart(S.state));
  });
  commitStructure(prev);
  draw(); refreshTabIfOpen(); refreshSaveState();
}

export async function detectTempoMap() {
  const state = S.state;
  if (!state?.stems?.length) { toast("Add the song's audio first."); return; }
  const control = document.createElement("div");
  control.className = "tempo-smoothness-control";
  const smoothness = new Map([[100, "Flexible"], [300, "Balanced"], [500, "Smooth"]]);
  const label = document.createElement("label");
  label.textContent = "Tempo-change smoothness";
  const value = document.createElement("output");
  value.textContent = "Balanced";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = "tempoSmoothness";
  slider.min = "100";
  slider.max = "500";
  slider.step = "200";
  slider.setAttribute("aria-label", "Tempo-change smoothness");
  slider.value = "300";
  slider.addEventListener("input", () => {
    value.textContent = smoothness.get(Number(slider.value));
  });
  label.htmlFor = slider.id;
  const row = document.createElement("div");
  row.className = "tempo-smoothness-heading";
  row.append(label, value);
  control.append(row, parameterSlider(slider, {
    min: 100, max: 500, step: 200, defaultValue: 300,
    format: (setting) => smoothness.get(setting), showDefault: false,
    labels: Object.fromEntries(smoothness), snapPoints: [...smoothness.keys()],
  }));
  const choice = await confirmChoice({
    title: "Detect tempo map",
    message: "",
    confirmLabel: "Detect",
    cancelLabel: "Cancel",
    content: control,
    onOpen: () => slider.focus(),
  });
  if (choice !== "confirm") return;

  let grid;
  try {
    grid = await operationRequest(`/api/projects/${state.job}/tempo-map`, {
      transition_lambda: Number(slider.value),
    }, "Detecting tempo map", state.name || "Song");
  } catch { return; }   // operationRequest already said why
  if (S.state !== state) return;
  applyTempoMap(grid);
  const markers = grid.tempoMap.length;
  toast(`Tempo map: ${grid.bpm.toFixed(1)} BPM, ${grid.tsNum}/${grid.tsDen}`
    + (markers ? `, ${markers} marker${markers === 1 ? "" : "s"}` : "") + ". Ctrl+Z undoes it.", 5000);
}
