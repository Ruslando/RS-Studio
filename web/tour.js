// The walkthrough: a dim with a hole cut over one live control, and a card
// beside it. tour-core.js holds what it says; this holds how it is drawn.
//
// The dim is NOT rule 17's scrim. A scrim promises nothing has changed yet;
// this one promises the opposite of nothing — "this is the thing" — and it has
// a hole in it. Nothing here is staged, so there is no Cancel and no footer in
// the modal sense: the card takes the popover's chrome.
//
// The card is built here rather than authored in index.html, following the two
// other transient surfaces that do the same — notify.js builds `.toasts` and
// edit.js builds `div.ctxmenu`. It keeps the whole feature in two files and
// adds nothing to dom.js.

import { fretboardVisible, setFretboardVisible } from "./fretboard.js";
import { railBand, railsBottom, railsHidden } from "./marker-rails.js";
import { firstMarkerViewportRect, openFirstMarkerPop } from "./markers.js";
import { cancelPendingDetection, detectCompletionCount, openDetectPanel, requireDetectModel, updateDetectStatus } from "./detect.js";
import { restoreEditSnapshot, restrictContextMenuTo, snapshotEdit, updateUndoButtons, walkthroughMenuOpenCount } from "./edit.js";
import { refMenuEntry } from "./references.js";
import { addStemMenuMode, closeAddStemMenu, closeProject } from "./project.js";
import { ACT, FIRST, TOURS, UNTIL, previousTourStep } from "./tour-core.js";
import { renderInstruction } from "./tour-text.js";
import { addTutorialBass, clearTutorialNotes, openTutorialProject, removeTutorialBass, seedTutorialNotes, showBassStem } from "./tutorial-project.js";
import { bpmInput, detectPanel, offsetInput, scroll, stage } from "./dom.js";
import { currentGridState, gridBpm, gridOffset, minDur } from "./grid.js";
import { xOf, yOf } from "./geometry.js";
import { playbackTime, seekPlayback, transportPlaying } from "./playback.js";
import { S, setSelection } from "./store.js";
import { clearMatches, runFindSimilar } from "./tracing.js";
import { normalizePhraseBoundaries, normalizeSectionMarkers } from "./section-marker-core.js";
import { normalizeToneMarkers } from "./tone-marker-core.js";
import { effectSignatureFields } from "./note-effects.js";
import { refreshCounts, renderLanes } from "./lanes.js";
import { draw } from "./repaint.js";
import { confirmAction } from "./dialog.js";

// What a step is allowed to DO, by name. Rule 24 used to say a step may reveal a
// panel and nothing else, because a walkthrough that edits is an undo the reader
// did not ask for — on THEIR project. The walkthrough starts on its own tutorial
// song, rebuilt at the beginning; chapter handoffs keep that song open so the
// audio stem and timing work from earlier chapters carry forward.
//
// A gesture the reader needs to learn waits for that gesture. Setup actions
// use the app's own controls to prepare the next card or close a window. The
// tutorial bass is prepared on the server and added after its menu explanation.
let tourClick = false;
const clickElement = (el) => {
  if (!el) return;
  tourClick = true;
  try { el.click(); } finally { tourClick = false; }
};
const click = (id) => clickElement(document.getElementById(id));
const clickSel = (sel) => clickElement(document.querySelector(sel));
async function setAddStemMode(mode) {
  tourClick = true;
  try { return await addStemMenuMode(mode); }
  finally { tourClick = false; }
}

const tutorialEditLane = () => S.state?.editLanes?.find((lane) => lane.active)
  || S.state?.editLanes?.[0] || null;
function focusTutorialNote(note) {
  if (!note) return;
  setSelection(new Set([note]));
  scroll.scrollLeft = Math.max(0, xOf(note.start) - 80);
  scroll.scrollTop = Math.max(0, yOf(note.pitch) - scroll.clientHeight / 2);
  draw();
}

const ACTIONS = {
  [ACT.tutorial]: () => openTutorialProject(),
  [ACT.fretboard]: () => {
    clearMatches();
    seedTutorialNotes();
    S.voicingRevision++;
    setSelection(new Set());
    seekPlayback(0.4);
    setFretboardVisible(false);
  },
  [ACT.lanes]: () => { if (railsHidden()) click("markerLanesToggle"); },
  [ACT.fretboardShow]: () => setFretboardVisible(true),
  [ACT.audioReady]: () => {
    setFretboardVisible(false);
    if (document.getElementById("appshell")?.classList.contains("side-collapsed")) click("sidebarToggle");
  },
  [ACT.seed]: () => seedTutorialNotes(),
  [ACT.traceOptions]: () => {
    if (!tutorialEditLane()?.notes?.length) seedTutorialNotes(1);
    ACTIONS[ACT.options]();
  },
  [ACT.prepareNavigation]: () => {
    if (!document.getElementById("settingsModalBackdrop").hidden) ACTIONS[ACT.optionsClose]();
    if (new Set((tutorialEditLane()?.notes || []).map((note) => note.start)).size < 2)
      seedTutorialNotes(1);
    if (transportPlaying()) click("play");
    if (card?.contains(document.activeElement)) document.activeElement.blur();
    const first = [...(tutorialEditLane()?.notes || [])].sort((a, b) => a.start - b.start)[0];
    if (first) { focusTutorialNote(first); seekPlayback(first.start); }
  },
  [ACT.prepareShapeNotes]: () => {
    clearMatches();
    seedTutorialNotes(1);
    const lane = tutorialEditLane();
    if (lane) lane.notes = lane.notes.slice(0, 2);
    setSelection(new Set());
    scroll.scrollLeft = 0;
    refreshCounts(); renderLanes();
    draw();
  },
  [ACT.selectShapeNotes]: () => {
    if (S.selection.size < 2) setSelection(new Set(tutorialEditLane()?.notes?.slice(0, 2) || []));
    draw();
  },
  [ACT.prepareEditNotes]: () => {
    if (!tutorialEditLane()?.notes?.length) seedTutorialNotes(1);
    focusTutorialNote(tutorialEditLane()?.notes?.[0]);
  },
  [ACT.prepareSliceNote]: () => {
    if (card?.contains(document.activeElement)) document.activeElement.blur();
    const lane = tutorialEditLane();
    if (!lane?.notes?.length) seedTutorialNotes(1);
    const notes = tutorialEditLane()?.notes || [];
    const note = notes.find((item) => item.end - item.start >= 4 * minDur()) || notes[0];
    if (!note) return;
    if (note.end - note.start < 4 * minDur()) {
      note.end = Math.min(S.state.duration, note.start + 4 * minDur());
      S.voicingRevision++;
    }
    focusTutorialNote(note);
  },
  [ACT.prepareEffectNote]: () => {
    const lane = tutorialEditLane();
    focusTutorialNote([...S.selection].find((note) => lane?.notes?.includes(note)) || lane?.notes?.[0]);
  },
  [ACT.ensureDetectedNotes]: () => {
    if (!tutorialEditLane()?.notes?.length) seedTutorialNotes();
    if (!detectPanel?.hidden) click("detectClose");
  },
  [ACT.seedFirstPhrase]: () => {
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
    S.detectRegion = null;
    seedTutorialNotes(1);
  },
  [ACT.selectFirstPhrase]: () => {
    if (S.selection.size >= 2) return;
    const lane = S.state?.editLanes?.find((item) => item.active) || S.state?.editLanes?.[0];
    if (lane) setSelection(new Set(lane.notes.slice(0, 8)));
  },
  [ACT.findSimilar]: () => {
    clearMatches();
    ACTIONS[ACT.selectFirstPhrase]();
    draw();
  },
  [ACT.prepareMatches]: () => {
    if (!S.matches.length) {
      ACTIONS[ACT.selectFirstPhrase]();
      runFindSimilar();
    }
    if (S.matches.length) {
      scroll.scrollLeft = Math.max(0, xOf(S.matches[0].t0) - 80);
      draw();
    }
  },
  [ACT.focusAlternative]: () => {
    setFretboardVisible(true);
    setSelection(new Set());
    seekPlayback(0.86);
    draw();
  },
  [ACT.demoSections]: () => {
    if (!S.state) return;
    const demo = [
      [0.35, "Intro", "intro"], [4.35, "Verse", "verse"],
      [8.35, "Chorus", "chorus"], [12.35, "Outro", "outro"],
    ].map(([t, text, sectionType]) => ({ id: `tour_section_${sectionType}`, t, text, marker: text, sectionType }));
    const existing = (S.state.sectionMarkers || []).filter((marker) => !String(marker.id).startsWith("tour_section_"));
    S.state.sectionMarkers = normalizeSectionMarkers([...existing, ...demo], S.state.duration);
    draw();
  },
  [ACT.demoPhrases]: () => {
    const lane = S.state?.editLanes?.find((item) => item.active) || S.state?.editLanes?.[0];
    if (!lane) return;
    lane.phraseBoundaries = normalizePhraseBoundaries([
      ...(lane.phraseBoundaries || []), 2.35, 6.35, 10.35, 14.35,
    ], S.state.duration);
    draw();
  },
  [ACT.demoTone]: () => {
    const lane = S.state?.editLanes?.find((item) => item.active) || S.state?.editLanes?.[0];
    if (!lane) return;
    lane.toneMarkers = normalizeToneMarkers([
      ...(lane.toneMarkers || []).filter((marker) => marker.id !== "tour_tone_middle"),
      { id: "tour_tone_middle", t: 8.35, tone: "clean" },
    ], S.state.duration);
    draw();
  },
  [ACT.ensureReference]: () => {
    if (!S.state?.editLanes?.some((lane) => Object.keys(lane.refBoxes || {}).length)) {
      ACTIONS[ACT.selectFirstPhrase]();
      refMenuEntry([...S.selection])?.fn();
    }
    const box = S.refBoxRects?.[0];
    if (box) { scroll.scrollTop = Math.max(0, box.y0 - 64); draw(); }
  },
  [ACT.clear]: () => {
    if (!document.getElementById("settingsModalBackdrop")?.hidden) click("settingsCancel");
    clearTutorialNotes();
  },
  [ACT.bass]: () => showBassStem(),
  // The two windows a reader is talked into opening, and the part they are talked
  // into making. Paging backwards has to put each of them back, or the card you
  // land on describes a screen that is not there — and the bass, left behind,
  // arrives twice the second time through.
  [ACT.addMenuClose]: () => closeAddStemMenu(),
  [ACT.addMenuOpen]: () => { if (!document.querySelector(".stem-add-menu")) clickSel("#audioLayerActions .layer-add"); },
  [ACT.addUploadMode]: async () => {
    if (!document.querySelector(".stem-add-menu")) clickSel("#audioLayerActions .layer-add");
    for (let i = 0; i < 40; i++) {
      if (await setAddStemMode("upload")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  },
  [ACT.addSeparateMode]: () => setAddStemMode("separate"),
  [ACT.bassRemove]: () => removeTutorialBass(),
  [ACT.stemEditOpen]: () => {
    if (document.getElementById("stemSettingsBackdrop")?.hidden)
      clickSel("#stemTabs .stem-row:nth-child(2) .stem-btn.edit");
  },
  [ACT.stemEditOpenIfClosed]: () => {
    if (document.getElementById("layerSettingsBackdrop")?.hidden)
      clickSel("#lanes .lane-row .edit-btn");
  },
  [ACT.stemEditClose]: () => click("stemCancel"),
  [ACT.layerEditClose]: () => click("layerCancel"),
  [ACT.tempoPopClose]: () => click("markerPopClose"),
  [ACT.tempoPopOpen]: () => {
    if (document.getElementById("markerPop")?.hidden) openFirstMarkerPop();
  },
  [ACT.detectClose]: () => click("detectClose"),
  [ACT.detectOpen]: () => {
    const box = stage.getBoundingClientRect();
    openDetectPanel(box.left + 80, box.top + 80);
  },
  [ACT.closeWindows]: () => {
    if (!document.getElementById("stemSettingsBackdrop")?.hidden) click("stemCancel");
    if (!document.getElementById("layerSettingsBackdrop")?.hidden) click("layerCancel");
  },
  [ACT.sidebarOpen]: () => {
    if (document.getElementById("appshell")?.classList.contains("side-collapsed")) click("sidebarToggle");
  },
  [ACT.options]: () => click("menuTraceSettings"),
  [ACT.optionsClose]: () => click("settingsCancel"),
  [ACT.fbEdit]: () => {
    setFretboardVisible(true);
    seekPlayback(0.86);
    if (document.getElementById("fretboardEdit")?.getAttribute("aria-pressed") !== "true") click("fretboardEdit");
  },
  [ACT.fbEditClose]: () => {
    if (document.getElementById("fretboardEdit")?.getAttribute("aria-pressed") === "true") click("fretboardEdit");
  },
  [ACT.rsExport]: () => {
    if (document.getElementById("rocksmithExportBackdrop")?.hidden) click("menuExportRocksmith");
  },
  [ACT.rsExportClose]: () => click("rsExportCancel"),
  // The metronome against a wrong tempo is the whole tempo lesson, so the step
  // that teaches it starts the song with the click on and the next one stops it.
  [ACT.metroPlay]: () => {
    const metro = document.getElementById("metro");
    if (metro && !metro.checked) click("metroToggle");
    if (!transportPlaying()) click("play");
  },
  [ACT.metroEnable]: () => {
    const metro = document.getElementById("metro");
    if (metro && !metro.checked) click("metroToggle");
  },
  [ACT.tempoReady]: () => {
    if (transportPlaying()) click("play");
    seekPlayback(0);
    if (railsHidden()) click("markerLanesToggle");
    scroll.scrollLeft = 0;
  },
  [ACT.tempoFix]: () => {
    bpmInput.value = "60";
    bpmInput.dispatchEvent(new Event("change", { bubbles: true }));
    offsetInput.value = "0.35";
    offsetInput.dispatchEvent(new Event("change", { bubbles: true }));
    click("markerPopClose");
    const metro = document.getElementById("metro");
    if (metro && !metro.checked) click("metroToggle");
  },
  [ACT.addBass]: async () => {
    closeAddStemMenu();
    return addTutorialBass();
  },
  [ACT.stop]: () => { if (transportPlaying()) click("play"); },
  [ACT.stopReset]: () => { if (transportPlaying()) click("play"); seekPlayback(0); },
};

// A step may wait for the reader to do the thing instead of paging on. Predicates
// polled on a timer rather than a dozen new events dispatched across the app: the
// question is always "is the project in the state this step was about", which the
// store already answers.
// A predicate returns a VALUE, not a verdict — startWaiting compares it against
// what it was when the step opened. So a count is a legal answer, and it is the
// right one wherever the lesson changes a number that was not zero: slicing adds
// notes to a lane that already has some, and "there are notes" was true before the
// reader touched anything.
const WAITS = {
  [UNTIL.playing]: () => transportPlaying(),
  [UNTIL.notes]: () => (S.state?.editLanes || []).reduce((n, lane) => n + (lane.notes?.length || 0), 0),
  [UNTIL.notePosition]: () => JSON.stringify((tutorialEditLane()?.notes || [])
    .map((note) => [note.id, note.start, note.pitch])),
  [UNTIL.noteLength]: () => JSON.stringify((tutorialEditLane()?.notes || [])
    .map((note) => [note.id, note.end - note.start])),
  [UNTIL.noteEffects]: () => JSON.stringify((tutorialEditLane()?.notes || [])
    .map((note) => [note.id, effectSignatureFields(note)])),
  [UNTIL.menuOpened]: () => walkthroughMenuOpenCount(),
  [UNTIL.noteNavigation]: () => playbackTime(),
  [UNTIL.shapeGroup]: () => new Set((tutorialEditLane()?.notes || []).map((note) => note.shapeId).filter(Boolean)).size,
  [UNTIL.refs]: () => (S.state?.editLanes || []).reduce((n, lane) => n + Object.keys(lane.refBoxes || {}).length, 0),
  // The one wait on a value rather than on a change: any keystroke in the field
  // changes the number, so "120" has to be the thing waited for or typing the 1
  // would advance the card.
  [UNTIL.tempo120]: () => Math.round(gridBpm()) === 120,
  [UNTIL.tempoPosition]: () => Math.abs(gridBpm() - 120) < 0.01 && Math.abs(gridOffset() - 0.35) < 0.005,
  [UNTIL.detectPanel]: () => !detectPanel?.hidden,
  [UNTIL.detectFinished]: () => detectCompletionCount(),
  [UNTIL.frame]: () => !!S.detectRegion && S.drag?.mode !== "region",
  [UNTIL.selection]: () => S.selection.size >= 2,
  [UNTIL.fretboardEdit]: () => document.getElementById("fretboardEdit")?.getAttribute("aria-pressed") === "true",
  [UNTIL.fretboardVisible]: () => fretboardVisible(),
  [UNTIL.fretboardOverride]: () => S.voicingRevision,
  [UNTIL.fretboardHandHold]: () => JSON.stringify(tutorialEditLane()?.handHolds || []),
  [UNTIL.matches]: () => S.matches.length,
  [UNTIL.tempoPop]: () => !document.getElementById("markerPop")?.hidden,
  [UNTIL.addMenu]: () => !!document.querySelector(".stem-add-menu"),
  [UNTIL.bass]: () => (S.state?.stems || []).some((stem) => stem.id === "bass"),
  [UNTIL.stemEditor]: () => !document.getElementById("stemSettingsBackdrop")?.hidden,
  [UNTIL.layerEditor]: () => !document.getElementById("layerSettingsBackdrop")?.hidden,
};
const WAIT_MS = 250;
const TASK_COMPLETE_DELAY_MS = 2000;

// Where a step points when the thing it is about is drawn on the canvas and is
// therefore not an element at all. Each returns a viewport rect, or null when
// what it names is off screen, which skips the step exactly as a missing ID does.
const markerBandRect = id => {
  const box = stage.getBoundingClientRect(), band = railBand(id);
  if (!band.h || railsHidden()) return null;
  return { left: box.left, top: box.top + band.y, width: box.width,
    height: Math.min(band.h, box.height - band.y) };
};
const SPOTS = {
  reference: () => {
    const box = S.refBoxRects?.[0];
    if (!box) return stage.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    const left = stageRect.left + box.x0 - scroll.scrollLeft;
    const right = stageRect.left + box.x1 - scroll.scrollLeft;
    const top = stageRect.top + box.y0 - scroll.scrollTop - 16;
    const bottom = stageRect.top + box.y1 - scroll.scrollTop;
    return {
      left: Math.max(view.left, left), top: Math.max(view.top, top),
      width: Math.max(24, Math.min(view.right, right) - Math.max(view.left, left)),
      height: Math.max(24, Math.min(view.bottom, bottom) - Math.max(view.top, top)),
    };
  },
  tempoMarker: () => firstMarkerViewportRect(),
  spectrogramArea: () => stage.getBoundingClientRect(),
  stage: () => stage.getBoundingClientRect(),
  layerBasics: () => {
    const first = document.querySelector("#spLayer .section:nth-child(1)")?.getBoundingClientRect();
    const second = document.querySelector("#spLayer .section:nth-child(2)")?.getBoundingClientRect();
    return first && second ? {
      left: Math.min(first.left, second.left), top: first.top,
      width: Math.max(first.right, second.right) - Math.min(first.left, second.left),
      height: second.bottom - first.top,
    } : null;
  },
  sectionFlags: () => markerBandRect("section"),
  phraseFlags: () => markerBandRect("phrase"),
  toneFlags: () => markerBandRect("tone"),
  markerArea: () => {
    const box = stage.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width,
      height: Math.min(box.height, railsBottom()) };
  },
};

// The lit rect gets 4px of air so the control is not touching the dark, and
// r8 — it is a control, and rule 2 gives a control 8.
const HALO = 4;
const GAP = 8;          // card to target: the popover offset
const EDGE = 8;         // card to viewport

let spot = null, extraSpot = null, card = null, els = null;
let steps = [], at = 0, doneLabel = "", tracking = 0, waiting = 0, nextChapter = "", currentChapter = "";
// Async project preparation and chapter handoffs must not reopen a card after exit.
let tourGeneration = 0;
let taskTransitionPending = false;
let manualCard = null, cardPlaced = false, dragging = null, confirmingClose = false;
const stepStates = new Map();
const stepStateKey = (index) => `${currentChapter}:${index}`;
function captureStepState() {
  return {
    project: S.state,
    edit: snapshotEdit(),
    selection: [...S.selection].map((note) => note.id),
    detectRegion: S.detectRegion && { ...S.detectRegion },
    undo: S.undoStack.slice(),
    redo: S.redoStack.slice(),
    laneMarkers: (S.state?.editLanes || []).map((lane) => ({
      id: lane.id,
      phraseBoundaries: structuredClone(lane.phraseBoundaries || []),
      toneMarkers: structuredClone(lane.toneMarkers || []),
    })),
  };
}

function restoreStepState(saved) {
  if (!saved || saved.project !== S.state) return;
  restoreEditSnapshot(saved.edit);
  for (const lane of S.state?.editLanes || []) {
    const markers = saved.laneMarkers?.find((item) => item.id === lane.id);
    if (!markers) continue;
    lane.phraseBoundaries = structuredClone(markers.phraseBoundaries);
    lane.toneMarkers = structuredClone(markers.toneMarkers);
  }
  const selected = new Set(saved.selection);
  setSelection(new Set((S.state?.editLanes || [])
    .flatMap((lane) => lane.notes).filter((note) => selected.has(note.id))));
  S.detectRegion = saved.detectRegion && { ...saved.detectRegion };
  S.undoStack = saved.undo.slice();
  S.redoStack = saved.redo.slice();
  updateUndoButtons();
  updateDetectStatus();
  draw();
}

const active = () => !!card;

async function requestCloseWalkthrough() {
  if (!active() || confirmingClose) return;
  confirmingClose = true;
  document.body.classList.add("tour-confirming");
  try {
    const confirmed = await confirmAction({
      title: "Leave walkthrough?",
      message: "Return to the main menu? The tutorial song will be discarded.",
      confirmLabel: "Return to main menu",
      cancelLabel: "Stay here",
    });
    if (!confirmed) return;
    end();
    await closeProject({ discardTutorial: true });
  } finally {
    confirmingClose = false;
    document.body.classList.remove("tour-confirming");
  }
}

function build() {
  spot = document.createElement("div");
  spot.className = "tour-spot";
  extraSpot = document.createElement("div");
  extraSpot.className = "tour-extra-spot";
  extraSpot.hidden = true;

  card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  card.addEventListener("mousedown", (e) => {
    if (!e.target.closest("button, input, select, textarea, a, [contenteditable]"))
      document.activeElement?.blur?.();
  });
  card.innerHTML = `
    <div class="tour-head">
      <button type="button" class="tour-drag" aria-label="Move walkthrough card" title="Move walkthrough card"><svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><circle cx="3" cy="4" r="1.3"/><circle cx="9" cy="4" r="1.3"/><circle cx="3" cy="10" r="1.3"/><circle cx="9" cy="10" r="1.3"/><circle cx="3" cy="16" r="1.3"/><circle cx="9" cy="16" r="1.3"/></svg></button>
      <span class="tour-heading"><span class="tour-section"></span><span class="tour-title"></span><span class="tour-tasks" role="list" aria-label="Step tasks" aria-live="polite" hidden></span></span>
      <span class="tour-count"></span>
    </div>
    <p class="tour-body"></p>
    <div class="tour-section-nav">
      <button type="button" class="tour-prev-section" aria-label="Previous section" title="Previous section"></button>
      <button type="button" class="tour-next-section" aria-label="Next section" title="Next section"></button>
    </div>
    <div class="tour-foot">
      <button type="button" class="btn btn--compact btn--ghost tour-close" title="Close walkthrough">Close</button>
      <span class="tour-foot-actions">
        <button type="button" class="btn btn--compact btn--secondary tour-back">Back</button>
        <button type="button" class="btn btn--compact btn--primary tour-next">Next</button>
        <button type="button" class="btn btn--compact btn--secondary tour-home" hidden>Go back to menu</button>
      </span>
    </div>`;

  els = {
    section: card.querySelector(".tour-section"),
    title: card.querySelector(".tour-title"),
    tasks: card.querySelector(".tour-tasks"),
    count: card.querySelector(".tour-count"),
    body: card.querySelector(".tour-body"),
    close: card.querySelector(".tour-close"),
    prevSection: card.querySelector(".tour-prev-section"),
    nextSection: card.querySelector(".tour-next-section"),
    back: card.querySelector(".tour-back"),
    next: card.querySelector(".tour-next"),
    home: card.querySelector(".tour-home"),
    foot: card.querySelector(".tour-foot"),
  };
  els.close.addEventListener("click", requestCloseWalkthrough);
  els.back.addEventListener("click", () => go(at - 1, -1));
  els.next.addEventListener("click", () => go(at + 1, 1));
  els.home.addEventListener("click", async () => {
    end();
    await closeProject({ discardTutorial: true });
  });
  els.section.textContent = `Section · ${TOURS[currentChapter].label}`;
  const sections = Object.keys(TOURS), sectionIndex = sections.indexOf(currentChapter);
  els.prevSection.disabled = sectionIndex <= 0;
  els.nextSection.disabled = sectionIndex >= sections.length - 1;
  els.prevSection.hidden = sectionIndex <= 0;
  els.nextSection.hidden = sectionIndex >= sections.length - 1;
  if (sectionIndex > 0) {
    const label = TOURS[sections[sectionIndex - 1]].label;
    els.prevSection.textContent = `← ${label}`;
    els.prevSection.title = `Previous section: ${label}`;
    els.prevSection.setAttribute("aria-label", els.prevSection.title);
  }
  if (sectionIndex < sections.length - 1) {
    const label = TOURS[sections[sectionIndex + 1]].label;
    els.nextSection.textContent = `${label} →`;
    els.nextSection.title = `Next section: ${label}`;
    els.nextSection.setAttribute("aria-label", els.nextSection.title);
  }
  els.prevSection.addEventListener("click", () => startTour(sections[sectionIndex - 1]));
  els.nextSection.addEventListener("click", () => startTour(sections[sectionIndex + 1]));
  card.querySelector(".tour-drag").addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = card.getBoundingClientRect();
    dragging = { x: e.clientX - r.left, y: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  card.querySelector(".tour-drag").addEventListener("pointermove", (e) => {
    if (!dragging) return;
    manualCard = { left: e.clientX - dragging.x, top: e.clientY - dragging.y };
    placeManualCard();
  });
  for (const type of ["pointerup", "pointercancel"]) card.querySelector(".tour-drag").addEventListener(type, () => { dragging = null; });
  document.body.append(spot, extraSpot, card);
  document.body.classList.add("tour-active");
}

function placeManualCard() {
  if (!manualCard || !card) return;
  const left = Math.max(EDGE, Math.min(manualCard.left, window.innerWidth - card.offsetWidth - EDGE));
  const top = Math.max(EDGE, Math.min(manualCard.top, window.innerHeight - card.offsetHeight - EDGE));
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
  manualCard = { left, top };
}

// A target that is gone or has no box cannot be pointed at. Skipping it is what
// lets one chapter run on a score-only project, where there is no stem list.
//
// Three kinds, in the order they are tried: a rect drawn on the canvas (`spot`),
// an element found by selector (`sel` — for rows and menus built in JS, which
// have no IDs to give), and an element ID, which is still the common case and
// the only kind tour.test.mjs can check against the markup.
function rectOf(step) {
  if (step.noSpot) return null;
  if (step.menuSpot) {
    const menu = [...document.querySelectorAll(".ctxmenu")].find((node) => !node.hidden && node.querySelector(".ctxmenu-item"));
    if (menu) {
      const r = menu.getBoundingClientRect();
      if (r.width && r.height) return { el: menu, r };
    }
  }
  if (step.spot) {
    const r = SPOTS[step.spot]?.();
    return r ? { el: stage, r } : null;
  }
  const el = step.sel ? document.querySelector(step.sel) : document.getElementById(step.target);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { el, r } : null;
}

// Below the target, flipped above when there is no room, clamped either way.
// The four marker popovers each clamp a POINT; this anchors a rect and flips,
// so it borrows nothing from them and adds no fifth copy of that arithmetic.
function place(r, step) {
  if (manualCard) return placeManualCard();
  if (step.lockCard && cardPlaced) return;
  const w = card.offsetWidth, h = card.offsetHeight;
  if (step.placement === "top-right") {
    card.style.left = `${Math.round(window.innerWidth - w - EDGE)}px`;
    const top = Math.max(EDGE, Math.min(r.top + HALO + GAP, window.innerHeight - h - EDGE));
    card.style.top = `${Math.round(top)}px`;
    cardPlaced = true;
    return;
  }
  const right = r.left + r.width;
  if (step.placement === "side") {
    const sideGap = HALO + GAP;
    const sideLeft = right + sideGap + w + EDGE <= window.innerWidth ? right + sideGap
      : r.left - sideGap - w >= EDGE ? r.left - sideGap - w : null;
    if (sideLeft !== null) {
      card.style.left = `${Math.round(sideLeft)}px`;
      card.style.top = `${Math.round(Math.max(EDGE, Math.min(r.top, window.innerHeight - h - EDGE)))}px`;
      cardPlaced = true;
      return;
    }
  }
  if (step.placement === "right" && right + HALO + GAP + w + EDGE <= window.innerWidth) {
    card.style.left = `${Math.round(right + HALO + GAP)}px`;
    card.style.top = `${Math.round(Math.max(EDGE, Math.min(r.top, window.innerHeight - h - EDGE)))}px`;
    cardPlaced = true;
    return;
  }
  const below = r.top + r.height + HALO + GAP;
  const above = r.top - HALO - GAP - h;
  const top = below + h + EDGE <= window.innerHeight || above < EDGE ? below : above;

  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE));

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE)))}px`;
  cardPlaced = true;
}

// The last rect written, so a frame that measures the same numbers writes nothing.
// Reading a rect every frame is cheap; writing styles every frame is not. `null`
// is "nothing written yet" and `""` is "parked", which are not the same state: the
// first still owes the card a position.
let painted = null;
let revealedTarget = null;

function revealTarget(el = null) {
  if (revealedTarget === el) return;
  revealedTarget?.classList.remove("tour-revealed");
  revealedTarget = el?.matches?.(".edit-btn, .stem-btn.edit") ? el : null;
  revealedTarget?.classList.add("tour-revealed");
}

function paint() {
  const hit = rectOf(steps[at]);
  revealTarget(hit?.el);
  // Nothing to light yet. A step that is WAITING for the reader to open
  // something is on screen before the thing it points at exists — the card that
  // says "open the layer settings" is the reason the settings will be there — so
  // it parks in the middle with no hole in the dim rather than ending the
  // chapter, and lands on its target the moment one appears.
  if (!hit) return park();
  const extra = steps[at]?.extraTarget && document.querySelector(steps[at].extraTarget)?.getBoundingClientRect();
  extraSpot.hidden = !extra || !extra.width || !extra.height;
  if (!extraSpot.hidden) {
    extraSpot.style.left = `${Math.round(extra.left - HALO)}px`;
    extraSpot.style.top = `${Math.round(extra.top - HALO)}px`;
    extraSpot.style.width = `${Math.round(extra.width + HALO * 2)}px`;
    extraSpot.style.height = `${Math.round(extra.height + HALO * 2)}px`;
  }
  const { r } = hit;
  spot.classList.toggle("tour-spot--action",
    !!hit.el.matches?.("button, input, select, [role='button'], .ctxmenu") || steps[at]?.spot === "tempoMarker");
  const key = `${Math.round(r.left)} ${Math.round(r.top)} ${Math.round(r.width)} ${Math.round(r.height)}`;
  if (key === painted) return;
  painted = key;
  spot.hidden = false;
  // The slide between targets is only earned once there IS a previous target;
  // on the first paint the spot has no position and would swipe in from the
  // corner, which is motion that says nothing (see Motion in CLAUDE.md).
  const first = !spot.classList.contains("is-live");
  spot.style.left = `${Math.round(r.left - HALO)}px`;
  spot.style.top = `${Math.round(r.top - HALO)}px`;
  spot.style.width = `${Math.round(r.width + HALO * 2)}px`;
  spot.style.height = `${Math.round(r.height + HALO * 2)}px`;
  if (first) requestAnimationFrame(() => spot && spot.classList.add("is-live"));
  place(r, steps[at]);
}


function park() {
  extraSpot.hidden = true;
  if (painted === "") return;
  painted = "";
  spot.hidden = true;
  if (manualCard) return placeManualCard();
  card.style.left = `${Math.round(Math.max(EDGE, (window.innerWidth - card.offsetWidth) / 2))}px`;
  card.style.top = `${Math.round(Math.max(EDGE, (window.innerHeight - card.offsetHeight) / 2))}px`;
  cardPlaced = true;
}

// The spotlight follows a live element, and an element moves for reasons no event
// reports: a panel sliding open, a list re-rendering under it, a menu finding its
// anchor, a row arriving above it. Scroll and resize were the only two it heard,
// so everything else left the hole behind on the screen. So it measures every
// frame — the read is cheap, and `painted` keeps the write down to the frames
// where something actually moved.
function track() {
  tracking = requestAnimationFrame(track);
  if (active()) paint();
}

// A step that waits polls one predicate until the reader has done the thing.
// Cleared on every move, so a chapter can never be watching two steps at once.
function stopWaiting() {
  if (waiting) { clearInterval(waiting); waiting = 0; }
}

const taskSpecs = (step) => step.tasks || (step.until
  ? [{ label: step.task || step.title, until: step.until }] : []);

function showTasks(step) {
  const tasks = taskSpecs(step);
  els.tasks.replaceChildren();
  els.tasks.hidden = !tasks.length;
  for (const task of tasks) {
    const row = document.createElement("span");
    row.className = "tour-task";
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-label", `Pending: ${task.label.replace(/\[\[(.*?)\]\]/g, "$1")}`);
    const icon = document.createElement("span");
    icon.className = "tour-task-icon";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    renderInstruction(label, task.label);
    row.append(icon, label);
    els.tasks.append(row);
  }
}

function startWaiting(step) {
  const states = taskSpecs(step).map(({ until }, index) => ({
    done: WAITS[until], was: WAITS[until]?.(), icon: els.tasks.children[index]?.firstChild,
    complete: false,
  }));
  if (!states.length || states.some((task) => !task.done)) return;
  waiting = setInterval(() => {
    if (!active() || steps[at] !== step) return stopWaiting();
    if (S.drag) return;
    for (const task of states) {
      if (task.complete || task.done() === task.was) continue;
      task.complete = true;
      task.icon.classList.add("is-done");
      task.icon.textContent = "✓";
      const row = task.icon.parentElement;
      row.setAttribute("aria-label", row.getAttribute("aria-label").replace(/^Pending:/, "Complete:"));
    }
    if (!states.every((task) => task.complete)) return;
    stopWaiting();
    // The completed card stays up for two seconds. Do not let its old allow
    // rules start another gesture that will still be active on the next card.
    taskTransitionPending = true;
    els.next.disabled = true;
    painted = null;
    waiting = setTimeout(() => {
      waiting = 0;
      if (active() && steps[at] === step) go(at + 1, 1);
    }, TASK_COMPLETE_DELAY_MS);
  }, WAIT_MS);
}

// `dir` is which way we were travelling, so a step whose target turns out not
// to be there is stepped OVER rather than ending the chapter — an action is the
// reason it cannot be decided up front.
async function go(i, dir = 1, departingStep = steps[at]) {
  if (i < 0) {
    const previous = previousTourStep(currentChapter, 0);
    if (!previous) return;
    stopWaiting();
    const generation = tourGeneration;
    if (departingStep?.back) await ACTIONS[departingStep.back]();
    if (!active() || generation !== tourGeneration) return;
    await startTour(previous.chapter, true, previous.step, -1);
    return;
  }
  if (i !== at && (steps[at]?.until === UNTIL.detectFinished || steps[at]?.detectModel)) {
    cancelPendingDetection();
    requireDetectModel(null);
  }
  // Past the last card, a chapter either ends or hands over. Handing over is what
  // makes the replayable topics one continuous read for somebody on their first
  // hour, without another chapter existing just to hold them together.
  if (i >= steps.length) {
    const hand = nextChapter;
    if (hand) await startTour(hand, true);
    else end();
    return;
  }
  if (steps[at]?.allowMenuInspect && i !== at) {
    document.querySelectorAll(".ctxmenu").forEach((menu) => { menu.hidden = true; });
  }
  stopWaiting();
  const step = steps[i];
  // Save the state from BEFORE a step acts or the reader follows its instruction.
  // Returning to that card restores the same starting point, including note and
  // reference edits made by the reader while that card was open.
  if (dir < 0) restoreStepState(stepStates.get(stepStateKey(i)));
  // Restoring an edit invalidates open marker popovers. Apply the departing
  // card's window action afterwards so Back lands with the right window open.
  if (dir < 0 && departingStep?.back) {
    await ACTIONS[departingStep.back]();
    if (!active()) return;
  }
  stepStates.set(stepStateKey(i), captureStepState());
  restrictContextMenuTo(step.allowMenu || null);
  if (step.detectModel || step.until === UNTIL.detectFinished) {
    requireDetectModel(step.detectModel || "torchcrepe");
    updateDetectStatus();
  }
  const addingBass = step.do === ACT.addBass;
  if (addingBass) { els.next.disabled = true; els.back.disabled = true; }
  const actionResult = step.do ? await ACTIONS[step.do]() : undefined;
  if (actionResult === false) {
    if (addingBass && active()) { els.next.disabled = false; els.back.disabled = false; }
    return;
  }
  if (!active()) return;          // Escape landed while the action was running
  const hit = rectOf(step);
  // A step with nothing to point at is stepped over — that is what lets a chapter
  // survive a project with no audio list. A step that WAITS is never stepped
  // over: what it points at is what the reader is being asked to open, so it is
  // absent exactly when the card matters most.
  if (!hit && !step.until && !step.noSpot) return go(i + dir, dir);
  // A drag is a correction for this card only. The next step gets its own
  // automatic placement, then can be moved independently if it gets in the way.
  if (i !== at) manualCard = null;
  at = i;
  cardPlaced = false;

  els.title.textContent = step.title;
  showTasks(step);
  els.count.textContent = `${at + 1} / ${steps.length}`;
  renderInstruction(els.body, step.body);
  els.back.disabled = !previousTourStep(currentChapter, at);
  const last = at === steps.length - 1;
  // The last card names its destination. Close and section jumps remain available
  // throughout the tour, including the final card.
  els.next.textContent = taskSpecs(step).length ? "Skip" : last ? doneLabel : "Next";
  els.home.hidden = !(last && !nextChapter);
  els.foot.classList.toggle("tour-foot--final", last && !nextChapter);
  // Action cards offer an explicit Skip while their task list waits.
  els.next.disabled = false;
  taskTransitionPending = false;
  startWaiting(step);
  // The card is a new size and may want a new side of the same rect, so the next
  // frame repaints even when the target has not moved.
  painted = null;

  if (hit && hit.el !== stage) hit.el.scrollIntoView({ block: "nearest", inline: "nearest" });
  // The frame loop lands it: after the scroll, and again on every frame of a panel
  // sliding open, which is what used to need a timeout guessing at the duration.
}

// A capture listener admits the current card's controls and gestures. A waiting
// state alone is not permission to operate the whole editor: the tempo card,
// for example, accepts a click on its flag and blocks other buttons.
const GUARDED = ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel",
  "keydown", "keypress", "keyup"];

function guard(e) {
  if (!active() || tourClick || confirmingClose) return;
  if (e.type === "keydown") {
    const key = e.key;
    // Focus navigation must reach the shared modal trap even on read-only steps.
    if (key === "Tab") return;
    if (card.contains(e.target) && e.target.matches?.("select, input, textarea")) {
      if (key !== "Escape") return;
    }
    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestCloseWalkthrough();
      return;
    }
  }
  if (card.contains(e.target)) return;
  // Release events must reach the editor so a held key or mouse gesture can
  // finish; all new app actions wait until the next card is ready.
  if (taskTransitionPending) {
    if (e.type === "keyup" || e.type === "mouseup") return;
    return blockTourEvent(e);
  }
  if (e.type === "keyup" && (e.key === "s" || e.key === "S") && S.sliceHeld) return;
  const step = steps[at];
  if (step?.until === UNTIL.frame && e.type === "mouseup" && S.drag?.mode === "region") return;
  if (step?.lockApp) {
    if (step.allow && e.target.closest?.(step.allow)) return;
    return blockTourEvent(e);
  }
  if (step?.freeApp === true) return;
  if (step?.freeApp) {
    if (e.target.closest?.(step.freeApp)) return;
    return blockTourEvent(e);
  }
  if (step?.until || step?.allowMenuInspect) {
    const scoped = step.allow || step.allowSpot || step.allowMenu || step.allowKeys;
    if (!scoped) return; // older chapters retain their existing open interaction
    if (step.allow && e.target.closest?.(step.allow)) return;
    if (step.allowKeys?.includes(e.key)) return;
    if (step.allowMenu && e.target.closest?.(".ctxmenu-item")?.textContent.startsWith(step.allowMenu)) return;
    const allowedButtons = step.allowButtons || (step.allowButton === undefined ? null : [step.allowButton]);
    const buttonMatches = !allowedButtons || allowedButtons.some((button) =>
      e.type === "mousemove" ? !!(e.buttons & (1 << button)) : e.button === button);
    if (step.allowSpot && e.target === stage && e.clientX !== undefined && buttonMatches) {
      if (step.requireModifier === "Shift" && !e.shiftKey) return blockTourEvent(e);
      if (step.requireModifier === "Alt" && !e.altKey) return blockTourEvent(e);
      if (step.requireModifier === "S" && !S.sliceHeld) return blockTourEvent(e);
      const r = SPOTS[step.allowSpot]?.();
      if (r && e.clientX >= r.left && e.clientX <= r.left + r.width &&
          e.clientY >= r.top && e.clientY <= r.top + r.height) return;
    }
    return blockTourEvent(e);
  }
  blockTourEvent(e);
}

function blockTourEvent(e) {
  e.preventDefault();
  e.stopPropagation();
}

function end({ preserveHistory = false } = {}) {
  tourGeneration++;
  if (!preserveHistory) stepStates.clear();
  if (!active()) return;
  restrictContextMenuTo(null);
  clearMatches();
  cancelPendingDetection();
  requireDetectModel(null);
  closeAddStemMenu();
  if (!detectPanel?.hidden) click("detectClose");
  if (!document.getElementById("markerPop")?.hidden) click("markerPopClose");
  if (!document.getElementById("settingsModalBackdrop")?.hidden) click("settingsCancel");
  if (!document.getElementById("stemSettingsBackdrop")?.hidden) click("stemCancel");
  if (!document.getElementById("layerSettingsBackdrop")?.hidden) click("layerCancel");
  document.querySelectorAll(".ctxmenu").forEach((menu) => { menu.hidden = true; });
  if (transportPlaying()) click("play");
  seekPlayback(0);
  stopWaiting();
  taskTransitionPending = false;
  cancelAnimationFrame(tracking); tracking = 0;
  for (const type of GUARDED) window.removeEventListener(type, guard, true);
  revealTarget();
  spot.remove(); extraSpot.remove(); card.remove();
  document.body.classList.remove("tour-active");
  spot = extraSpot = card = els = null;
  painted = null;
  manualCard = null; cardPlaced = false; dragging = null;
  steps = []; at = 0; nextChapter = ""; currentChapter = "";
}

/**
 * Run a chapter now. Every step in it runs; a target that is genuinely missing
 * when its step opens is stepped over by go(), which is the only moment the
 * question has an answer.
 * @param {keyof TOURS} name
 */
export async function startTour(name, continueProject = false, initialStep = 0, dir = 1) {
  const chapter = TOURS[name];
  if (!chapter) return;
  end({ preserveHistory: continueProject });
  const generation = tourGeneration;

  // Starting a chapter on its own rebuilds the tutorial project. A handoff keeps
  // the current tutorial song so work such as stem separation and tempo survives.
  if (chapter.project && !continueProject && await ACTIONS[chapter.project]() === false) return;
  if (generation !== tourGeneration) return;
  if (!continueProject && name !== FIRST && name !== "audio") {
    if (await addTutorialBass() === false) return;
    if (generation !== tourGeneration) return;
    // A direct jump to the drawing lessons starts after the tempo exercise.
    if (name !== "tempo") {
      bpmInput.value = "120";
      offsetInput.value = "0.35";
      S.appliedGrid = currentGridState();
      draw();
    }
  }

  // Nothing is filtered out up front. Whether a step can be pointed at is not a
  // question the START of a chapter can answer — most of what it points at is
  // opened later, by a step that acts or by the reader — and every wrong answer
  // is a card that vanishes. It measured "The audio editor" against a window
  // nobody had opened yet, dropped it, and made the card before it read as a
  // button that skips a step. go() steps over a target that is still missing when
  // the step actually runs, which is the same guard asked at the only moment it
  // can be answered.
  if (!chapter.steps.length || S.state?.job !== "tutorial" || generation !== tourGeneration) return;

  steps = chapter.steps;
  currentChapter = name;
  doneLabel = chapter.done;
  nextChapter = TOURS[chapter.next] ? chapter.next : "";
  build();
  // Capture, and registered before any panel of the app's own opens one: the
  // walkthrough is the topmost thing on screen, so it sees every event first and
  // decides whether the app hears it at all.
  for (const type of GUARDED) window.addEventListener(type, guard, true);
  track();
  await go(initialStep, dir, null);
}

// One way in: the Walkthrough card on the landing page, which runs the first
// chapter and hands over from there.
//
// It used to be eight rows in the editor's Help menu, and before that it fired
// itself the first time a project opened, with a "seen" flag in localStorage.
// Both are gone. A chapter opens the TUTORIAL song, so firing on its own would
// take somebody's freshly imported project off the screen the moment they first
// saw it — and offering it from inside a project offers to close that project.
// The landing page is where you are when you have nothing open, which is exactly
// when a walkthrough is what you want. The editor's Help menu went with it
// rather than hanging there with nothing in it.
export function init_tour() {
  document.getElementById("welcomeTour")?.addEventListener("click", () => startTour(FIRST));
  window.addEventListener("cw-project-closed", end);
}
