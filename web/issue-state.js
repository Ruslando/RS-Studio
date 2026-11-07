import { S } from './store.js';
import { issueId, issueInstanceKey, migrateIgnoredIssues } from './issue-identity.js';
import { snapshotEdit, commitDiagnostics, openDiagnosticMenu } from './edit.js';
import { draw } from './repaint.js';

export let showIgnoredIssues = false;
export function setShowIgnoredIssues(value) { showIgnoredIssues = value; S.showIgnoredIssues = value; draw(); }
let categorySource, categoryCache = new Set(), instanceSource, instanceCache = new Set();
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
export function issueIgnored(lane, issue) {
  return ignoredCategories().has(issueId(issue.id || issue.key || issue.code)) ||
    ignoredInstances().has(issueInstanceKey(lane, issue));
}
// Ignore choices are metadata edits: they must not retime notes or rerun voicing.
function changeIgnored(field, keys, ignored) {
  if (!S.state) return false;
  const values = new Set(field === 'ignoredIssues' ? ignoredCategories() : ignoredInstances());
  if (!keys.some(key => values.has(key) !== ignored)) return false;
  const previous = snapshotEdit();
  for (const key of keys) { if (ignored) values.add(key); else values.delete(key); }
  const settings = (S.state.metadata ||= {}).rocksmith ||= {};
  settings[field] = [...values].sort();
  commitDiagnostics(previous);
  window.dispatchEvent(new Event('cw-issue-ignore-changed'));
  return true;
}
export function setCategoriesIgnored(keys, ignored) {
  return changeIgnored('ignoredIssues', keys.map(issueId), ignored);
}
export function setIssueIgnored(lane, issue, category, ignored) {
  return category ? setCategoriesIgnored([issue.id || issue.key || issue.code], ignored)
    : changeIgnored('ignoredInstances', [issueInstanceKey(lane, issue)], ignored);
}
// Shared by the context menus and the spectrogram's interactive tooltip.
export function issueIgnoreActions(lane, issue, categoryOnly = false) {
  const category = ignoredCategories().has(issueId(issue.id || issue.key || issue.code));
  const instance = ignoredInstances().has(issueInstanceKey(lane, issue));
  return [
    ...(!categoryOnly ? [{label: instance ? 'Restore instance' : 'Ignore instance', fn: () => setIssueIgnored(lane, issue, false, !instance)}] : []),
    {label: category ? 'Restore category' : 'Ignore category', fn: () => setIssueIgnored(lane, issue, true, !category)},
  ];
}
export function openIssueMenu(x, y, entries, categoryOnly = false) {
  openDiagnosticMenu(x, y, entries.flatMap(({lane, issue}) => {
    const actions = issueIgnoreActions(lane, issue, categoryOnly);
    return entries.length > 1 ? [{label: issue.title, children: actions}] : actions;
  }));
}
