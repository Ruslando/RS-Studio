// Project lifecycle: the self-contained .chart save/open bundle, unsaved-change
// tracking, the stem tab strip, and applying a loaded project's state into the
// editor.
//
// This module owns "is a project open" — the one place that decides whether the
// editor or the launcher is on screen, and the one place a project's state is
// built up or torn down. Three screens hang off it and none of them import back;
// each is handed its callbacks in init_project:
//
//   project-library.js   the launcher + the Open-project picker
//   new-project.js       the New Project modal (it owns its own draft)
//   stem-settings.js     the stem panel (its buttons call the ops below)

import { operationRequest } from "./operation-progress.js";
import { INSTRUMENTS, PX_PER_SEC, ZOOM_MAX_X, ZOOM_MAX_Y, ZOOM_MIN_X, ZOOM_MIN_Y, instrKey, toneKey } from "./constants.js";
import { confirmChoice } from "./dialog.js";
import { updateDetectStatus } from "./detect.js";
import { appshell, attachAudioBtn, audio, bpmInput, clearArriving, closeProjBtn, detectStemNameEl, goBtn, homeBtn, inTourCard, offsetInput, openBtn, openFileInput, projDirtyDot, projTab, projTabName, saveAsBtn, saveBtn, speedSel, statusEl, stemTabsEl, tsDenInput, tsNumInput, warnEl } from "./dom.js";
import { draw } from "./repaint.js";
import { icon } from "./icons.js";
import { toggleStemMute, updateUndoButtons } from "./edit.js";
import { layout, syncRowHeight, updateZoomLabels } from "./geometry.js";
import { beatsPerBar, currentGridState, gridBpm, gridOffset, gridSubdiv, setSubdiv } from "./grid.js";
import { dedupeIds, syncUidPastLoaded } from "./ids.js";
import { rebuildLanes, renderLanes } from "./lanes.js";
import { metadataPayload, normalizeMetadata } from "./metadata.js";
import { applyPreservePitch, disposeSynths, ensureStemMixer, isMasterStem, masterStemAudible, pauseTransport, refreshStemAudio, resetStemMixer, toggleStemSolo, warmSynths } from "./playback.js";
import { initNewProject, openNewProject, refreshChoosingCards, setMainFile } from "./new-project.js";
import { hideWelcome, initProjectLibrary, showWelcome } from "./project-library.js";
import { loadSeparators, separators } from "./separators.js";
import { closeStemSettings, initStemSettings, openStemSettings } from "./stem-settings.js";
import { downloadProjectBlob, toast } from "./notify.js";
import { loadWithScreen } from "./project-loading.js";
import { S } from "./store.js";
import { coverScoreDuration, normalizeScoreBars } from "./score-structure-core.js";
import { normalizedLaneFields } from "./marker-rails.js";
import { normalizeSectionMarkers, sectionMarkersFromScoreBars } from "./section-marker-core.js";
import { inferTablatureEnabled } from "./layer-role.js";
import { cleanupShapeMembership } from "./shapes.js";
import { isValidTuningKey, setView } from "./tablature.js";
import { clearMatches, prepareSpectSample } from "./tracing.js";
import { clamp, normLayerVolume } from "./util.js";

function setStatus(msg, busy) { statusEl.textContent = msg || ""; goBtn.disabled = !!busy; }

// ---- project save / open (self-contained .chart files) ----
// Snapshot the editor state in the shape the server merges into the manifest.
function projectBody() {
  const serialize = (l) => ({
    id: l.id, name: l.name, kind: l.kind, color: l.color, visible: l.visible,
    locked: !!l.locked,
    instrument: l.instrument, tone: l.tone, tuning: l.tuning, customTuning: l.customTuning,
    volume: normLayerVolume(l.volume),
    muted: l.muted, active: l.active, tablatureEnabled: l.tablatureEnabled !== false,
    ...(l.rocksmithArrangement ? { rocksmithArrangement: l.rocksmithArrangement } : {}), notes: l.notes,
    ...normalizedLaneFields(l, Number(S.state.duration) || Infinity),
    ...(l.fingeringMode ? { fingeringMode: l.fingeringMode } : {}),
    ...(Number.isFinite(l.gmProgram) ? { gmProgram: l.gmProgram } : {}),
    ...(Number.isFinite(l.sourceTrackIndex) ? { sourceTrackIndex: l.sourceTrackIndex } : {}),
    ...(Number.isFinite(l.sourceStaffIndex) ? { sourceStaffIndex: l.sourceStaffIndex } : {}),
    ...(Number.isFinite(l.capo) ? { capo: l.capo } : {}),
    ...(Number.isFinite(l.transpositionPitch) ? { transpositionPitch: l.transpositionPitch } : {}),
    ...(Number.isFinite(l.displayTranspositionPitch) ? { displayTranspositionPitch: l.displayTranspositionPitch } : {}),
    ...(l.refBoxes && Object.keys(l.refBoxes).length ? { refBoxes: l.refBoxes } : {}),
    // Where the player put the fretting hand, in seconds. Written only when there is
    // one, so an untouched project gains no field.
    ...(l.handHolds?.length ? { handHolds: l.handHolds.map((h) => ({ t: h.t, fret: h.fret })) } : {}),
  });
  return {
    name: (S.state.name || S.state.filename || "Untitled"),
    metadata: metadataPayload(S.state.metadata || {}),
    // Audio-mixer choices belong to the project too. Keep the persisted shape
    // deliberately small: audio/spectrogram metadata remains server-owned.
    stemSettings: S.state.stems.map((stem) => ({
      id: stem.id, muted: !!stem.muted, solo: !!stem.solo,
    })),
    editLanes: S.state.editLanes.map(serialize),
    ...(S.state.guitarPro ? { guitarPro: S.state.guitarPro } : {}),
    sectionMarkers: normalizeSectionMarkers(S.state.sectionMarkers || [], Number(S.state.duration) || Infinity),
    scoreBars: (S.state.scoreBars || []).map((bar) => ({ ...bar })),
    scoreDuration: Number(S.state.scoreDuration) || Number(S.state.duration) || 1,
    view: { stem: S.state.curStem, zoomX: S.zoomX, zoomY: S.zoomY, speed: speedSel.value },
    grid: {
      bpm: gridBpm(), offset: gridOffset(), subdiv: gridSubdiv(),
      snap: true, showGrid: true,
      tsNum: beatsPerBar(), tsDen: parseInt(tsDenInput.value, 10) || 4,
      tempoMap: (S.state.tempoMap || []).map((m) => ({ t: +m.t, bpm: +m.bpm, tsNum: +m.tsNum, tsDen: +m.tsDen, subdiv: +m.subdiv || gridSubdiv() })),
    },
  };
}

function projectFileName() {
  return (projectBody().name || "project").replace(/[^A-Za-z0-9._ -]+/g, "_") + ".chart";
}

async function projectBundle() {
  if (!S.state) return;
  const res = await fetch(`/api/projects/${S.state.job}/export`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(projectBody()),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "save failed");
  return { blob: await res.blob(), name: projectFileName() };
}

// Persist the current editor state into the project's library folder (its .runs
// dir). This is a true in-place save that works in every browser; reopening the
// project from the library reflects it.
export async function saveToServer() {
  if (S.state?.job === "tutorial") throw new Error("The walkthrough project cannot be saved");
  const res = await fetch(`/api/projects/${S.state.job}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(projectBody()),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "save failed");
}

// ---- unsaved-changes tracking + open-project tab ----
// Dirty = the content that only persists on an explicit Save (notes, grid, and
// mixer settings) has diverged from the last saved/loaded baseline. View state
// (zoom/stem/speed) is deliberately excluded so panning or zooming never reads
// as "unsaved". Metadata, stem edits and cover changes auto-save to the server,
// so they aren't tracked here.
let savedSig = null;

function dirtySig() {
  const b = projectBody();
  return JSON.stringify({ editLanes: b.editLanes, grid: b.grid, sectionMarkers: b.sectionMarkers,
    scoreBars: b.scoreBars, scoreDuration: b.scoreDuration, stemSettings: b.stemSettings });
}

function isDirty() { return !!S.state && S.state.job !== "tutorial" && dirtySig() !== savedSig; }

// The current state is now the clean baseline (call after a successful save/export
// or a fresh load). Also refreshes the tab.
export function markSaved() { savedSig = S.state ? dirtySig() : null; refreshSaveState(); }

// Reflect the open project + dirty state in the app-bar tab.
export function refreshSaveState() {
  if (!projTab) return;
  if (!S.state) { projTab.hidden = true; return; }
  projTab.hidden = false;
  projTabName.textContent = S.state.name || S.state.filename || "Untitled";
  projDirtyDot.hidden = !isDirty();
  saveBtn.disabled = S.state.job === "tutorial";
  saveAsBtn.disabled = S.state.job === "tutorial";
}

function projectLabel() { return S.state ? (S.state.name || S.state.filename || "Untitled") : ""; }

// Leaving a project throws away everything since the last save, so ask first.
// True when it is safe to proceed: saved, discarded, or nothing to lose.
export async function confirmLeave() {
  if (!isDirty()) return true;
  const choice = await confirmChoice({
    title: `Save changes to “${projectLabel()}”?`,
    message: "Your edits since the last save will be lost.",
    confirmLabel: "Save",
    discardLabel: "Don't save",
  });
  if (choice === "cancel") return false;
  return choice === "discard" || await saveProject();
}

// Save model:
//   • Save (Ctrl+S) → persist editor state into the project's library folder
//     in place. Works in every browser; reopening from the library reflects it.
//   • Export .chart (Ctrl+Shift+S) → download a portable, self-contained .chart
//     snapshot to import later or on another machine. It is NOT live-linked —
//     edits after export go to the library, not the file.
// True when the project is on disk afterwards — confirmLeave must not let go of
// unsaved work because a save failed.
export async function saveProject({ saveAs = false } = {}) {
  if (!S.state) return false;
  if (S.state.job === "tutorial") {
    toast("Walkthrough changes are temporary", 2200);
    return false;
  }
  setStatus(saveAs ? "exporting…" : "saving…", true);
  try {
    if (saveAs) {
      const { blob, name } = await projectBundle();
      downloadProjectBlob(blob, name);
      toast(`Exported ${name}`, 2200, "ok");
    } else {
      await saveToServer();
      toast("Saved", 2200, "ok");
    }
    setStatus("", false);   // save feedback is the (auto-fading) toast, not a lingering status line
    markSaved();
    return true;
  } catch (e) {
    setStatus("save error: " + e.message, false);
    toast("Couldn't save: " + e.message, 2200, "error");
    return false;
  }
}

// Import = upload a .chart; the server extracts it into a fresh library folder and
// returns the same payload shape as analyze, so the editor just restores it.
async function openProjectFile(file) {
  if (!file) return;
  await loadWithScreen(async () => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/projects/import", { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Import failed");
    applyProject(await res.json());
    await waitForProjectVisuals();
  });
}

// Import a .chart into the library. The hidden file input works in every browser;
// the imported project then lives in the library, not the picked file.
export async function openProject() {
  if (!await confirmLeave()) return;
  openFileInput.click();
}

async function attachAudio(file) {
  if (!S.state || S.state.stems.length || !file) return;
  setStatus(`attaching ${file.name}...`, true);
  try {
    await saveToServer();
    const body = new FormData();
    body.append("audio", file);
    const response = await fetch(`/api/projects/${S.state.job}/audio`, { method: "POST", body });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || "attach failed");
    applyProject(await response.json());
    toast("Audio attached");
  } catch (error) {
    setStatus(`attach error: ${error.message}`, false);
  }
}

function chooseAudioAttachment() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "audio/*,.mp3,.wav,.flac,.m4a,.ogg,.opus,.aac,.aiff";
  input.addEventListener("change", () => attachAudio(input.files[0]), { once: true });
  input.click();
}

// Return the UI to its initial "no project open" state.
// Notes/lanes share one object shape in every lane, so copy-paste is trivial.
export function mapLane(l) {
  const instrument = instrKey(l.instrument);
  // Before the split, one key named the instrument *and* its sound, so a project
  // with no `tone` has it spelled in `instrument`: guitar_dist is an electric with
  // a pedal on. toneKey knows the old vocabulary, so reading the old field is the
  // whole migration.
  const tone = toneKey(l.tone ?? l.instrument);
  // `source` named the tool that made each note — "trace", "pasted", a detector's
  // own label. Nothing displayed it and one migration heuristic read it, so it is
  // dropped on the way in and the next save writes the project without it. A note
  // is a note however it got there.
  const notes = (l.notes || []).map(({ source, ...n }) => n);
  cleanupShapeMembership(notes);
  // Keep a valid tuning preset key / "custom"; older projects had none, so fall
  // back to the instrument's default tuning.
  const tuningOk = isValidTuningKey(l.tuning);
  return {
    id: l.id, name: l.name, kind: "edit", color: l.color,
    visible: l.visible !== false, active: !!l.active, locked: !!l.locked,
    instrument,
    tone,
    tuning: tuningOk ? l.tuning : INSTRUMENTS[instrument].tuning,
    customTuning: l.customTuning || "",
    volume: normLayerVolume(l.volume),
    // "none" was the old field's way of saying a layer makes no sound. There is no
    // silent tone — the lane already has two controls for that — so it migrates to
    // the one the UI can show, rather than becoming a fourth state nothing draws.
    muted: !!l.muted || l.instrument === "none",
    tablatureEnabled: inferTablatureEnabled(l),
    rocksmithArrangement: ["none", "lead", "rhythm", "alt_lead", "alt_rhythm", "bonus_lead", "bonus_rhythm", "bass", "alt_bass", "bonus_bass"].includes(l.rocksmithArrangement)
      ? l.rocksmithArrangement : undefined,
    // Read back defensively: a bad fret or a bad time is dropped rather than
    // reaching the voicer, where it would move a hand nobody put.
    handHolds: Array.isArray(l.handHolds)
      ? l.handHolds
        .map((h) => ({ t: Number(h?.t), fret: Number(h?.fret) }))
        .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.fret) && h.fret >= 0)
        .sort((a, b) => a.t - b.t)
      : [],
    fingeringMode: l.fingeringMode === "exact" ? "exact" : "automatic",
    gmProgram: Number.isFinite(l.gmProgram) ? l.gmProgram : undefined,
    sourceTrackIndex: Number.isFinite(l.sourceTrackIndex) ? l.sourceTrackIndex : undefined,
    sourceStaffIndex: Number.isFinite(l.sourceStaffIndex) ? l.sourceStaffIndex : undefined,
    capo: Number.isFinite(l.capo) ? l.capo : 0,
    transpositionPitch: Number.isFinite(l.transpositionPitch) ? l.transpositionPitch : 0,
    displayTranspositionPitch: Number.isFinite(l.displayTranspositionPitch) ? l.displayTranspositionPitch : 0,
    notes,
    ...normalizedLaneFields(l),
    refBoxes: l.refBoxes && typeof l.refBoxes === "object" ? l.refBoxes : {},
  };
}

// Restore the full editor from a project payload (same shape from analyze & load).
// Load a project payload into the editor. Nine phases, in an order that matters:
//
//   1. tear down whatever was open (synths, the stem panel)
//   2. rebuild the SCORE STRUCTURE — bars first, because section markers snap to
//      bar boundaries and the migration below reads them
//   3. migrate section markers, which were briefly saved per layer
//   4. build S.state
//   5. repair ids, so freshly minted ones cannot collide with loaded ones
//   6. restore the active layer
//   7. restore view settings (stem, zoom, speed)
//   8. restore the grid, then the stem mixer
//   9. show the editor and paint
//
// Anything reading S.state must come after phase 4; anything minting an id must
// come after phase 5.
let projectVisuals = Promise.resolve();
export const waitForProjectVisuals = () => projectVisuals;

export function applyProject(data) {
  projectVisuals = Promise.resolve();
  // 1. tear down the previous project
  disposeSynths();
  closeStemSettings();   // an open stem panel targets the previous project's stem

  // 2. score structure
  const restoredBars = normalizeScoreBars(data.scoreBars?.length ? data.scoreBars : data.guitarPro?.score?.masterBars,
    Number(data.scoreDuration) || Number(data.guitarPro?.score?.durationSeconds) || Number(data.duration));
  const noteEnd = Math.max(0, ...(data.editLanes || []).flatMap((lane) => (lane.notes || []).map((note) => Number(note.end) || 0)));
  const coveredBars = coverScoreDuration(restoredBars, Math.max(Number(data.duration) || 0, Number(data.scoreDuration) || 0, noteEnd));
  const sourceLanes = data.editLanes || [];

  // 3. section markers. Briefly, they were saved per layer. Fold those saves back into
  // the global song structure and deduplicate the cloned migration copies.
  const layerSections = sourceLanes.flatMap((lane) => lane.sectionMarkers || []);
  const sectionSource =
    Array.isArray(data.sectionMarkers) && data.sectionMarkers.length
      ? data.sectionMarkers
      : layerSections.length ? layerSections : sectionMarkersFromScoreBars(coveredBars);
  const restoredSections = normalizeSectionMarkers(sectionSource,
    Number(data.duration) || Number(data.scoreDuration) || Infinity)
    .filter((marker, index, all) => index === all.findIndex((candidate) =>
      Math.abs(candidate.t - marker.t) < 1e-6 &&
      candidate.text === marker.text &&
      candidate.sectionType === marker.sectionType));

  // 4. the state object itself — nothing above may read S.state, nothing below
  //    may assume it is the old one.
  S.state = {
    job: data.job,
    name: data.name,
    filename: data.filename,
    duration: data.duration,
    detectedTempo: data.tempo,
    separated: data.separated,
    separator: data.separator,
    metadata: normalizeMetadata(data.metadata || {}),
    guitarPro: data.guitarPro || null,
    sectionMarkers: restoredSections,
    scoreBars: coveredBars,
    scoreDuration: coveredBars.length ? coveredBars.at(-1).seconds + coveredBars.at(-1).durationSeconds
      : Number(data.scoreDuration) || Number(data.duration) || 1,
    // Full song is the default audible source. Separated stems start neutral; when
    // the full song is muted they play as a combined stem mix.
    stems: (data.stems || []).map((s) => ({
      id: s.id, name: s.name, spec: s.spectrogram, audioUrl: s.audio_url,
      muted: !!s.muted, solo: !!s.solo,
    })),
    editLanes: sourceLanes.map(mapLane),
    curStem: null,         // set by selectStem below
    spec: null, rowH: 0, lanes: [],
  };
  // 5. ids
  syncUidPastLoaded();   // bump uid past loaded ids so new notes/lanes never collide
  const idsRepaired = dedupeIds();   // heal duplicate ids baked in by the old uid bug

  // 6. active layer. Restore the saved one; only fall back to the first edit lane when
  // nothing was marked active (older projects, or all-empty restores).
  const anyActive = S.state.editLanes.some((l) => l.active);
  if (!anyActive && S.state.editLanes[0]) S.state.editLanes[0].active = true;

  // 7. view settings (which stem, zoom, speed) so reload lands where you left off.
  const v = data.view || {};
  S.zoomX = clamp(+v.zoomX || 1, ZOOM_MIN_X, ZOOM_MAX_X);
  S.zoomY = clamp(+v.zoomY || 1, ZOOM_MIN_Y, ZOOM_MAX_Y);
  S.pxPerSec = PX_PER_SEC * S.zoomX;
  updateZoomLabels();
  speedSel.value = data.job === "tutorial" ? "1" : String(v.speed ?? "1");

  S.selection = new Set();
  S.clipboard = []; S.clipboardRef = null; S.clipboardSrc = [];
  S.detectRegion = null;
  clearMatches();
  S.undoStack = []; S.redoStack = []; updateUndoButtons();

  // 8. the grid, then the stem mixer below it
  const g = data.grid || {};
  S.state.baseGrid = { bpm: Number(g.bpm) || 120, offset: Number(g.offset) || 0,
    subdiv: Number(g.subdiv) || 2, tsNum: Number(g.tsNum) || 4, tsDen: Number(g.tsDen) || 4 };
  S.scorePlaying = false; S.scoreTime = 0;
  if (g.bpm) bpmInput.value = g.bpm;
  if (g.offset != null) offsetInput.value = (+g.offset).toFixed(3);
  if (g.subdiv) setSubdiv(g.subdiv);
  if (g.tsNum) tsNumInput.value = g.tsNum;
  if (g.tsDen) tsDenInput.value = String(g.tsDen);
  // Extra tempo/meter markers (segment 0 = the inputs above; these are additional).
  S.state.tempoMap = Array.isArray(g.tempoMap)
    ? g.tempoMap.map((m) => ({ t: +m.t, bpm: +m.bpm || 0, tsNum: parseInt(m.tsNum, 10) || 4, tsDen: parseInt(m.tsDen, 10) || 4, subdiv: Math.max(1, parseInt(m.subdiv, 10) || gridSubdiv()) })).filter((m) => Number.isFinite(m.t))
    : [];
  S.appliedGrid = currentGridState();
  S.appliedOffset = S.appliedGrid.offset;   // baseline so the first offset tweak shifts notes by the delta, not the absolute value

  setStatus("", false);
  const warnings = [...(data.warnings || [])];
  if (idsRepaired) warnings.unshift(
    `Repaired ${idsRepaired} duplicate id${idsRepaired === 1 ? "" : "s"} from an older save.`);
  // textContent, not innerHTML: server warnings quote layer names, and those are
  // whatever the user typed (`tab.py` emits `f"{track.name}: note {pitch} out of range"`).
  warnEl.replaceChildren(...warnings.map((w) => {
    const el = document.createElement("div");
    el.className = "warn";
    el.textContent = `⚠ ${w}`;
    return el;
  }));

  // 9. reveal the editor and paint
  hideWelcome();
  appshell.hidden = false;
  // Whatever was open belongs to the project that just left.
  setView("spec");
  saveBtn.disabled = data.job === "tutorial";
  saveAsBtn.disabled = data.job === "tutorial";

  // The master clock element is the full song (stem 0) and never changes with the
  // viewed stem — so A/B-ing stems by ear or switching the spectrogram view never
  // disturbs playback. Separated stems play as slaved followers (see stem mixer).
  audio.src = S.state.stems[0] ? S.state.stems[0].audioUrl : "";
  audio.playbackRate = parseFloat(speedSel.value) || 1;
  applyPreservePitch();
  resetStemMixer();   // drop any followers from a previous project

  // sets spec/canvas, draws — prefer the saved stem if it still exists
  const savedStem = v.stem && S.state.stems.some((s) => s.id === v.stem) ? v.stem : null;
  if (S.state.stems.length) {
    selectStem(savedStem || S.state.stems[0].id);
  } else {
    const pitches = S.state.editLanes.flatMap((lane) => lane.notes.map((note) => Number(note.pitch))).filter(Number.isFinite);
    const low = pitches.length ? Math.max(0, Math.min(...pitches) - 12) : 24;
    const high = pitches.length ? Math.min(127, Math.max(...pitches) + 12) : 96;
    S.state.spec = { midi_low: low, midi_high: high, duration: S.state.duration };
    S.spectImg = null;
    syncRowHeight(); rebuildLanes(); layout(); renderStemTabs(); renderLanes(); draw();
  }
  if (attachAudioBtn) attachAudioBtn.hidden = S.state.stems.length > 0;
  markSaved();    // freshly loaded project is the clean baseline; shows the tab, no dot
  warmSynths();   // start fetching the guitar samples ahead of first play
  // The editor exists now, which is the only moment its walkthrough can be
  // pointed at anything. An event rather than a call: tour.js reaches into the
  // fretboard, the marker rails and the tablature view, and this module already
  // sits upstream of all three. project-library.js hands GP drops back the same
  // way ("cw-open-guitar-pro").
  window.dispatchEvent(new CustomEvent("cw-project-opened"));
}

// Close the project and hand the window back to the launcher — phases 1 and 4 of
// applyProject running backwards, and nothing else: everything a project owns is
// rebuilt from its payload on the way back in, so there is no third thing to
// reset here. The sound has to stop before the state it is playing from is gone.
export async function closeProject(options = {}) {
  if (!S.state) return false;
  const discardTutorial = options?.discardTutorial === true && S.state.job === "tutorial";
  if (!discardTutorial && !await confirmLeave()) return false;
  // Let transient project UI tear itself down before the launcher becomes visible.
  window.dispatchEvent(new Event("cw-project-closed"));
  pauseTransport();
  disposeSynths();
  resetStemMixer();
  closeStemSettings();
  audio.removeAttribute("src");
  audio.load();
  speedSel.value = "1";
  S.state = null;
  S.spectImg = null;
  S.selection = new Set();
  S.undoStack = []; S.redoStack = []; updateUndoButtons();
  clearMatches();
  warnEl.replaceChildren();
  setStatus("", false);
  saveBtn.disabled = true;
  saveAsBtn.disabled = true;
  appshell.hidden = true;
  markSaved();     // no project: drops the baseline and takes the tab off the bar
  showWelcome();
  return true;
}

// Switch the *viewed* stem: swaps only the spectrogram backdrop. Audio is the
// mixer's job now (master clock + slaved stem followers), so the playhead, play
// state and what you hear are untouched — switch the view freely while playing.
// The edit lanes are global, so they stay put across stems.
export function selectStem(id) {
  if (!S.state || !S.state.stems.length) return;
  const stem = S.state.stems.find((s) => s.id === id) || S.state.stems[0];
  clearMatches();   // suggestions are tied to the previous stem's spectrogram
  S.state.curStem = stem.id;
  S.state.spec = stem.spec;
  syncRowHeight();
  rebuildLanes();

  // Keep the old backdrop until the new image decodes, then swap (no blank flash).
  const img = new Image();
  projectVisuals = new Promise((resolve) => {
    img.onload = () => { S.spectImg = img; prepareSpectSample(); layout(); draw(); resolve(); };
    img.onerror = () => resolve();
  });
  img.src = stem.spec.url;

  if (detectStemNameEl) detectStemNameEl.textContent = stem.name;
  updateDetectStatus();
  layout();
  renderStemTabs();
  renderLanes();
  draw();
}

const EDIT_ICON = icon("edit", 14);

let stemDrag = null;

function clearStemDropIndicators() {
  stemTabsEl?.querySelectorAll(".stem-row.drop-before, .stem-row.drop-after")
    .forEach((row) => row.classList.remove("drop-before", "drop-after"));
}

function persistStemOrder(previousOrder) {
  const state = S.state;
  const order = state.stems.map((stem) => stem.id);
  fetch(`/api/projects/${state.job}/stems/order`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order }),
  }).then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "save failed");
  }).catch((err) => {
    // Don't undo a newer drag while the request for an earlier ordering fails.
    if (S.state !== state || state.stems.map((stem) => stem.id).join("|") !== order.join("|")) return;
    state.stems = previousOrder;
    renderStemTabs();
    toast("Couldn't save stem order: " + err.message, 2200, "error");
  });
}

function reorderStem(moving, target, before) {
  if (!moving || !target || moving === target || isMasterStem(moving) || isMasterStem(target)) return;
  const previousOrder = [...S.state.stems];
  const stems = S.state.stems;
  stems.splice(stems.indexOf(moving), 1);
  const targetIndex = stems.indexOf(target);
  stems.splice(targetIndex + (before ? 0 : 1), 0, moving);
  renderStemTabs();
  persistStemOrder(previousOrder);
}

function wireStemDrag(row, stem) {
  row.draggable = true;
  row.title = "Drag to reorder stem";
  row.addEventListener("dragstart", (event) => {
    stemDrag = { stem };
    row.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", stem.id);
    }
  });
  row.addEventListener("dragover", (event) => {
    if (!stemDrag || stemDrag.stem === stem) return;
    event.preventDefault();
    const before = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    clearStemDropIndicators();
    row.classList.add(before ? "drop-before" : "drop-after");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    const moving = stemDrag?.stem;
    const before = row.classList.contains("drop-before");
    clearStemDropIndicators();
    reorderStem(moving, stem, before);
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    clearStemDropIndicators();
    stemDrag = null;
  });
}

// Vertical mixer: one row per stem. Clicking the name views that stem (spectrogram).
// Full song is the default source and only has a dedicated mute button; separated
// stems expose normal solo/mute controls for the combined stem mix.
export function renderStemTabs() {
  const actions = document.getElementById('audioLayerActions');
  if (!stemTabsEl) return;
  stemTabsEl.innerHTML = "";
  const anySolo = S.state.stems.some((s) => !isMasterStem(s) && s.solo);
  const masterOn = masterStemAudible();
  for (const stem of S.state.stems) {
    const master = isMasterStem(stem);
    const viewing = stem.id === S.state.curStem;
    const row = document.createElement("div");
    row.className = "stem-row arriving" + (master ? " stem-master" : "")
      + (viewing ? " viewing" : "")
      + (stem.muted ? " muted" : "");
    row.addEventListener("click", () => { if (stem.id !== S.state.curStem) selectStem(stem.id); });

    const name = document.createElement("button");
    name.className = "stem-name";
    name.textContent = stem.name;
    name.setAttribute("aria-label", `View ${stem.name} on the spectrogram`);


    const mute = document.createElement("button");
    if (master) {
      mute.className = "stem-master-mute" + (stem.muted ? " on" : "");
      mute.textContent = stem.muted ? "Muted" : "Mute";
      mute.title = stem.muted ? "Unmute full song" : "Mute full song";
    } else {
      const implicitlyOff = !masterOn && anySolo && !stem.solo;
      mute.className = "stem-btn mute" + (stem.muted ? " on" : "") + (implicitlyOff ? " dim" : "");
      mute.textContent = "M";
      mute.title = viewing ? "Mute (Shift+M)" : "Mute";
    }
    mute.addEventListener("click", (ev) => { ev.stopPropagation(); toggleStemMute(stem); });

    const edit = document.createElement("button");
    edit.className = "stem-btn edit";
    edit.innerHTML = EDIT_ICON;
    edit.title = "Edit audio source";
    edit.setAttribute("aria-label", edit.title);
    // The panel can't ask playback itself — that would put it back in the cycle —
    // and the master can't change while it is open, so it is captured here.
    edit.addEventListener("click", (ev) => { ev.stopPropagation(); openStemSettings(stem, isMasterStem(stem)); });

    const ctrls = document.createElement("div");
    ctrls.className = "stem-ctrls";
    if (master) {
      ctrls.append(edit, mute);
    } else {
      const solo = document.createElement("button");
      solo.className = "stem-btn solo" + (stem.solo ? " on" : "");
      solo.textContent = "S";
      solo.title = "Solo";
      solo.addEventListener("click", (ev) => { ev.stopPropagation(); toggleStemSolo(stem); });
      ctrls.append(edit, solo, mute);
    }
    row.append(name, ctrls);
    if (!master) wireStemDrag(row, stem);
    stemTabsEl.append(row);
  }
  // Render a new stem in its final position while its separation runs. It is
  // deliberately non-interactive until its audio and spectrogram are ready.
  if (pendingStem) {
    const row = document.createElement("div");
    row.className = "stem-row stem-pending";
    row.setAttribute("aria-label", `${pendingStem.label} is being separated`);

    const name = document.createElement("span");
    name.className = "stem-name";
    name.textContent = pendingStem.label;

    row.append(name);
    stemTabsEl.append(row);
  }

  // Score-only projects still need a clear route to bring audio into the editor.
  // Attaching a full song creates the first (master) stem, after which normal
  // separation and per-stem tools become available.
  if (!S.state.stems.length) {
    const add = document.createElement("button");
    add.className = "icon-btn icon-btn--compact layer-add";
    add.innerHTML = icon('plus',16);
    add.setAttribute('aria-label', 'Add audio layer');
    add.title = "Attach audio to this project";
    add.addEventListener("click", chooseAudioAttachment);
    actions.replaceChildren(add);
  // "+" row: create another stem (e.g. drums) from the full song on demand.
  } else {
    const add = document.createElement("button");
    add.className = "icon-btn icon-btn--compact layer-add";
    add.innerHTML = icon('plus',16);
    add.setAttribute('aria-label', 'Add audio layer');
    add.title = "Separate a part from the full song, or load a file";
    add.addEventListener("click", () => openAddStemMenu(add));
    actions.replaceChildren(add);
  }
  stemTabsEl.append(actions);

  // Solo and mute rebuild these rows under an already-hovering pointer, so they
  // arrive with their transitions suppressed and settle two frames later.
  clearArriving(stemTabsEl);
}

// Placeholder row shown in the stem list while a new stem is being separated —
// no buttons until its audio is ready; progress lives in the processing toast.
let pendingStem = null;

function startPendingStem(label) {
  pendingStem = { label };
  renderStemTabs();
}

function stopPendingStem() {
  pendingStem = null;
}

// Popover for adding a stem from the full-song source, even before the first
// separation has completed. Each new stem can choose its own separator.
export let addStemMenuEl = null;

export function closeAddStemMenu() {
  if (addStemMenuEl) { addStemMenuEl.remove(); addStemMenuEl = null; }
  // Always drop the outside-click listener here — picking an item closes the
  // menu before the click bubbles to `onceCloseAddStem`, so it can't clean up
  // after itself and would otherwise leak and kill the next menu we open.
  document.removeEventListener("click", onceCloseAddStem);
}

export function addStemMenuMode(mode) {
  if (mode !== "separate" && mode !== "upload") return false;
  const button = addStemMenuEl?.querySelector(`[data-pick="${mode}"]`);
  if (!button) return false;
  if (!button.classList.contains("active")) button.click();
  return true;
}

async function openAddStemMenu(anchor) {
  closeAddStemMenu();
  const menu = document.createElement("div");
  menu.className = "menu-list stem-add-menu";
  menu.textContent = "Loading…";
  document.body.append(menu);
  addStemMenuEl = menu;
  const r = anchor.getBoundingClientRect();
  placeFloating(menu, r.left, r.bottom, 4);
  setTimeout(() => document.addEventListener("click", onceCloseAddStem), 0);

  if (!separators.length) await loadSeparators();
  if (addStemMenuEl !== menu) return;  // closed while separator metadata was loading

  // Separating a part and bringing your own file are one question — where does
  // this audio come from — and the audio editor already answers it with a switch.
  // Showing both routes at once was two answers stacked, and the one that fires a
  // server job was a menu row that looked like nothing else in the app.
  // The tutorial's bass is already rendered on disk. Its Demucs choice is a
  // demonstration even when the model is not installed on this computer.
  const tutorialDemucs = separators.find((separator) => separator.id === "demucs");
  const models = S.state?.job === "tutorial"
    ? [{ id: "demucs", label: tutorialDemucs?.label || "Demucs", available: true,
         stems: tutorialDemucs?.stems?.length ? tutorialDemucs.stems : [{ id: "bass", label: "Bass" }] },
       ...separators.filter((separator) => separator.id !== "demucs")]
    : separators;
  const available = models.filter((separator) => separator.available);
  let mode = available.length ? "separate" : "upload";

  const take = (file) => { if (file) { closeAddStemMenu(); uploadStem(file); } };

  const partsOf = (separator) => separator?.stems || [];

  const separateRow = () => {
    const row = document.createElement("div");
    row.className = "sc-source-row";
    const backend = document.createElement("select");
    backend.setAttribute("aria-label", "Separation model");
    backend.innerHTML = models.map((separator) => `<option value="${separator.id}" ${separator.available ? "" : "disabled"}>${separator.label}${separator.available ? "" : " — unavailable"}</option>`).join("");
    backend.value = S.state?.job === "tutorial" ? "demucs" : available[0].id;
    const part = document.createElement("select");
    part.setAttribute("aria-label", "Part to separate");
    const go = document.createElement("button");
    go.className = "primary sc-go"; go.textContent = "Separate";
    const fillParts = () => {
      const parts = partsOf(models.find((separator) => separator.id === backend.value));
      part.innerHTML = parts.map((stem) => `<option value="${stem.id}">${stem.label}</option>`).join("");
      go.disabled = !parts.length;
    };
    fillParts();
    if (S.state?.job === "tutorial" && [...part.options].some((option) => option.value === "bass"))
      part.value = "bass";
    backend.addEventListener("change", fillParts);
    go.addEventListener("click", () => {
      const selected = models.find((separator) => separator.id === backend.value);
      const stem = partsOf(selected).find((item) => item.id === part.value);
      if (!selected || !stem) return;
      addStem(stem.id, stem.label, selected.id);
    });
    row.append(backend, part, go);
    return row;
  };

  // Audio you separated elsewhere. The New Project window has taken uploaded
  // sources since it shipped; the editor could only ever ask a model for one, so
  // the answer to "add the bass I already have" was "start a new project".
  //
  // A DROP ZONE and not a menu row, because rule 24 already has a mark for a
  // thing that takes a file and it is a dashed border — the New Project window
  // and the audio editor both wear it, and a row of text in a menu is a fourth
  // way to say what those two say the same way.
  const dropZone = () => {
    const drop = document.createElement("div");
    drop.className = "sc-drop stem-add-drop";
    drop.tabIndex = 0;
    drop.setAttribute("role", "button");
    drop.setAttribute("aria-label", "Choose or drop an audio file");
    drop.textContent = "Drop an audio file, or click to choose";
    drop.addEventListener("click", () => pickStemUpload(take));
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickStemUpload(take); }
    });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
      take(e.dataTransfer?.files?.[0]);
    });
    return drop;
  };

  const render = () => {
    menu.innerHTML = "";
    const sw = document.createElement("div");
    sw.className = "view-switch";
    sw.setAttribute("role", "group");
    sw.setAttribute("aria-label", "New audio source");
    sw.innerHTML = `
      <button type="button" class="mode ${mode === "separate" ? "active" : ""}" data-pick="separate"
        ${available.length ? "" : "disabled title='No separation model is available'"}>Separate from audio</button>
      <button type="button" class="mode ${mode === "upload" ? "active" : ""}" data-pick="upload">Upload my own</button>`;
    sw.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => { mode = b.dataset.pick; render(); }));
    menu.append(sw, mode === "separate" ? separateRow() : dropZone());
  };
  render();
}

// The file input is built per pick and thrown away: a permanent hidden input in
// index.html is markup that exists for one click a session.
function pickStemUpload(then) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*";
  input.addEventListener("change", () => then(input.files[0]));
  input.click();
}

async function uploadStem(file) {
  const state = S.state;
  const label = file.name.replace(/\.[^.]+$/, "") || "Stem";
  startPendingStem(label);
  try {
    // The stem lands in the project on the server, so what is on screen has to
    // be on disk first — otherwise the load that follows a reopen has a stem the
    // manifest knows about and edits it does not.
    await saveToServer();
    const body = new FormData();
    body.append("file", file);
    body.append("name", label);
    const res = await fetch(`/api/projects/${state.job}/stems/upload`, { method: "POST", body });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "upload failed");
    const s = (await res.json()).stem;
    if (S.state !== state) return;   // project switched while it was transcoding
    S.state.stems.push({
      id: s.id, name: s.name, spec: s.spectrogram, audioUrl: s.audio_url,
      muted: false, solo: false,
    });
    ensureStemMixer();
    stopPendingStem();
    renderStemTabs();
    selectStem(s.id);
  } catch (e) {
    if (S.state === state) {
      stopPendingStem();
      renderStemTabs();
      toast("Couldn't add stem: " + e.message, 2200, "error");
    }
  }
}

function onceCloseAddStem(e) {
  if (inTourCard(e.target)) return;
  // Switching sources rebuilds the clicked button before this event bubbles.
  // Its original event path still includes the menu after that replacement.
  if (addStemMenuEl && !e.composedPath().includes(addStemMenuEl)) closeAddStemMenu();
}

export async function addStem(stemId, label, backend) {
  // Separation can take minutes; if another project is opened meanwhile, the
  // response must not land in it (a stem row pointing at the old job's audio).
  const state = S.state;
  closeAddStemMenu();
  startPendingStem(label);
  try {
    const data = await operationRequest("/api/stems/add",
      {job: state.job, stem: stemId, backend},
      "Separating audio", `${backendLabel(backend)} · ${label || stemId}`);
    if (S.state !== state) return false;   // project switched while separating — drop it
    const s = data.stem;
    S.state.stems.push({
      id: s.id, name: s.name, spec: s.spectrogram, audioUrl: s.audio_url,
      muted: false, solo: false,
    });
    ensureStemMixer();   // build the follower element + gain for the new stem
    stopPendingStem();
    renderStemTabs();
    selectStem(s.id);
    if (data.warning) toast(`⚠ ${data.warning}`);
    return true;
  } catch (e) {
    if (S.state === state) {
      stopPendingStem();
      renderStemTabs();
      toast("Couldn't add stem: " + e.message, 2200, "error");
    }
    return false;
  }
}

// ---- stem operations (the stem settings panel triggers these) ----
// The panel in stem-settings.js is a screen; these three are the project changes
// its buttons ask for. They live here so the next way to rename, remove or
// replace a stem reuses them instead of importing them out of a panel.

// True on success. The panel reverts its input on false.
async function renameStem(stem, name) {
  try {
    const res = await fetch(`/api/projects/${S.state.job}/stems/${stem.id}/rename`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "rename failed");
    stem.name = name;
    renderStemTabs();
    return true;
  } catch (e) {
    toast("Couldn't rename stem: " + e.message, 2200, "error");
    return false;
  }
}

// Delete the stem, then repair the editor around the hole it leaves: playback has
// to stop pointing at it, the viewed stem has to move, and losing the last stem
// drops the whole editor out of spectrogram view. True on success.
export async function removeStem(stem) {
  const state = S.state;
  if (!stem || !state) return false;
  try {
    const res = await fetch(`/api/projects/${state.job}/stems/${stem.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "remove failed");

    const wasMaster = isMasterStem(stem);
    const wasViewing = state.curStem === stem.id;
    state.stems = state.stems.filter((item) => item !== stem);
    resetStemMixer();

    if (state.stems.length) {
      const next = wasViewing ? state.stems[0] : state.stems.find((item) => item.id === state.curStem) || state.stems[0];
      if (wasMaster) {
        audio.pause();
        audio.src = state.stems[0].audioUrl;
        audio.load();
        applyPreservePitch();
      }
      ensureStemMixer();
      selectStem(next.id);
    } else {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      state.curStem = null;
      state.spec = null;
      // Removing the last audio leaves a score-only project. It used to swing
      // the main view over to the tab, which the tab is no longer — it is a
      // window, and opening one on the way out of a delete is not what the
      // click asked for. The stage is empty and File → Tablature view is there.
      syncRowHeight();
      rebuildLanes();
      renderStemTabs();
      renderLanes();
      draw();
    }
    if (attachAudioBtn) attachAudioBtn.hidden = state.stems.length > 0;
    toast("Stem removed");
    return true;
  } catch (err) {
    toast("Couldn't remove stem: " + err.message, 2200, "error");
    return false;
  }
}

// Point the project at a stem's new audio + spectrogram. Runs whether or not the
// panel is still showing this stem — the panel guards its own half.
function applyStemReplacement(stem, s, warn, duration) {
  stem.spec = s.spectrogram;
  refreshStemAudio(stem, s.audio_url);
  if (stem.id === S.state.curStem) selectStem(stem.id);
  // The master's file can change length on replace — resize the canvas to match
  // (separated stems are assumed to match the full song's existing length).
  if (duration != null && isMasterStem(stem)) { S.state.duration = duration; layout(); draw(); }
  if (warn) toast(warn);
}

export async function loadCached(job) {
  if (!await confirmLeave()) return;
  await loadWithScreen(async () => {
    const res = await fetch(`/api/projects/${job}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Load failed");
    applyProject(await res.json());
    await waitForProjectVisuals();
  });
}

export function init_project() {
  saveBtn.addEventListener("click", () => saveProject());
  saveAsBtn.addEventListener("click", () => saveProject({ saveAs: true }));
  openBtn.addEventListener("click", openProject);
  // Two ways home: the arrow leading the menu bar, and the verb in the File menu
  // where the rest of the project lifecycle already lives.
  homeBtn?.addEventListener("click", closeProject);
  closeProjBtn?.addEventListener("click", closeProject);
  openFileInput.addEventListener("change", () => {
    if (openFileInput.files[0]) openProjectFile(openFileInput.files[0]);
    openFileInput.value = "";   // allow re-opening the same file
  });
  attachAudioBtn?.addEventListener("click", chooseAudioAttachment);

  // The three screens below are not part of this lifecycle — they call back in
  // here rather than importing us. See each module's banner.
  initProjectLibrary({
    onNew: async (file) => { if (await openNewProject() && file) setMainFile(file); },
    onOpenFile: openProject,
    onPick: loadCached,
  });
  initNewProject({
    onCreated: applyProject,
    onClosed: () => { if (!S.state) showWelcome(); },   // cancelled with nothing open
    canLeave: confirmLeave,   // the modal ends in a project swap, so ask before it opens
  });
  initStemSettings({ onRename: renameStem, onRemove: removeStem, onReplaced: applyStemReplacement });

  // Closing the window. The desktop shell cancels its own close and calls this
  // instead, so the question gets asked in the app's own dialog; it then quits for
  // real through the bridge. desktop.py asks every time rather than mirroring a
  // dirty flag over — the page is the only thing that knows, and a mirror that goes
  // stale loses work silently.
  window.cwQuitRequested = () => {
    confirmLeave().then((ok) => { if (ok) window.pywebview.api.quit(); });
  };
  // A browser has no such hook: `beforeunload` buys nothing but its own native
  // prompt, which is all a tab will ever show. It stays for that case only — in
  // the desktop shell it would put a second dialog in front of the real one.
  window.addEventListener("beforeunload", (e) => { if (!window.pywebview && isDirty()) e.preventDefault(); });

  // Stem cards parked in the "choosing" state render the backend list, so they
  // need a nudge once it arrives; loadSeparators itself no longer knows them.
  loadSeparators().then(refreshChoosingCards);
  showWelcome();
}
import { placeFloating } from "./floating-position.js";
