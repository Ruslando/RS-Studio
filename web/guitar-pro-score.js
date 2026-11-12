// The project's layers as an alphaTab score, for the Guitar Pro export and the
// tab preview.

import { MAX_BARS_SCANNED } from "./constants.js";
import { gpProjectionSignature, unpackLaneSource } from "./guitar-pro-core.js";
import { appendCreatedLanes, applyImportedProjection, applyScoreStructure, renumberScoreIds, validateImportedProjection } from "./guitar-pro-edit.js";
import { songBarStarts } from "./song-bars.js";
import { isTablatureLane } from "./layer-role.js";
import { assignSectionsToBars } from "./section-marker-core.js";
import { S } from "./store.js";
import { onLiveTiming, timingIdOf } from "./timing.js";
import { laneFingering } from "./lane-fingering.js";

// Visibility and playback are independent from score membership. Apply this
// explicit role before alphaTab construction or automatic fingering begins.
// A score has one tempo map: the layers that share the active layer's timing.
function enabledScoreLanes() {
  return (S.state?.editLanes || []).filter((lane) => isTablatureLane(lane) && lane.notes?.length && onLiveTiming(lane));
}

// A layer imported from a Guitar Pro file carries its source track (gpSource,
// guitar-pro-core.js packLaneSource) and is exported from it: what the editor
// shows is written into the track, everything else in it stays as imported. Only
// on the timing it came in with, whose bars are its file's bars.
// Debug export (File menu): ignore the stored sources and write every layer from
// what the editor holds, to see what an import missed.
export const gpDebug = { asSeen: false, rebuildAll: false };
const sourced = (lane) => !gpDebug.asSeen && !!lane.gpSource?.data && timingIdOf(lane) === lane.gpSource.timing;

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

export function modernGpProjectionStatus() {
  const lanes = enabledScoreLanes();
  if (!lanes.length) return { available: false, pristine: false, exportable: false, reason: "No tablature tracks remain to export." };
  const fromSource = lanes.filter(sourced);
  const scoreDuration = Number(S.state?.scoreDuration);
  if (Number.isFinite(scoreDuration) && scoreDuration > 0
    && fromSource.some((lane) => lane.notes.some((note) => note.start < 0 || note.end > scoreDuration + 1e-6)))
    return { available: true, pristine: false, exportable: false,
      reason: "Notes lie before the first or beyond the last bar of the imported score." };
  try {
    validateImportedProjection(fromSource);
  } catch (error) {
    return { available: true, pristine: false, exportable: false, reason: error.message };
  }
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

// One imported layer's score: its source track with the project's bars and the
// layer's edits written in. `played` is the layer fingered (fingered below).
const sourceScores = new Map();   // ponytail: one unpacked JSON per source, kept for the session
async function sourcedLaneScore(alphaTabRuntime, lane, played) {
  const data = lane.gpSource.data;
  if (!sourceScores.has(data)) {
    const score = await unpackLaneSource(alphaTabRuntime, data);
    sourceScores.set(data, alphaTabRuntime.model.JsonConverter.scoreToJson(score));
  }
  const score = alphaTabRuntime.model.JsonConverter.jsonToScore(sourceScores.get(data), new alphaTabRuntime.Settings());
  applyScoreStructure(alphaTabRuntime, score, effectiveScoreBars());
  if (gpDebug.rebuildAll || gpProjectionSignature(lane) !== lane.gpSource.projection || movedOff([lane], [played]))
    applyImportedProjection(alphaTabRuntime, score, [{ ...played, sourceTrackIndex: 0, sourceStaffIndex: 0 }], [0],
      { rebuildAll: gpDebug.rebuildAll });
  return score;
}

// Every note on the position laneFingering gives it — the one the fretboard, the tab
// view and the Rocksmith export use — so the file never disagrees with the screen.
// Copies: exporting must not edit the project.
async function fingered(lanes, signal) {
  return Promise.all(lanes.map(async (lane) => {
    const { voiced } = await laneFingering(lane, signal);
    return { ...lane, notes: lane.notes.map((note) => {
      const pos = voiced.get(note);
      return pos ? { ...note, pos: { ...note.pos, string: pos.string, fret: pos.fret, scope: note.pos?.scope || "local" } } : note;
    }) };
  }));
}

// A reference group can move a note off its stored position without editing any
// note, which the import signature cannot see; the original file would then say
// something the screen does not.
const movedOff = (stored, played) => stored.some((lane, i) => lane.notes.some((note, k) =>
  note.pos?.string !== played[i].notes[k].pos?.string || note.pos?.fret !== played[i].notes[k].pos?.fret));

export async function modernGpResult(alphaTabRuntime, signal) {
  const status = modernGpProjectionStatus();
  if (!status.available || !status.exportable) throw new Error(status.reason);
  const score = await projectedGpScore(alphaTabRuntime, signal);
  return {
    bytes: new alphaTabRuntime.exporter.Gp7Exporter().export(score, new alphaTabRuntime.Settings()),
    warnings: [...(score.cwWarnings || [])],
  };
}

async function projectedGpScore(alphaTabRuntime, signal) {
  const status = modernGpProjectionStatus();
  if (!status.available || !status.exportable) throw new Error(status.reason);
  return layersScore(alphaTabRuntime, enabledScoreLanes(), signal);
}

// Preview is intentionally lane-scoped. Export continues through
// projectedGpScore() and therefore retains every enabled tablature layer.
export async function projectedGpLaneScore(alphaTabRuntime, lane, signal) {
  if (!isTablatureLane(lane) || !lane?.notes?.length)
    throw new Error("The selected layer has no enabled tablature to preview");
  return layersScore(alphaTabRuntime, [lane], signal);
}

// Imported layers come from their sources, the rest are written from their notes.
// The first imported layer's score takes in every other track: their bars are the
// same project bars (applyScoreStructure), so the tracks line up bar for bar.
async function layersScore(alphaTabRuntime, lanes, signal) {
  const played = await fingered(lanes, signal);
  const tracks = new Map();
  let score = null;
  for (const [i, lane] of lanes.entries()) {
    if (!sourced(lane)) continue;
    const own = await sourcedLaneScore(alphaTabRuntime, lane, played[i]);
    if (score && own.masterBars.length !== score.masterBars.length) {
      // ponytail: layers from files with different bars cannot share one score; written from notes instead
      score.cwWarnings = [...(score.cwWarnings || []), `${lane.name}: its file's bars differ from the other imported layers; written from its notes`];
      continue;
    }
    if (!score) score = own;
    else score.addTrack(own.tracks[0]);
    tracks.set(lane, score.tracks.at(-1));
  }
  const created = lanes.map((lane, i) => [lane, played[i]]).filter(([lane]) => !tracks.has(lane));
  if (!score) {
    score = blankProjectScore(alphaTabRuntime);
    appendCreatedLanes(alphaTabRuntime, score, created.map(([, p]) => p), songBarStarts());
    const structure = projectStructureForGeneratedScore(score);
    applyScoreStructure(alphaTabRuntime, score, structure.bars);
    appendSectionWarnings(score, structure.warnings);
    return score;
  }
  appendSectionWarnings(score, effectiveScoreProjection().warnings);
  const before = score.tracks.length;
  appendCreatedLanes(alphaTabRuntime, score, created.map(([, p]) => p), songBarStarts());
  created.forEach(([lane], i) => tracks.set(lane, score.tracks[before + i]));
  score.tracks = lanes.map((lane) => tracks.get(lane)).filter(Boolean);
  score.tracks.forEach((track, index) => { track.index = index; });
  renumberScoreIds(score);
  score.finish(new alphaTabRuntime.Settings());
  return score;
}
