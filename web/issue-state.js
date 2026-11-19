import { S } from './store.js';
import { issueId, issueInstanceKey, migrateIgnoredIssues } from './issue-identity.js';
import { snapshotEdit, commitDiagnostics } from "./edit-history.js";
import { openDiagnosticMenu } from "./editor-menu.js";
import { draw } from './repaint.js';

export let showIgnoredIssues = false;
export function setShowIgnoredIssues(value) { showIgnoredIssues = value; S.showIgnoredIssues = value; draw(); }
let categorySource, categoryCache = new Set(), instanceSource, instanceCache = new Set();
let restoredSource, restoredCache = new Set();
let laneSource, laneCache = new Set();
// A kind ignored in one layer only: JSON [layer id, kind], like an occurrence's key.
const laneKindKey = (lane, id) => JSON.stringify([lane?.id || 'song', issueId(id)]);
function ignoredLaneKinds() {
  const source = S.state?.metadata?.rocksmith?.ignoredLaneIssues;
  if (source !== laneSource) { laneSource = source; laneCache = new Set(source || []); }
  return laneCache;
}
export function ignoredCategories() {
  const source = S.state?.metadata?.rocksmith?.ignoredIssues;
  if (source !== categorySource) { categorySource = source; categoryCache = migrateIgnoredIssues(source); }
  return categoryCache;
}
function ignoredInstances() {
  const source = S.state?.metadata?.rocksmith?.ignoredInstances;
  if (source !== instanceSource) { instanceSource = source; instanceCache = new Set(source || []); }
  return instanceCache;
}
function restoredInstances() {
  const source = S.state?.metadata?.rocksmith?.restoredInstances;
  if (source !== restoredSource) { restoredSource = source; restoredCache = new Set(source || []); }
  return restoredCache;
}
export function issueIgnored(lane, issue) {
  const key = issueInstanceKey(lane, issue);
  return ignoredInstances().has(key) || (kindIgnored(lane, issue.id || issue.key || issue.code) &&
    !restoredInstances().has(key));
}
// Is this kind ignored in this layer, for the whole song or for the layer alone?
export function kindIgnored(lane, id) {
  return ignoredCategories().has(issueId(id)) || ignoredLaneKinds().has(laneKindKey(lane, id));
}
// Ignore choices are metadata edits: they must not retime notes or rerun voicing.
function changeIgnored(update) {
  if (!S.state) return false;
  const before = { ignoredIssues: ignoredCategories(), ignoredLaneIssues: ignoredLaneKinds(),
    ignoredInstances: ignoredInstances(), restoredInstances: restoredInstances() };
  const values = Object.fromEntries(Object.entries(before).map(([field, entries]) => [field, new Set(entries)]));
  update(values);
  const changed = Object.keys(before).filter(field => before[field].size !== values[field].size ||
    [...before[field]].some(key => !values[field].has(key)));
  if (!changed.length) return false;
  const previous = snapshotEdit();
  const settings = (S.state.metadata ||= {}).rocksmith ||= {};
  for (const field of changed) settings[field] = [...values[field]].sort();
  commitDiagnostics(previous);
  window.dispatchEvent(new Event('cw-issue-ignore-changed'));
  return true;
}
export function setCategoriesIgnored(keys, ignored) {
  const ids = new Set(keys.map(issueId));
  return changeIgnored(values => {
    for (const id of ids) { if (ignored) values.ignoredIssues.add(id); else values.ignoredIssues.delete(id); }
    for (const key of values.restoredInstances) {
      try { if (ids.has(JSON.parse(key)[1])) values.restoredInstances.delete(key); }
      catch { /* Old or invalid occurrence keys cannot match a category. */ }
    }
  });
}
// Ignore or restore kinds in one layer. Restoring a kind the whole song ignores
// keeps it ignored in every other layer. The layer's own occurrence choices of
// those kinds give way to the layer-wide one.
export function setLaneKindsIgnored(lane, keys, ignored, lanes = []) {
  const ids = new Set(keys.map(issueId));
  return changeIgnored(values => {
    for (const id of ids) {
      const key = laneKindKey(lane, id);
      if (ignored) { values.ignoredLaneIssues.add(key); continue; }
      values.ignoredLaneIssues.delete(key);
      if (values.ignoredIssues.delete(id))
        for (const other of lanes) if (other !== lane) values.ignoredLaneIssues.add(laneKindKey(other, id));
    }
    for (const field of ['ignoredInstances', 'restoredInstances']) for (const key of values[field]) {
      try { const [laneId, id] = JSON.parse(key); if (laneId === lane?.id && ids.has(id)) values[field].delete(key); }
      catch { /* Old or invalid occurrence keys belong to no layer. */ }
    }
  });
}
function changeOccurrence(values, lane, issue, ignored) {
  const key = issueInstanceKey(lane, issue);
  if (ignored) { values.ignoredInstances.add(key); values.restoredInstances.delete(key); }
  else {
    values.ignoredInstances.delete(key);
    if (values.ignoredIssues.has(issueId(issue.id || issue.key || issue.code))
      || values.ignoredLaneIssues.has(laneKindKey(lane, issue.id || issue.key || issue.code))) values.restoredInstances.add(key);
    else values.restoredInstances.delete(key);
  }
}
export function restoreIssues(entries) {
  return changeIgnored(values => {
    for (const {lane, issue} of entries) changeOccurrence(values, lane, issue, false);
  });
}
export function exportIssueIgnores(entries) {
  const idOf = issue => issueId(issue.id || issue.key || issue.code);
  const open = entries.filter(({lane, issue}) => !issueIgnored(lane, issue));
  const active = new Set(open.map(({issue}) => idOf(issue)));
  const activeInTrack = new Set(open.map(({track, issue}) => `${track}:${idOf(issue)}`));
  const trackKinds = new Map();
  for (const {lane, track, issue} of entries) {
    const id = idOf(issue), at = `${track}:${id}`;
    if (ignoredLaneKinds().has(laneKindKey(lane, id)) && !activeInTrack.has(at)) trackKinds.set(at, {track, id});
  }
  return {
    // A category with a restored occurrence cannot be acknowledged wholesale.
    ignoredIssues: [...ignoredCategories()].filter(id => !active.has(id)).sort(),
    ignoredTrackIssues: [...trackKinds.values()],
    ignoredOccurrences: entries.filter(({lane, issue}) => issueIgnored(lane, issue))
      .map(({track, issue}) => ({track, id: issue.id || issue.key || issue.code, time: issue.time ?? null})),
  };
}
export function setIssueIgnored(lane, issue, category, ignored) {
  const id = issue.id || issue.key || issue.code;
  if (!category) return changeIgnored(values => changeOccurrence(values, lane, issue, ignored));
  if (ignored) return setCategoriesIgnored([id], true);
  // Restoring lifts the song-wide ignore and this layer's own, from the export window.
  return changeIgnored(values => {
    values.ignoredIssues.delete(issueId(id));
    values.ignoredLaneIssues.delete(laneKindKey(lane, id));
    for (const key of values.restoredInstances) {
      try { if (JSON.parse(key)[1] === issueId(id)) values.restoredInstances.delete(key); }
      catch { /* Old or invalid occurrence keys cannot match a category. */ }
    }
  });
}
// Shared by the context menus and the spectrogram's interactive tooltip. An issue
// the editor can repair itself (`fix`: { label, run }) offers that first.
export function issueIgnoreActions(lane, issue, categoryOnly = false) {
  const category = kindIgnored(lane, issue.id || issue.key || issue.code);
  const instance = issueIgnored(lane, issue);
  return categoryOnly
    ? [{label: category ? 'Restore category' : 'Ignore category', fn: () => setIssueIgnored(lane, issue, true, !category)}]
    : [...(issue.fix ? [{label: `Auto-fix: ${issue.fix.label}`, fn: issue.fix.run}] : []),
      {label: instance ? 'Restore occurrence' : 'Ignore occurrence', fn: () => setIssueIgnored(lane, issue, false, !instance)}];
}
export function openIssueMenu(x, y, entries, categoryOnly = false) {
  openDiagnosticMenu(x, y, entries.flatMap(({lane, issue}) => {
    const actions = issueIgnoreActions(lane, issue, categoryOnly);
    return entries.length > 1 ? [{label: issue.title, children: actions}] : actions;
  }));
}
