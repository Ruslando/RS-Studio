// Runtime bridge back to alphaTab's full score model. The app persists its own
// versioned schema plus the untouched source bytes; alphaTab's version-specific
// JSON format is used only transiently to clone/filter a score in this runtime.

import { MAX_BARS_SCANNED } from "./constants.js";
import { gpProjectionSignature, gpStructuralSignature } from "./guitar-pro-core.js";
import { appendCreatedLanes, applyImportedProjection, applyScoreStructure, validateImportedProjection } from "./guitar-pro-edit.js";
import { songBarStarts } from "./song-bars.js";
import { isTablatureLane } from "./layer-role.js";
import { assignSectionsToBars } from "./section-marker-core.js";
import { S } from "./store.js";

let cacheKey = "";
let cachedSelectedJson = "";

function currentKey() {
  const gp = S.state?.guitarPro;
  return gp ? `${S.state.job}:${gp.sourceRel || ""}:${gp.importedAt || ""}:` +
    `${(gp.selectedTrackIndexes || []).join(",")}` : "";
}

// Visibility and playback are independent from score membership. Apply this
// explicit role before alphaTab construction or automatic fingering begins.
function enabledScoreLanes() {
  return (S.state?.editLanes || []).filter((lane) => isTablatureLane(lane) && lane.notes?.length);
}

function importedLanes() {
  return enabledScoreLanes().filter((lane) => lane.sourceTrackIndex != null);
}

function effectiveScoreProjection(sourceBars = S.state?.scoreBars || []) {
  const base = S.appliedGrid || S.state?.baseGrid || {};
  const markers = [{ t: 0, tsNum: Number(base.tsNum) || 4, tsDen: Number(base.tsDen) || 4 },
    ...(S.state?.tempoMap || [])].sort((a, b) => Number(a.t) - Number(b.t));
  const bars = sourceBars.map((bar) => {
    let active = markers[0];
    for (const marker of markers) {
      if (Number(marker.t) <= Number(bar.seconds) + 1e-6) active = marker;
      else break;
    }
    return { ...bar, timeSignatureNumerator: Number(active.tsNum) || 4,
      timeSignatureDenominator: Number(active.tsDen) || 4 };
  });
  return assignSectionsToBars(bars, S.state?.sectionMarkers || []);
}

function effectiveScoreBars() {
  return effectiveScoreProjection().bars;
}

// Section warnings ride the same `score.cwWarnings` channel the note-level
// export warnings use (guitar-pro-edit.js), so the export UI shows both together.
function appendSectionWarnings(score, warnings) {
  if (!warnings?.length) return;
  score.cwWarnings = [...(score.cwWarnings || []), ...warnings];
}

export function selectGpScoreTracks(alphaTabRuntime, fullScore, selectedTrackIndexes) {
  const selected = new Set((selectedTrackIndexes || []).map(Number));
  const serialized = JSON.parse(alphaTabRuntime.model.JsonConverter.scoreToJson(fullScore));
  serialized.tracks = (serialized.tracks || []).filter((_, index) => selected.has(index));
  if (!serialized.tracks.length) throw new Error("The imported project no longer identifies any source tracks");
  return alphaTabRuntime.model.JsonConverter.jsonToScore(
    JSON.stringify(serialized), new alphaTabRuntime.Settings(),
  );
}

// Clone a single authored staff out of a selected Guitar Pro score. Imported
// tracks can contain several staves, while one app layer represents exactly
// one of them; filtering only the track would still render sibling layers.
export function selectGpScoreLane(alphaTabRuntime, score, trackPosition, staffPosition = 0) {
  const serialized = JSON.parse(alphaTabRuntime.model.JsonConverter.scoreToJson(score));
  const track = serialized.tracks?.[Number(trackPosition)];
  const staff = track?.staves?.[Number(staffPosition)];
  if (!track || !staff) throw new Error("The selected Guitar Pro layer is no longer present in its source score");
  track.staves = [staff];
  serialized.tracks = [track];
  return alphaTabRuntime.model.JsonConverter.jsonToScore(
    JSON.stringify(serialized), new alphaTabRuntime.Settings(),
  );
}

export function originalGpProjectionStatus() {
  const gp = S.state?.guitarPro;
  if (!gp?.sourceRel) return { available: false, pristine: false, reason: "This project has no imported Guitar Pro source." };
  if (!gp.projectionSignature || !gp.structuralSignature)
    return { available: true, pristine: false, exportable: false, reason: "No modern-export integrity markers — re-import the score." };
  const lanes = importedLanes();
  const manualLanes = enabledScoreLanes().filter((lane) => lane.sourceTrackIndex == null);
  if (!lanes.length && !manualLanes.length) return { available: true, pristine: false, exportable: false, reason: "No tablature tracks remain to export." };
  const scoreDuration = Number(S.state?.scoreDuration) || Number(gp.score?.durationSeconds);
  if (Number.isFinite(scoreDuration) && lanes.some((lane) => lane.notes.some((note) => note.start < 0 || note.end > scoreDuration + 1e-6)))
    return { available: true, pristine: false, exportable: false,
      reason: "Modern export cannot place notes before the first or beyond the final imported score bar." };
  for (const track of gp.selectedTracks || []) {
    const present = new Set(lanes.filter((lane) => lane.sourceTrackIndex === track.index).map((lane) => lane.sourceStaffIndex));
    if (present.size && (track.staves || []).some((staff) => !present.has(staff.index)))
      return { available: true, pristine: false, exportable: false,
        reason: `Keep or remove all staves of “${track.name}” together for modern export.` };
  }
  const pristine = !manualLanes.length && gpProjectionSignature(importedLanes()) === gp.projectionSignature;
  if (pristine) return { available: true, pristine: true, exportable: true, reason: "" };
  if ((gp.schemaVersion || 1) < 2 && gpStructuralSignature(importedLanes()) !== gp.structuralSignature)
    return { available: true, pristine: false, exportable: false,
      reason: "Re-import this Guitar Pro file once before exporting timing or effect edits." };
  try {
    validateImportedProjection(importedLanes());
  } catch (error) {
    return { available: true, pristine: false, exportable: false, reason: error.message };
  }
  return { available: true, pristine: false, exportable: true, reason: "" };
}

export function modernGpProjectionStatus() {
  if (S.state?.guitarPro?.sourceRel) return originalGpProjectionStatus();
  const lanes = enabledScoreLanes();
  if (!lanes.length) return { available: false, pristine: false, exportable: false, reason: "No tablature tracks remain to export." };
  return { available: true, pristine: false, exportable: true, reason: "" };
}

function blankProjectScore(alphaTabRuntime) {
  const score = new alphaTabRuntime.model.Score();
  score.title = S.state?.metadata?.title || S.state?.name || "Untitled";
  score.artist = S.state?.metadata?.artist || "";
  score.album = S.state?.metadata?.album || "";
  const base = S.appliedGrid || S.state?.baseGrid || {};
  const first = { t: 0, bpm: Number(base.bpm) || Number(S.state?.detectedTempo) || 120,
    tsNum: Number(base.tsNum) || 4, tsDen: Number(base.tsDen) || 4 };
  const markers = [first, ...(S.state?.tempoMap || [])]
    .map((marker) => ({ ...marker, t: Math.max(0, Number(marker.t) || 0) }))
    .sort((a, b) => a.t - b.t);
  const duration = Math.max(Number(S.state?.scoreDuration) || 0, Number(S.state?.duration) || 0,
    ...(S.state?.editLanes || []).flatMap((lane) => lane.notes.map((note) => Number(note.end) || 0)), 1);
  const structure = effectiveScoreBars();
  let seconds = 0, markerIndex = 0, previousTempo = null, guard = 0;
  const barStarts = [];
  while (seconds < duration - 1e-6 && guard++ < MAX_BARS_SCANNED) {
    while (markerIndex + 1 < markers.length && markers[markerIndex + 1].t <= seconds + 1e-5) markerIndex++;
    const marker = markers[markerIndex];
    barStarts.push(seconds);
    const bar = new alphaTabRuntime.model.MasterBar(), item = structure[guard - 1];
    bar.timeSignatureNumerator = Math.max(1, Math.round(Number(item?.timeSignatureNumerator ?? marker.tsNum) || 4));
    bar.timeSignatureDenominator = Math.max(1, Math.round(Number(item?.timeSignatureDenominator ?? marker.tsDen) || 4));
    if (previousTempo !== marker.bpm) {
      const automation = new alphaTabRuntime.model.Automation();
      automation.type = alphaTabRuntime.model.AutomationType.Tempo;
      automation.value = Math.max(1, Number(marker.bpm) || 120); automation.ratioPosition = 0;
      bar.tempoAutomations.push(automation); previousTempo = marker.bpm;
    }
    score.addMasterBar(bar);
    const durationSeconds = bar.timeSignatureNumerator * 4 / bar.timeSignatureDenominator * 60 / (Number(marker.bpm) || 120);
    // Where the next bar starts, in priority order:
    const nextMarker = markers[markerIndex + 1]?.t;
    const markerInsideThisBar = nextMarker != null
      && nextMarker > seconds + 1e-5 && nextMarker < seconds + durationSeconds - 1e-5;
    if (item) seconds += Number(item.durationSeconds) || durationSeconds;   // the authored length
    else if (markerInsideThisBar) seconds = nextMarker;                     // a tempo change cuts it short
    else seconds += durationSeconds;                                        // the computed length
    if (structure.length && guard >= structure.length) break;
  }
  if (guard >= MAX_BARS_SCANNED)
    throw new Error(`Score is longer than ${MAX_BARS_SCANNED} bars; the export would be truncated.`);
  score.cwBarSeconds = barStarts;
  return score;
}

function projectStructureForGeneratedScore(score) {
  const stored = effectiveScoreBars();
  const generated = score.masterBars.map((bar, index) => ({
    sourceIndex: index,
    seconds: score.cwBarSeconds?.[index] || 0,
    timeSignatureNumerator: bar.timeSignatureNumerator,
    timeSignatureDenominator: bar.timeSignatureDenominator,
    keySignature: bar.keySignature,
    keySignatureType: bar.keySignatureType,
  }));
  const projection = effectiveScoreProjection(stored.length ? stored : generated);
  return {
    bars: projection.bars.map((bar, index) => ({ ...bar, sourceIndex: index })),
    warnings: projection.warnings,
  };
}

export function applyProjectionToGpScore(alphaTabRuntime, score, lanes, selectedTrackIndexes) {
  return applyImportedProjection(alphaTabRuntime, score, lanes, selectedTrackIndexes);
}

async function selectedOriginalGpScore(alphaTabRuntime, signal) {
  const key = currentKey();
  if (!key) throw new Error("This project has no imported Guitar Pro source");
  if (key === cacheKey && cachedSelectedJson)
    return alphaTabRuntime.model.JsonConverter.jsonToScore(cachedSelectedJson, new alphaTabRuntime.Settings());
  const response = await fetch(`/api/projects/${S.state.job}/guitar-pro/source`, { signal });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || "Guitar Pro source is unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const settings = new alphaTabRuntime.Settings();
  const full = alphaTabRuntime.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  const selected = selectGpScoreTracks(alphaTabRuntime, full, S.state.guitarPro.selectedTrackIndexes);
  cachedSelectedJson = alphaTabRuntime.model.JsonConverter.scoreToJson(selected);
  cacheKey = key;
  return selected;
}

export async function selectedOriginalGpLaneScore(alphaTabRuntime, lane, signal) {
  if (lane?.sourceTrackIndex == null)
    throw new Error("The selected layer was not part of the imported Guitar Pro file");
  const selectedIndexes = (S.state?.guitarPro?.selectedTrackIndexes || []).map(Number);
  const trackPosition = selectedIndexes.indexOf(Number(lane.sourceTrackIndex));
  if (trackPosition < 0) throw new Error("The selected layer's source track is no longer imported");
  const score = await selectedOriginalGpScore(alphaTabRuntime, signal);
  return selectGpScoreLane(alphaTabRuntime, score, trackPosition, Number(lane.sourceStaffIndex) || 0);
}

export async function modernGpResult(alphaTabRuntime, signal) {
  const status = modernGpProjectionStatus();
  if (!status.available || !status.exportable) throw new Error(status.reason);
  const score = await projectedGpScore(alphaTabRuntime, signal);
  return {
    bytes: new alphaTabRuntime.exporter.Gp7Exporter().export(score, new alphaTabRuntime.Settings()),
    warnings: [...(score.cwWarnings || [])],
  };
}

export async function projectedGpScore(alphaTabRuntime, signal) {
  const status = modernGpProjectionStatus();
  if (!status.available || !status.exportable) throw new Error(status.reason);
  if (!S.state.guitarPro?.sourceRel) {
    const lanes = enabledScoreLanes();
    const score = blankProjectScore(alphaTabRuntime);
    appendCreatedLanes(alphaTabRuntime, score, lanes, songBarStarts());
    const structure = projectStructureForGeneratedScore(score);
    applyScoreStructure(alphaTabRuntime, score, structure.bars);
    appendSectionWarnings(score, structure.warnings);
    return score;
  }
  let score = await selectedOriginalGpScore(alphaTabRuntime, signal);
  const originalSelection = S.state.guitarPro.selectedTrackIndexes.map(Number);
  const liveSet = new Set(importedLanes().map((lane) => Number(lane.sourceTrackIndex)));
  const liveSelection = originalSelection.filter((index) => liveSet.has(index));
  if (liveSelection.length && liveSelection.length !== originalSelection.length) {
    const serialized = JSON.parse(alphaTabRuntime.model.JsonConverter.scoreToJson(score));
    serialized.tracks = serialized.tracks.filter((_, position) => liveSet.has(originalSelection[position]));
    score = alphaTabRuntime.model.JsonConverter.jsonToScore(JSON.stringify(serialized), new alphaTabRuntime.Settings());
  }
  const structure = effectiveScoreProjection();
  applyScoreStructure(alphaTabRuntime, score, structure.bars);
  appendSectionWarnings(score, structure.warnings);
  if (!liveSelection.length) score.tracks = [];
  if (!status.pristine && liveSelection.length)
    applyProjectionToGpScore(alphaTabRuntime, score, importedLanes(), liveSelection);
  const created = enabledScoreLanes().filter((lane) => lane.sourceTrackIndex == null);
  const importedTracks = new Map(liveSelection.map((sourceIndex, index) => [sourceIndex, score.tracks[index]]));
  appendCreatedLanes(alphaTabRuntime, score, created, songBarStarts());
  const createdTracks = new Map(created.map((lane, index) => [lane.id, score.tracks[liveSelection.length + index]]));
  const ordered = [], seen = new Set();
  for (const lane of S.state.editLanes || []) {
    const track = lane.sourceTrackIndex == null ? createdTracks.get(lane.id) : importedTracks.get(Number(lane.sourceTrackIndex));
    if (track && !seen.has(track)) { seen.add(track); ordered.push(track); }
  }
  score.tracks = ordered;
  score.finish(new alphaTabRuntime.Settings());
  return score;
}

// Preview is intentionally lane-scoped. Export continues through
// projectedGpScore() and therefore retains every enabled tablature layer.
export async function projectedGpLaneScore(alphaTabRuntime, lane, signal) {
  if (!isTablatureLane(lane) || !lane?.notes?.length)
    throw new Error("The selected layer has no enabled tablature to preview");

  if (!S.state?.guitarPro?.sourceRel) {
    const score = blankProjectScore(alphaTabRuntime);
    appendCreatedLanes(alphaTabRuntime, score, [lane], songBarStarts());
    const structure = projectStructureForGeneratedScore(score);
    applyScoreStructure(alphaTabRuntime, score, structure.bars);
    appendSectionWarnings(score, structure.warnings);
    return score;
  }

  let score = await selectedOriginalGpScore(alphaTabRuntime, signal);

  if (lane.sourceTrackIndex == null) {
    // A layer created after GP import shares the imported bar structure but is
    // not represented by any original track.
    score = selectGpScoreLane(alphaTabRuntime, score, 0, 0);
    applyScoreStructure(alphaTabRuntime, score, effectiveScoreBars());
    score.tracks = [];
    appendCreatedLanes(alphaTabRuntime, score, [lane], songBarStarts());
    score.finish(new alphaTabRuntime.Settings());
    return score;
  }

  const selectedIndexes = S.state.guitarPro.selectedTrackIndexes.map(Number);
  const trackPosition = selectedIndexes.indexOf(Number(lane.sourceTrackIndex));
  if (trackPosition < 0) throw new Error("The selected layer's source track is no longer imported");
  score = selectGpScoreLane(alphaTabRuntime, score, trackPosition, Number(lane.sourceStaffIndex) || 0);
  applyScoreStructure(alphaTabRuntime, score, effectiveScoreBars());
  applyProjectionToGpScore(alphaTabRuntime, score,
    [{ ...lane, sourceStaffIndex: 0 }], [Number(lane.sourceTrackIndex)]);
  return score;
}

export function clearOriginalGpScoreCache() {
  cacheKey = "";
  cachedSelectedJson = "";
}
