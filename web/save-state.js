// ---- unsaved-changes tracking + open-project tab ----
// Dirty = the content that only persists on an explicit Save (notes, grid, and
// mixer settings) has diverged from the last saved/loaded baseline. View state
// (zoom/stem/speed) is deliberately excluded so panning or zooming never reads
// as "unsaved". Comments and diagnostic acknowledgements are authored content.
// Project details use their own Save changes action; audio assets persist
// independently of note edits.
let savedSig = null, savedContent = null;
let services;

// Project lifecycle supplies serialization and tab controls after module loading.
// Editing features can then refresh dirty state without importing that lifecycle.
export function configureSaveState(dependencies) { services = dependencies; }

function content(b) {
  return { editLanes: b.editLanes.map(({ active, ...lane }) => lane), grid: b.grid, sectionMarkers: b.sectionMarkers, timings: b.timings,
    comments: b.comments, diagnostics: Object.fromEntries(['ignoredIssues', 'ignoredLaneIssues', 'ignoredInstances', 'restoredInstances']
      .map(key => [key, b.metadata?.rocksmith?.[key] || []])), scoreBars: b.scoreBars, scoreDuration: b.scoreDuration,
    projectStart: b.projectStart, stemSettings: b.stemSettings, mix: b.mix };
}
const signature = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const dirtySig = () => signature(content(services.projectBody()));

export function isDirty() { const { S } = services; return !!S.state && S.state.job !== "tutorial" && dirtySig() !== savedSig; }

// The current state is now the clean baseline (call after a successful save/export
// or a fresh load). Also refreshes the tab.
export function markSaved(body) {
  const { S } = services;
  savedContent = S.state ? JSON.parse(JSON.stringify(content(body || services.projectBody()))) : null;
  savedSig = savedContent ? signature(savedContent) : null;
  refreshSaveState();
}

// Audio uploads persist the asset immediately, without saving unrelated edits.
export function acceptSavedAudio(stems) {
  if (!savedContent) return;
  const known = new Set((savedContent.stemSettings || []).map(stem => stem.id));
  const present = new Set(stems.map(stem => stem.id));
  savedContent.stemSettings = [...(savedContent.stemSettings || []).filter(stem => present.has(stem.id)),
    ...stems.filter(stem => !known.has(stem.id))];
  savedSig = signature(savedContent);
  refreshSaveState();
}

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

