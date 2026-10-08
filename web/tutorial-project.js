// The walkthrough's demo song. One call: throw away whatever the last run of a
// chapter did to it, build it again on the server, and open it here.
//
// It is its own module rather than three lines inside tour.js because opening a
// project means confirmLeave() and applyProject(), and tour.js importing
// project.js for that would make the walkthrough an edge in the project
// lifecycle — the same reason tour.js listens for "cw-project-opened" instead of
// being called by it.

import { addStem, applyProject, confirmLeave, refreshSaveState, removeStem, selectStem, waitForProjectVisuals } from "./project.js";
import { loadWithScreen } from "./project-loading.js";
import { nid } from "./ids.js";
import { draw } from "./repaint.js";
import { renderLanes } from "./lanes.js";
import { S } from "./store.js";

let preparing = false;

/**
 * Open the tutorial project, rebuilt from scratch.
 * @returns {Promise<boolean>} false when the reader kept unsaved work instead.
 */
export async function openTutorialProject() {
  if (preparing) return false;
  // Their own project may be dirty, and a walkthrough is not a reason to lose
  // it. This is the one question the tour asks before it starts driving — and it
  // is not asked about the tutorial song itself, which every chapter dirties by
  // design and every chapter throws away. Chapters hand over to each other, so
  // asking would mean answering "no, don't save" seven times in one read.
  if (!inTutorialProject() && !await confirmLeave()) return false;
  preparing = true;
  try {
    return await loadWithScreen(async () => {
      const res = await fetch("/api/projects/tutorial/rebuild", { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Could not prepare walkthrough");
      applyProject(await res.json());
      await waitForProjectVisuals();
    }, { title: "Loading walkthrough", failureTitle: "Could not prepare walkthrough" });
  } finally {
    preparing = false;
  }
}

/** True when what is open is the tutorial song — the steps that edit check this. */
export const inTutorialProject = () => S.state?.job === "tutorial";

  // The bass part, as the synthesiser wrote it (src/rs_studio/tutorial.py): a
// lead-in, then one note a beat at 120 BPM, the same eight-note phrase four
// times. Kept in step with that file by ear, not by import — a tutorial whose
// notes are a beat off its audio is obvious the first time you press play.
const LEAD_IN = 0.35, BEAT = 0.5, HOLD = 0.45;
const PHRASE = [40, 43, 45, 47, 50, 47, 45, 43];
const REPEATS = 4;

const activeLane = () =>
  (S.state?.editLanes || []).find((lane) => lane.active) || S.state?.editLanes?.[0] || null;

/**
 * Put the demo phrase in the active layer, replacing whatever is there.
 *
 * Chapters need notes to point at — a reference to group, a chord to re-finger —
 * and they cannot inherit them from the chapter before, because the reader may
 * have run one on its own, skipped a step, or had a detector come out empty.
 * Every chapter that needs notes therefore states the notes it needs.
 */
export function seedTutorialNotes(repeats = REPEATS) {
  const lane = activeLane();
  if (!lane || !inTutorialProject()) return;
  lane.notes = [];
  lane.refBoxes = {};
  for (let i = 0; i < PHRASE.length * repeats; i++) {
    const start = LEAD_IN + i * BEAT;
    lane.notes.push({ id: nid(), start, end: start + HOLD, pitch: PHRASE[i % PHRASE.length] });
  }
  S.selection.clear();
  refreshSaveState();
  renderLanes();
  draw();
}

/** Empty the active layer, for the steps that are about drawing into an empty one. */
export function clearTutorialNotes() {
  const lane = activeLane();
  if (!lane || !inTutorialProject()) return;
  lane.notes = [];
  S.selection.clear();
  refreshSaveState();
  renderLanes();
  draw();
}

/**
 * Take the bass back out, so paging backwards past the step that made it lands on
 * the project as it was. Without this, walking the chapter twice left two of them.
 */
export async function removeTutorialBass() {
  const stem = (S.state?.stems || []).find((item) => item.id === "bass");
  if (stem && inTutorialProject()) await removeStem(stem);
}

/** Demonstrate the chosen bass separation using the tutorial's prepared audio. */
export async function addTutorialBass() {
  if (!inTutorialProject()) return false;
  if (S.state.stems.some((stem) => stem.id === "bass")) {
    selectStem("bass");
    return true;
  }
  return addStem("bass", "Bass", "demucs");
}

/** Show the bass stem's spectrogram — the part every drawing chapter works on. */
export function showBassStem() {
  if (inTutorialProject() && S.state.stems.some((stem) => stem.id === "bass")) selectStem("bass");
}
