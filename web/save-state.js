// ---- unsaved-changes tracking + open-project tab ----
// Dirty = the content that only persists on an explicit Save (notes, grid, and
// mixer settings) has diverged from the last saved/loaded baseline. View state
// (zoom/stem/speed) is deliberately excluded so panning or zooming never reads
// as "unsaved". Metadata, stem edits and cover changes auto-save to the server,
// so they aren't tracked here.
let savedSig = null;
let services;

// Project lifecycle supplies serialization and tab controls after module loading.
// Editing features can then refresh dirty state without importing that lifecycle.
export function configureSaveState(dependencies) { services = dependencies; }

function dirtySig() {
  const b = services.projectBody();
  return JSON.stringify({ editLanes: b.editLanes, grid: b.grid, sectionMarkers: b.sectionMarkers, timings: b.timings,
    scoreBars: b.scoreBars, scoreDuration: b.scoreDuration, projectStart: b.projectStart, stemSettings: b.stemSettings, mix: b.mix });
}

export function isDirty() { const { S } = services; return !!S.state && S.state.job !== "tutorial" && dirtySig() !== savedSig; }

// The current state is now the clean baseline (call after a successful save/export
// or a fresh load). Also refreshes the tab.
export function markSaved() { const { S } = services; savedSig = S.state ? dirtySig() : null; refreshSaveState(); }

// Runs `write` (positions a solve fills in): it is no edit, so a saved project stays
// saved. `write(before)` calls before() ahead of its first change.
export function withoutDirtying(write) {
  let clean = false;
  if (write(() => { clean = !isDirty(); }) && clean) markSaved();
}

// Reflect the open project + dirty state in the app-bar tab.
export function refreshSaveState() {
  const { S, projectName, projTab, projTabName, projDirtyDot, saveBtn, saveAsBtn } = services;
  if (!projTab) return;
  if (!S.state) { projTab.hidden = true; return; }
  projTab.hidden = false;
  projTabName.textContent = projectName(S.state);
  projDirtyDot.hidden = !isDirty();
  saveBtn.disabled = S.state.job === "tutorial";
  saveAsBtn.disabled = S.state.job === "tutorial";
}

