// The app's Guitar Pro import and export, run headless on one track: the same
// modules the editor uses (guitar-pro-core.js, guitar-pro-import.js,
// guitar-pro-score.js), with the project state a fresh project made from the
// file would have.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const WEB = new URL("../../web/", import.meta.url);
// alphaTab first: with a `window` it would take its browser path.
export const alphaTab = createRequire(import.meta.url)(new URL("vendor/alphatab/alphaTab.min.js", WEB).pathname);
await import("./dom-stub.mjs");
const settings = () => new alphaTab.Settings();
const web = (name) => import(new URL(name, WEB).href);
const [{ S }, core, gpImport, project, gpScore, timing, fields, toneCore] = await Promise.all(
  ["store.js", "guitar-pro-core.js", "guitar-pro-import.js", "project.js", "guitar-pro-score.js", "timing.js",
    "marker-rails.js", "tone-marker-core.js"].map(web));
// What the app registers at start-up (tone-markers.js init_tone_markers), so a layer loads its tone switches.
fields.registerLaneField("toneMarkers", { normalize: toneCore.normalizeToneMarkers });

export const load = (bytes) => alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings());
export const write = (score) => new alphaTab.exporter.Gp7Exporter().export(score, settings());
export const loadFile = (path) => load(new Uint8Array(readFileSync(path)));
// What a .gp file keeps of a score: written and read back.
export const asFile = (score) => load(write(score));

// Guitar and bass tracks the import offers, as [trackIndex, name].
export const importableTracks = (score) => core.inspectGpScore(score).tracks
  .filter((t) => t.supported).map((t) => [t.index, t.name]);

// Import one track (its first staff) as a new project would, then export the layer.
// `mode`:
//   "source"  the normal export of an untouched layer (its stored track),
//   "rebuilt" the normal export with every bar rewritten from the layer (as after edits everywhere),
//   "seen"    what the layer holds, its hidden source data included ("as the editor sees it"),
//   "editor"  only the editor's own note fields: what the spectrogram shows and edits.
// `edit(lane)` changes the layer after import, as the user would.
export async function roundTrip(score, trackIndex, mode, edit = null) {
  const converted = core.convertGpScore(score, [trackIndex]);
  const lane = project.mapLane(converted.editLanes[0], 0);
  const grid = converted.grid;
  S.state = { job: "audit", name: converted.name, filename: "audit.gp", editLanes: [lane], duration: converted.duration,
    scoreDuration: converted.duration, metadata: converted.metadata, sectionMarkers: [], tempoMap: [], timings: {} };
  const { scoreBars, sectionMarkers, target } = gpImport.importedStructure(converted);
  Object.assign(S.state, { scoreBars, sectionMarkers, scoreDuration: target, tempoMap: grid.tempoMap.map((m) => ({ ...m })) });
  S.appliedGrid = { bpm: grid.bpm, offset: +grid.offset || 0, subdiv: grid.subdiv, tsNum: grid.tsNum, tsDen: grid.tsDen };
  S.state.baseGrid = { ...S.appliedGrid };
  const full = JSON.parse(alphaTab.model.JsonConverter.scoreToJson(score));
  lane.gpSource = { data: await core.packLaneSource(full, trackIndex, 0), part: `audit:${trackIndex}`,
    timing: timing.timingIdOf(lane), projection: core.gpProjectionSignature(lane) };
  if (mode === "editor") for (const n of lane.notes) delete n.gp;
  edit?.(lane);
  gpScore.gpDebug.asSeen = mode === "seen" || mode === "editor";
  gpScore.gpDebug.rebuildAll = mode === "rebuilt";
  try {
    const out = await gpScore.projectedGpLaneScore(alphaTab, lane);
    return { score: asFile(out), lane, warnings: out.cwWarnings || [] };
  } finally { gpScore.gpDebug.asSeen = false; gpScore.gpDebug.rebuildAll = false; }
}
