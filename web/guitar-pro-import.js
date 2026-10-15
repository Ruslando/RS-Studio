// Browser-facing Guitar Pro import flow. Parsing stays client-side in alphaTab;
// the backend only stores the untouched source file with the normal project.

import { bpmInput, gpImportBackdrop, gpImportCancel, gpImportClose, gpImportConfirm, gpImportFile, gpImportStatus, gpImportSummary, gpImportTracks, importGpBtn, offsetInput, tsDenInput, tsNumInput, welcomeGpBtn } from "./dom.js";
import { draw } from "./repaint.js";
import { convertGpScore, inspectGpScore } from "./guitar-pro-core.js";
import { currentGridState, setSubdiv } from "./grid.js";
import { rebuildLanes, refreshCounts, renderLanes } from "./lanes.js";
import { toast } from "./notify.js";
import { loadWithScreen } from "./project-loading.js";
import { applyProject, markSaved, mapLane, refreshSaveState, saveToServer } from "./project.js";
import { S } from "./store.js";
import { SONG, addTiming, syncTiming, timingData } from "./timing.js";
import { coverScoreDuration, normalizeScoreBars } from "./score-structure-core.js";
import { sectionMarkersFromScoreBars } from "./section-marker-core.js";
import { loadAlphaTab, refreshTabIfOpen } from "./tablature.js";

let pending = null;
// True only while confirmImport() is in flight. closeImport() guards on this and
// not on gpImportConfirm.disabled: Confirm is *also* disabled when the file has
// no guitar/bass tracks and when it failed to parse, and those are exactly the
// cases where you most need a way out. Keying the guard off the button made the
// dialog uncloseable there — no Cancel, no X, no backdrop, no Escape.
let importing = false;

// Bars, keys and repeats ride along with an imported score. They used to be
// installed by the Score structure overlay, which the design system deletes;
// this is the only caller, so the function lives at its call site now.
function importedStructure(converted) {
  const target = Math.max(Number(converted?.duration) || 0, Number(S.state.duration) || 0,
    ...S.state.editLanes.flatMap((lane) => lane.notes.map((note) => Number(note.end) || 0)));
  const scoreBars = coverScoreDuration(
    normalizeScoreBars(converted?.guitarPro?.score?.masterBars || [], converted?.duration), target);
  return { scoreBars, sectionMarkers: sectionMarkersFromScoreBars(scoreBars), target };
}

function installImportedScoreBars(converted) {
  if (!S.state) return;
  const { scoreBars, sectionMarkers, target } = importedStructure(converted);
  S.state.scoreBars = scoreBars;
  S.state.sectionMarkers = sectionMarkers;
  S.state.scoreDuration = target;
}

// Does the file keep the song's time? Then its layers can follow the song's timing.
function sameTiming(song, grid) {
  const near = (a, b) => Math.abs((+a || 0) - (+b || 0)) < 1e-3;
  const a = song.tempoMap || [], b = grid.tempoMap || [];
  return near(song.grid.bpm, grid.bpm) && near(song.grid.offset, grid.offset)
    && +song.grid.tsNum === +grid.tsNum && +song.grid.tsDen === +grid.tsDen
    && a.length === b.length && a.every((m, i) => near(m.t, b[i].t) && near(m.bpm, b[i].bpm)
      && +m.tsNum === +b[i].tsNum && +m.tsDen === +b[i].tsDen);
}

// Imported into a project that already has notes, in another tempo: the file's
// layers get their own timing — its grid, tempo markers, bars and sections — and
// the song's stays as it was.
function ownImportedTiming(converted, lanes) {
  const { scoreBars, sectionMarkers, target } = importedStructure(converted);
  const g = converted.grid;
  const id = addTiming({
    grid: { bpm: g.bpm, offset: +g.offset || 0, subdiv: g.subdiv, tsNum: g.tsNum, tsDen: g.tsDen },
    tempoMap: g.tempoMap, sectionMarkers, scoreBars,
  });
  for (const lane of lanes) lane.timing = id;
  S.state.scoreDuration = Math.max(Number(S.state.scoreDuration) || 0, target);
}

function setImportStatus(message = "", error = false) {
  gpImportStatus.textContent = message;
  gpImportStatus.hidden = !message;
  gpImportStatus.classList.toggle("error", error);
}

function closeImport() {
  if (importing) return;
  gpImportBackdrop.hidden = true;
  pending = null;
  setImportStatus();
}

function tuningLabel(track) {
  const counts = track.staves.map((staff) => staff.tuning.length).filter(Boolean);
  const tuning = counts.length ? counts.map((count) => `${count}-string`).join(" + ") : "no tablature tuning";
  const capos = track.staves.map((staff) => staff.capo).filter((capo) => capo > 0);
  return capos.length ? `${tuning}, capo ${[...new Set(capos)].join("/")}` : tuning;
}

function renderTracks(inspection) {
  gpImportTracks.replaceChildren();
  for (const track of inspection.tracks) {
    const row = document.createElement("label");
    row.className = `gp-import-track${track.supported ? "" : " unsupported"}`;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = String(track.index);
    check.checked = track.supported;
    check.disabled = !track.supported;
    const main = document.createElement("span");
    main.className = "gp-import-track-main";
    const name = document.createElement("span");
    name.className = "gp-import-track-name";
    name.textContent = track.name;
    const detail = document.createElement("span");
    detail.className = track.supported ? "gp-import-track-detail" : "gp-import-track-reason";
    const voices = track.voiceIndexes.length ? `voices ${track.voiceIndexes.map((v) => v + 1).join(", ")}` : "empty";
    detail.textContent = track.supported
      ? `${track.noteCount.toLocaleString()} notes · ${tuningLabel(track)} · ${voices}`
      : track.reason;
    const kind = document.createElement("span");
    kind.className = "gp-import-track-kind";
    kind.textContent = track.family;
    main.append(name, detail);
    row.append(check, main, kind);
    gpImportTracks.append(row);
  }
}

async function chooseFile(file) {
  setImportStatus(`Reading ${file.name}…`);
  gpImportBackdrop.hidden = false;
  gpImportConfirm.disabled = true;
  try {
    await loadAlphaTab();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
    const version = alphaTab.Environment?.version || "";
    const inspection = inspectGpScore(score, version);
    pending = { file, score, inspection, version };
    const supported = inspection.tracks.filter((track) => track.supported).length;
    gpImportSummary.textContent = `${inspection.title || file.name} · ${inspection.bars} bars · ` +
      `${inspection.tracks.length} tracks (${supported} guitar/bass available)` +
      (S.state?.guitarPro ? " · replaces the previous Guitar Pro tracks" : "");
    renderTracks(inspection);
    setImportStatus();
    gpImportConfirm.disabled = supported === 0;
  } catch (error) {
    pending = null;
    gpImportSummary.textContent = file.name;
    gpImportTracks.replaceChildren();
    setImportStatus(`Could not read this Guitar Pro file: ${error.message}`, true);
    gpImportConfirm.disabled = true;
  }
}

function importedLane(lane) {
  // An imported lane stays imported even after the user deletes every note.
  // Re-import must replace that empty source lane instead of retaining a ghost.
  return lane.sourceTrackIndex != null;
}

function applyImportedGrid(grid) {
  bpmInput.value = grid.bpm;
  offsetInput.value = (+grid.offset || 0).toFixed(3);
  setSubdiv(grid.subdiv);
  tsNumInput.value = grid.tsNum;
  tsDenInput.value = String(grid.tsDen);
  S.state.tempoMap = grid.tempoMap.map((marker) => ({ ...marker }));
  S.appliedGrid = currentGridState();
  S.appliedOffset = S.appliedGrid.offset;
}

async function confirmImport() {
  if (!pending) return;
  const selected = [...gpImportTracks.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => Number(input.value));
  if (!selected.length) { setImportStatus("Select at least one guitar or bass track.", true); return; }
  importing = true;
  gpImportConfirm.disabled = true;
  gpImportCancel.disabled = true;
  gpImportClose.disabled = true;
  setImportStatus();
  // The loading screen (design.md 4.17): the window cannot be used while this
  // runs, and for a new project it ends in the project opening. A failure is
  // said there, and Back returns to this window.
  try {
    await loadWithScreen(async () => {
      const converted = convertGpScore(pending.score, selected, pending.version);
      const standalone = !S.state;
      let job = S.state?.job;
      if (standalone) {
        const created = await fetch("/api/projects/new", { method: "POST" });
        if (!created.ok) throw new Error("Could not create the project");
        job = (await created.json()).job;
      }
      const body = new FormData();
      body.append("file", pending.file);
      body.append("summary", JSON.stringify(converted.guitarPro));
      const response = await fetch(`/api/projects/${job}/guitar-pro`, { method: "POST", body });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || "source upload failed");
      const stored = await response.json();

      if (standalone) {
        const title = converted.guitarPro.score?.title || pending.file.name.replace(/\.(?:gp|gpx|gp[345])$/i, "");
        const finalized = await fetch(`/api/projects/${job}/finalize`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: title }),
        });
        if (!finalized.ok) throw new Error((await finalized.json().catch(() => ({}))).detail || "Could not finalize the project");
        applyProject(await finalized.json());
        S.state.metadata = { ...S.state.metadata, ...(converted.metadata || {}) };
      }

      const retained = S.state.editLanes.filter((lane) => !importedLane(lane));
      const retainedHaveNotes = retained.some((lane) => lane.notes.length);
      // Remove only the untouched initial placeholder. Empty user-created/configured
      // lanes are real project content and should survive an import.
      const lonePlaceholder = retained.length === 1 && !retained[0].notes.length
        && /^Layer 1$/i.test(retained[0].name || "") && /^edit(?:_|$)/.test(retained[0].id || "");
      const base = lonePlaceholder ? [] : retained;
      for (const lane of base) lane.active = false;
      const imported = converted.editLanes.map(mapLane);
      if (imported[0]) imported[0].active = true;
      // Nothing to keep in time: the file's timing becomes the song's. Otherwise its
      // layers follow the song if the file keeps the same time, or get their own.
      const own = retainedHaveNotes && !sameTiming(timingData(SONG), converted.grid);
      if (own) ownImportedTiming(converted, imported);
      S.state.editLanes = [...base, ...imported];
      S.state.guitarPro = stored.guitarPro;
      syncTiming();   // live: the first imported layer's timing
      if (!retainedHaveNotes) { installImportedScoreBars(converted); applyImportedGrid(converted.grid); }
      else if (!own) {   // the file's bars, as before; the song's own sections stay
        const sections = S.state.sectionMarkers;
        installImportedScoreBars(converted);
        if (sections?.length) S.state.sectionMarkers = sections;
      }

      S.selection = new Set();
      S.voicingRevision++;
      rebuildLanes();
      renderLanes();
      refreshCounts();
      draw();
      refreshSaveState();
      await saveToServer();
      markSaved();
      gpImportBackdrop.hidden = true;
      pending = null;
      if (own) toast("Imported with its own tempo and sections — Layer settings can make it follow the song", 4500);
      else if (retainedHaveNotes) toast("Imported with the song's tempo", 3200);
      else toast(`Imported ${selected.length} Guitar Pro track${selected.length === 1 ? "" : "s"}`);
      refreshTabIfOpen();
    }, { title: "Importing Guitar Pro", failureTitle: "Could not import the file" });
  } finally {
    importing = false;
    gpImportConfirm.disabled = false;
    gpImportCancel.disabled = false;
    gpImportClose.disabled = false;
  }
}

export function init_guitar_pro_import() {
  importGpBtn.addEventListener("click", () => gpImportFile.click());
  welcomeGpBtn?.addEventListener("click", () => gpImportFile.click());
  // A window event, not an exported function project.js could call: this module
  // already imports five names from project.js, so a direct call back would close
  // an import cycle. The dispatch side is project.js's drop/open handler.
  window.addEventListener("cw-open-guitar-pro", (event) => chooseFile(event.detail));
  gpImportFile.addEventListener("change", () => {
    const file = gpImportFile.files[0];
    gpImportFile.value = "";
    if (file) chooseFile(file);
  });
  gpImportCancel.addEventListener("click", closeImport);
  gpImportClose.addEventListener("click", closeImport);
  gpImportConfirm.addEventListener("click", confirmImport);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !gpImportBackdrop.hidden) closeImport();
  });
}

