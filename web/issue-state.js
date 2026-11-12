import { S } from './store.js';
import { issueId, issueInstanceKey, migrateIgnoredIssues } from './issue-identity.js';
import { snapshotEdit, commitDiagnostics } from "./edit-history.js";
import { openDiagnosticMenu } from "./edit.js";
import { draw } from './repaint.js';

export let showIgnoredIssues = false;
export function setShowIgnoredIssues(value) { showIgnoredIssues = value; S.showIgnoredIssues = value; draw(); }
let categorySource, categoryCache = new Set(), instanceSource, instanceCache = new Set();
let restoredSource, restoredCache = new Set();
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
  return ignoredInstances().has(key) || (ignoredCategories().has(issueId(issue.id || issue.key || issue.code)) &&
    !restoredInstances().has(key));
}
// Ignore choices are metadata edits: they must not retime notes or rerun voicing.
function changeIgnored(update) {
  if (!S.state) return false;
  const before = { ignoredIssues: ignoredCategories(), ignoredInstances: ignoredInstances(), restoredInstances: restoredInstances() };
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
function changeOccurrence(values, lane, issue, ignored) {
  const key = issueInstanceKey(lane, issue);
  if (ignored) { values.ignoredInstances.add(key); values.restoredInstances.delete(key); }
  else {
    values.ignoredInstances.delete(key);
    if (values.ignoredIssues.has(issueId(issue.id || issue.key || issue.code))) values.restoredInstances.add(key);
    else values.restoredInstances.delete(key);
  }
}
export function restoreIssues(entries) {
  return changeIgnored(values => {
    for (const {lane, issue} of entries) changeOccurrence(values, lane, issue, false);
  });
}
export function exportIssueIgnores(entries) {
  const active = new Set(entries.filter(({lane, issue}) => !issueIgnored(lane, issue))
    .map(({issue}) => issueId(issue.id || issue.key || issue.code)));
  return {
    // A category with a restored occurrence cannot be acknowledged wholesale.
    ignoredIssues: [...ignoredCategories()].filter(id => !active.has(id)).sort(),
    ignoredOccurrences: entries.filter(({lane, issue}) => issueIgnored(lane, issue))
      .map(({track, issue}) => ({track, id: issue.id || issue.key || issue.code, time: issue.time ?? null})),
  };
}
export function setIssueIgnored(lane, issue, category, ignored) {
  return category ? setCategoriesIgnored([issue.id || issue.key || issue.code], ignored)
    : changeIgnored(values => changeOccurrence(values, lane, issue, ignored));
}
// Shared by the context menus and the spectrogram's interactive tooltip.
export function issueIgnoreActions(lane, issue, categoryOnly = false) {
  const category = ignoredCategories().has(issueId(issue.id || issue.key || issue.code));
  const instance = issueIgnored(lane, issue);
  return categoryOnly
    ? [{label: category ? 'Restore category' : 'Ignore category', fn: () => setIssueIgnored(lane, issue, true, !category)}]
    : [{label: instance ? 'Restore occurrence' : 'Ignore occurrence', fn: () => setIssueIgnored(lane, issue, false, !instance)}];
}
export function openIssueMenu(x, y, entries, categoryOnly = false) {
  openDiagnosticMenu(x, y, entries.flatMap(({lane, issue}) => {
    const actions = issueIgnoreActions(lane, issue, categoryOnly);
    return entries.length > 1 ? [{label: issue.title, children: actions}] : actions;
  }));
}
