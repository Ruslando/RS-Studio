import { configureEditHistory, commitDiagnostics } from '../../web/edit-history.js';
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
  vm.runInContext(source + `;globalThis.${expose} = {${expose === 'stateApi' ? 'setIssueIgnored, setCategoriesIgnored, issueIgnored, setShowIgnoredIssues, openIssueMenu, issueIgnoreActions, restoreIssues, exportIssueIgnores' : 'rowsFor, rocksmithIssueKinds, initRocksmithIssues, renderRocksmithIssues'}};`, env);
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
assert.deepEqual(Array.from(actions, a => a.label), ['Ignore occurrence'], 'occurrence options affect only that occurrence');
const issues = list.rowsFor(lane);
state.openIssueMenu(0, 0, [{lane, issue: issues[0]}]);
assert.deepEqual(Array.from(actions, a => a.label), ['Ignore occurrence']);
actions[0].fn();
assert.equal(state.issueIgnored(lane, issues[0]), true);
assert.equal(state.issueIgnored(lane, issues[1]), false);
assert.equal(commits, 1);
list.renderRocksmithIssues();
assert.equal(warningList.children[0].children[1].children.length, 1, 'expanded state survives refresh');
assert.equal(warningHeader.children[0].children.at(-1).textContent, '1 (1 ignored)', 'section count includes hidden ignored occurrences');
assert.equal(warningList.children[0].children[0].children[0].children.at(-1).textContent, '1 (1 ignored)', 'category count includes hidden ignored occurrences');
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
const undoState = {state: {}, voicingRevision: 7, undoStack: [], redoStack: [{}]};
let snapping = 0;
configureEditHistory({
  S: undoState, lockedReferenceFault: () => null,
  eachTiming: () => snapping++, editLanes: noop, snapStrayNotes: noop,
  refreshSaveState: noop, draw: noop, undoMI: null, redoMI: null,
});
commitDiagnostics({metadata: 'before'});
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
assert.equal(tooltipActions[0].label, 'Restore occurrence');
tooltipActions[0].fn();
assert.equal(state.issueIgnored(otherLane, markerIssue), false);
state.issueIgnoreActions(otherLane, markerIssue, true)[0].fn();
assert.equal(state.issueIgnored(otherLane, markerIssue), true);
assert.deepEqual(Array.from(state.issueIgnoreActions(otherLane, markerIssue), a => a.label), ['Restore occurrence']);
assert.deepEqual(Array.from(state.issueIgnoreActions(otherLane, markerIssue, true), a => a.label), ['Restore category']);

// Restoring one occurrence inside an ignored category leaves its siblings ignored.
S.state.metadata = {};
env.markerArtifacts = () => [];
lane.notes = [
  {id: 'one', start: 1, end: 2, pitch: 40, fx: {ghost: true}},
  {id: 'two', start: 3, end: 4, pitch: 40, fx: {ghost: true}},
];
otherLane.notes = [{id: 'other', start: 5, end: 6, pitch: 40, fx: {ghost: true}}];
S.voicingRevision++;
const [first, second] = list.rowsFor(lane), [other] = list.rowsFor(otherLane);
state.setCategoriesIgnored([first.key], true);
const beforeRestore = structuredClone(S.state.metadata);
const restoreOccurrence = state.issueIgnoreActions(lane, first)[0];
assert.equal(restoreOccurrence.label, 'Restore occurrence');
assert.equal(state.issueIgnoreActions(lane, first).length, 1, 'ignored occurrence never offers a category action');
restoreOccurrence.fn();
assert.equal(state.issueIgnored(lane, first), false);
assert.equal(state.issueIgnored(lane, second), true);
assert.equal(state.issueIgnored(otherLane, other), true);
assert.equal(state.issueIgnoreActions(lane, first)[0].label, 'Ignore occurrence');
assert.equal(state.issueIgnoreActions(lane, first).length, 1, 'active occurrence never offers a category action');
assert.equal(state.issueIgnoreActions(lane, first, true)[0].label, 'Restore category', 'category menu keeps its scope');
const afterRestore = JSON.parse(JSON.stringify(S.state.metadata));
S.state.metadata = beforeRestore;
assert.equal(state.issueIgnored(lane, first), true, 'undo restores the category acknowledgement');
S.state.metadata = afterRestore;
assert.equal(state.issueIgnored(lane, first), false, 'restored occurrence survives metadata roundtrip and redo');
lane.notes[0].start = 9; S.voicingRevision++;
assert.equal(state.issueIgnored(lane, list.rowsFor(lane).find(i => i.notes[0].id === 'one')), false, 'restored occurrence follows its note');
const exportIgnores = state.exportIssueIgnores([
  {lane, track: 0, issue: first}, {lane, track: 0, issue: second}, {lane: otherLane, track: 1, issue: other},
]);
assert.deepEqual(Array.from(exportIgnores.ignoredIssues), [], 'export does not acknowledge a category containing a restored occurrence');
assert.deepEqual(JSON.parse(JSON.stringify(exportIgnores.ignoredOccurrences)), [
  {track: 0, id: second.key, time: second.time}, {track: 1, id: other.key, time: other.time},
], 'export still acknowledges the ignored siblings');
state.setCategoriesIgnored([first.key], true);
assert.equal(state.issueIgnored(lane, first), true, 'ignoring the category again clears individual restore exceptions');

// Each severity can restore all ignored occurrences with one undo step, without
// restoring other severities or the same category on another layer.
S.state.metadata = {};
lane.notes = []; otherLane.notes = []; S.voicingRevision++;
env.testIssues = [
  {id: 'I01', code: 'I01', title: 'Error', tone: 'error', time: 1},
  {id: 'I35', code: 'I35', title: 'Warning', tone: 'warning', time: 2},
  {id: 'I35', code: 'I35', title: 'Warning', tone: 'warning', time: 3},
  {id: 'export.test-note', code: 'test-note', title: 'Note', tone: 'note', time: 4},
];
vm.runInContext('results = new Map([["a", {issues: testIssues}], ["b", {issues: [testIssues[1]]}]]);', env);
state.setCategoriesIgnored(['I01', 'I35', 'export.test-note'], true);
state.setShowIgnoredIssues(false);
list.renderRocksmithIssues();
assert.equal(warningHeader.children[0].children.at(-1).textContent, '0 (2 ignored)');
for (const [index, tone, count] of [[2, 'warning', 2], [0, 'error', 1], [4, 'note', 1]]) {
  const section = sections.children[index];
  section.children.at(-1).onclick();
  const restoreAll = actions.find(action => action.label === 'Restore all ignored');
  assert.equal(restoreAll.disabled, false, `${tone} bulk restore is reachable with ignored rows hidden`);
  const before = commits;
  restoreAll.fn();
  assert.equal(commits, before + 1, `${tone} restore is one undo step`);
  list.renderRocksmithIssues();
  assert.equal(section.children[0].children.at(-1).textContent, String(count));
  assert.ok(list.rowsFor(lane).filter(issue => issue.tone === tone).every(issue => !state.issueIgnored(lane, issue)));
  assert.equal(state.issueIgnored(otherLane, list.rowsFor(otherLane)[0]), true, 'other layer stays ignored');
  section.children.at(-1).onclick();
  assert.equal(actions.find(action => action.label === 'Restore all ignored').disabled, true, 'empty restore action is disabled');
}

// Compiler warnings retain their marker time and get the same jump action.
env.testIssues = [
  {id: 'export.section-snapped', title: 'Section moved to a measure boundary: Verse',
    help: 'The export moves the section label, not the notes.', tone: 'warning', time: 7.25, target: 'marker:verse'},
];
vm.runInContext('results = new Map([["a", {warningIssues: testIssues}]]);', env);
list.renderRocksmithIssues();
const sectionGroup = warningList.children[0];
sectionGroup.children[0].children[0].onclick();
const warningRow = sectionGroup.children[1].children[0];
const jump = warningRow.children.at(-1).children[0];
assert.equal(jump.attributes['aria-label'], 'Jump to');
jump.handlers.click({stopPropagation() {}});
assert.equal(jumpedTo, 7.25, 'section warning jumps to the source marker');
assert.match(warningRow.dataset.tip, /not the notes/);
console.log('Ignored counts, occurrence restore, severity restore and section navigation passed');
