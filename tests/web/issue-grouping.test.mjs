import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {issueId, issueInstanceKey, migrateIgnoredIssues} from '../../web/issue-identity.js';
import {laneIssues} from '../../web/note-issues.js';
import {issueTone, toneRank} from '../../web/issue-tone.js';

// Exercise the real list/state modules without loading audio or a canvas.
class Element {
  children = []; dataset = {}; attributes = {}; hidden = false; textContent = ''; handlers = {};
  classes = new Set();
  classList = {toggle: (name, enabled) => {if (enabled) this.classes.add(name); else this.classes.delete(name);}, contains: name => this.classes.has(name)};
  append(...items) { this.children.push(...items); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  toggleAttribute(name, value) { if (value) this.attributes[name] = ''; else delete this.attributes[name]; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  get childElementCount() { return this.children.length; }
  getBoundingClientRect() { return {left: 10, bottom: 20}; }
}
const content = new Element(), sections = new Element();
content.querySelector = () => sections;
const lane = {id: 'a', notes: [
  {id: 'n1', start: 1, end: 2, pitch: 40, fx: {ghost: true}},
  {id: 'n2', start: 3, end: 4, pitch: 40, fx: {ghost: true}},
], handHolds: []};
const S = {state: {metadata: {}, editLanes: [lane]}, voicingRevision: 1};
lane.active = true;
let actions, commits = 0, jumpedTo;
const snapshots = [];
const noop = () => {};
const env = vm.createContext({S, issueId, issueInstanceKey, migrateIgnoredIssues, laneIssues, issueTone, toneRank,
  document: {createElement: () => new Element()},
  window: {addEventListener: noop, dispatchEvent: noop}, Event: class {},
  $: id => id === 'artifactsContent' ? content : new Element(),
  snapshotEdit: () => structuredClone(S.state.metadata),
  commitDiagnostics: previous => {snapshots.push(previous); commits++;},
  openDiagnosticMenu: (x, y, entries) => {actions = entries;}, draw: noop,
  markerArtifacts: () => [], laneFretTuning: () => [64, 59, 55, 50, 45, 40], laneFretCount: () => 24,
  rsLeadIn: () => 0, isTablatureLane: () => false, RS_KIND_OPTIONS: [], icon: () => '', shapeGroups: () => new Map(),
  scroll: {clientWidth: 100, scrollTop: 0}, xOf: t => t, seekPlayback: time => {jumpedTo = time;}, moveViewportTo: noop, stopViewportMotion: noop, stopArtifactPreview: noop,
  setTimeout: () => 0, clearTimeout: noop, AbortController,
});
function load(file, expose) {
  const source = readFileSync(new URL(`../../web/${file}.js`, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*$/gm, '').replace(/\bexport /g, '');
  vm.runInContext(source + `;globalThis.${expose} = {${expose === 'stateApi' ? 'setIssueIgnored, setCategoriesIgnored, issueIgnored, setShowIgnoredIssues, openIssueMenu, issueIgnoreActions' : 'rowsFor, rocksmithIssueKinds, initRocksmithIssues, renderRocksmithIssues'}};`, env);
}
load('issue-state', 'stateApi');
load('rocksmith-check', 'listApi');
const {stateApi: state, listApi: list} = env;
list.initRocksmithIssues(); list.renderRocksmithIssues();
assert.equal(content.children.length, 0, 'no standalone filter row above issues');
const warningHeader = sections.children[2], warningBody = sections.children[3];
const warningList = warningBody.children[0];
warningHeader.children.at(-1).onclick();
assert.equal(actions[0].label, 'Show ignored', 'filter lives in the issue header menu');
assert.equal(warningList.children.length, 1, 'same category forms one group');
const group = warningList.children[0], header = group.children[0], instances = group.children[1];
assert.equal(instances.hidden, true);
assert.equal(instances.children.length, 0, 'collapsed groups do not allocate instance rows');
header.children[0].onclick();
assert.equal(instances.hidden, false);
assert.equal(instances.children.length, 2);
assert.equal(header.children.at(-1).className, 'artifact-issue-actions');
assert.equal(instances.children[0].children.at(-1).className, 'artifact-issue-actions', 'category and instance actions share a trailing column');
assert.equal(instances.children[0].children[0].className, 'artifact-issue-mark', 'instances start with their severity icon');
assert.equal(instances.children[0].children.at(-2).className, 'artifact-detail artifact-time', 'timestamp stays beside the menu');
assert.equal(header.children[0].attributes['aria-controls'], instances.id);
const instanceActions = instances.children[0].children.at(-1);
assert.equal(instanceActions.children.length, 2, 'timed instances retain both navigation and menu actions');
assert.equal(instanceActions.children[0].attributes['aria-label'], 'Jump to');
assert.equal(instanceActions.children[1].attributes['aria-label'], 'Options', 'overflow remains in the rightmost column');
let stopped = false;
instanceActions.children[0].handlers.click({stopPropagation() {stopped = true;}});
assert.equal(jumpedTo, 1, 'jump button seeks to its instance');
assert.equal(stopped, true, 'jump does not trigger the row click a second time');
instanceActions.children[1].handlers.click({stopPropagation() {}});
assert.deepEqual(Array.from(actions, a => a.label), ['Ignore instance', 'Ignore category'], 'Options still opens both ignore actions beside Jump to');
const issues = list.rowsFor(lane);
state.openIssueMenu(0, 0, [{lane, issue: issues[0]}]);
assert.deepEqual(Array.from(actions, a => a.label), ['Ignore instance', 'Ignore category']);
actions[0].fn();
assert.equal(state.issueIgnored(lane, issues[0]), true);
assert.equal(state.issueIgnored(lane, issues[1]), false);
assert.equal(commits, 1);
list.renderRocksmithIssues();
assert.equal(warningList.children[0].children[1].children.length, 1, 'expanded state survives refresh');
assert.equal(list.rocksmithIssueKinds([lane]).get(issues[0].key).count, 1, 'export still sees the other occurrence');
lane.notes[0].start = 5; lane.notes[0].end = 6; S.voicingRevision++;
assert.equal(state.issueIgnored(lane, list.rowsFor(lane).find(i => i.notes[0].id === 'n1')), true);
state.setIssueIgnored(lane, issues[0], true, true);
assert.equal(list.rocksmithIssueKinds([lane]).size, 0, 'ignored category no longer blocks');
list.renderRocksmithIssues();
assert.equal(warningHeader.classList.contains('is-empty'), false, 'fully ignored section retains its restore menu');
assert.equal(warningBody.classList.contains('is-empty'), true);
warningHeader.children.at(-1).onclick();
actions[0].fn(); // reveal ignored through the actual header menu
list.renderRocksmithIssues();
warningHeader.children.at(-1).onclick();
assert.equal(actions[0].label, '\u2713 Show ignored');
state.setShowIgnoredIssues(true); list.renderRocksmithIssues();
assert.equal(warningList.children[0].children[1].children.length, 2, 'show ignored restores access');
state.setIssueIgnored(lane, issues[0], true, false);
assert.equal(state.issueIgnored(lane, issues[0]), true, 'restoring category preserves individual acknowledgement');
assert.equal(state.issueIgnored(lane, issues[1]), false);
const saved = JSON.stringify(S.state.metadata);
S.state.metadata = JSON.parse(saved);
assert.equal(state.issueIgnored(lane, issues[0]), true, 'portable metadata restores instance choices');
S.state.metadata = snapshots[0];
assert.equal(state.issueIgnored(lane, issues[0]), false, 'restored metadata invalidates ignore caches');

// Bulk category acknowledgements are one undoable edit; repeated choices are no-ops.
const beforeBulk = commits;
state.setCategoriesIgnored(['editor.adapt.ghost', 'editor.note.stack'], true);
assert.equal(commits, beforeBulk + 1);
state.setCategoriesIgnored(['editor.adapt.ghost', 'editor.note.stack'], true);
assert.equal(commits, beforeBulk + 1);
state.setShowIgnoredIssues(false);
lane.notes = []; S.voicingRevision++;
list.renderRocksmithIssues();
assert.equal(warningHeader.classList.contains('is-empty'), true);
lane.notes = [{id: 'new', start: 1, end: 2, pitch: 40, fx: {ghost: true}}]; S.voicingRevision++;
list.renderRocksmithIssues();
assert.equal(warningHeader.classList.contains('is-empty'), false, 'a new ignored occurrence must restore access to the header');

// Acknowledgement must not run the note edit pipeline or invalidate voicing.
const edit = readFileSync(new URL('../../web/edit.js', import.meta.url), 'utf8');
const recordUndo = edit.match(/function recordUndo\([^]*?\n\}/)[0];
const commitDiagnostics = edit.match(/export function commitDiagnostics\([^]*?\n\}/)[0].replace('export ', '');
const undoState = {state: {}, voicingRevision: 7, undoStack: [], redoStack: [{}]};
let snapping = 0;
const commitMetadata = new Function('S', 'rejectLockedEdit', 'eachTiming', 'editLanes', 'snapStrayNotes', 'updateUndoButtons', 'refreshSaveState', 'draw', 'MAX_UNDO',
  `${recordUndo}; ${commitDiagnostics}; return commitDiagnostics;`)(undoState, () => false, () => snapping++, noop, noop, noop, noop, noop, 100);
commitMetadata({metadata: 'before'});
assert.equal(undoState.voicingRevision, 7);
assert.equal(snapping, 0);
assert.equal(undoState.undoStack.length, 1);
assert.equal(undoState.redoStack.length, 0);

// Export must validate marker diagnostics on selected layers, not only the active one.
const otherLane = {id: 'b', notes: [], active: false};
S.state.editLanes.push(otherLane);
env.markerArtifacts = requested => requested === otherLane ? [{
  key: 'tone:b:m1', lane: otherLane, t: 6,
  issue: {id: 'marker.tone-preset-missing', title: 'Missing preset', tone: 'warning'},
}] : [];
const markerIssue = list.rowsFor(otherLane)[0];
assert.equal(markerIssue.key, 'marker.tone-preset-missing');
assert.equal(list.rocksmithIssueKinds([otherLane]).size, 1);
state.setIssueIgnored(otherLane, markerIssue, false, true);
assert.equal(list.rocksmithIssueKinds([otherLane]).size, 0);
console.log('Header access, action alignment, bulk undo and inactive-layer checks passed');

// Tooltip controls call the same persisted, undoable actions as the menus.
const tooltipActions = state.issueIgnoreActions(otherLane, markerIssue);
assert.equal(tooltipActions[0].label, 'Restore instance');
tooltipActions[0].fn();
assert.equal(state.issueIgnored(otherLane, markerIssue), false);
state.issueIgnoreActions(otherLane, markerIssue)[1].fn();
assert.equal(state.issueIgnored(otherLane, markerIssue), true);
assert.equal(state.issueIgnoreActions(otherLane, markerIssue)[1].label, 'Restore category');
