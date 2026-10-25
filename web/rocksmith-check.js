// Live Rocksmith check: what the export would report, while the chart is edited.
//
// The server runs the export's own compile and its port of DLC Builder's
// checker (rocksmith/checker.py) on the spec the export would send, so the
// list here is the list DLC Builder shows for the finished package. A check
// starts once edits have settled; a newer one cancels the one in flight.
// Results are listed for the active layer in the artifact pane under Errors and
// Warnings, with the editor's own note problems (note-issues.js) and the flags'
// (design.md 10), and framed on the stage around the notes they concern.
import { $, scroll } from './dom.js';
import { S } from './store.js';
import { buildSpecForLanesAsync, laneFretCount, laneFretTuning, laneTuning } from './tablature.js';
import { laneIssues } from './note-issues.js';
import { RS_KIND_OPTIONS, isTablatureLane } from './layer-role.js';
import { rsLeadIn } from './rocksmith-export.js';
import { seekPlayback } from './playback.js';
import { xOf } from './geometry.js';
import { moveViewportTo, stopViewportMotion } from './viewport-motion.js';
import { stopArtifactPreview } from './artifact-preview.js';
import { draw } from './repaint.js';
import { icon } from './icons.js';
import { markerArtifacts } from './marker-artifacts.js';

const SETTLE_MS = 700;
const SAME_ONSET = 0.003;   // the check reports whole milliseconds of a float32 time
const KINDS = new Set(RS_KIND_OPTIONS.map(([kind]) => kind));
const chevron = '<svg class="side-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const clock = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;

let results = new Map();          // lane id -> { issues, warnings, error }
let lastKey = null, timer = 0, inFlight = null;
const lists = new Map();         // 'error' | 'warning' -> { list, count, head, body, shown }

// Layers the export would offer with their own arrangement.
const checkedLanes = () => (S.state?.editLanes || []).filter(lane =>
  isTablatureLane(lane) && KINDS.has(lane.rocksmithArrangement)
  && lane.notes?.length && [4, 6].includes(laneTuning(lane).length));

// Everything the spec is built from, cheaply: edits bump the voicing revision,
// markers and layer settings are read directly.
function checkKey() {
  const marks = items => (items || []).map(item => [item.t, item.tone ?? item.sectionType ?? null]);
  return JSON.stringify([S.voicingRevision, S.state.duration, rsLeadIn(), S.state.grid, S.state.tempoMap,
    S.state.timings, marks(S.state.sectionMarkers),
    checkedLanes().map(lane => [lane.id, lane.rocksmithArrangement, lane.tuning, lane.customTuning, lane.capo,
      lane.notes.length, marks(lane.toneMarkers), marks(lane.phraseBoundaries), lane.timing ?? null])]);
}

async function runCheck() {
  inFlight?.abort();
  const controller = inFlight = new AbortController();
  const lanes = checkedLanes();
  try {
    let found = [];
    if (lanes.length) {
      const spec = await buildSpecForLanesAsync(lanes, controller.signal);
      spec.duration = Number(S.state.duration) || 0;
      spec.tuning = S.state.tuning;
      spec.rocksmith = { arrangements: lanes.map((lane, track) => ({ track, kind: lane.rocksmithArrangement })),
        leadingSilence: rsLeadIn() };
      const res = await fetch('/api/rocksmith/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec), signal: controller.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
      found = await res.json();
    }
    if (controller !== inFlight) return;
    results = new Map(found.map(entry => [lanes[entry.track]?.id, entry]));
    draw();
  } catch (error) {
    if (controller.signal.aborted) return;
    // A check that cannot run says nothing rather than something stale.
    results = new Map(); draw();
    console.warn('Rocksmith check failed:', error);
  }
}

// Called on every paint pass: starts a check once the chart has stopped changing.
function scheduleCheck() {
  if (!S.state) return;
  const key = checkKey();
  if (key === lastKey) return;
  lastKey = key;
  clearTimeout(timer);
  timer = setTimeout(runCheck, SETTLE_MS);
}

// The issues of one layer that sit on its notes, with those notes: what the stage frames.
export function rocksmithIssueNotes(lane) {
  const found = results.get(lane.id);
  if (!found?.issues?.length) return [];
  const out = [];
  for (const issue of found.issues) {
    if (issue.time == null) continue;
    const notes = lane.notes.filter(note => Math.abs(note.start - issue.time) < SAME_ONSET);
    if (notes.length) out.push({ issue, notes });
  }
  return out;
}

// Every problem of the active layer: the export's (Rocksmith), the editor's own
// (note-issues.js) and its flags'.
function rowsFor(lane) {
  const found = results.get(lane?.id);
  const rows = [];
  if (found?.error) rows.push({ title: `Not exported: ${found.error}`, help: '', important: true, time: null });
  for (const text of found?.warnings || []) rows.push({ title: text, help: '', important: false, time: null });
  for (const issue of found?.issues || []) rows.push(issue);
  if (lane) for (const issue of laneIssues(lane, laneFretTuning(lane), laneFretCount(lane), S.voicingRevision))
    rows.push({ title: issue.title, help: issue.help, important: issue.tone === 'error', time: issue.time });
  for (const entry of markerArtifacts()) if (entry.issue)
    rows.push({ title: entry.issue.title, help: entry.issue.help, important: entry.issue.tone === 'error', time: entry.t });
  return rows.sort((a, b) => (a.time ?? -1) - (b.time ?? -1));
}

function moveTo(t) {
  stopArtifactPreview(); stopViewportMotion();
  seekPlayback(t);
  moveViewportTo(xOf(t) - scroll.clientWidth * .2, scroll.scrollTop);
  draw();
}

function issueRow(entry) {
  const row = document.createElement('li');
  row.className = 'artifact-row artifact-marker-row artifact-issue-row';
  row.toggleAttribute('data-important', !!entry.important);
  row.dataset.tip = entry.help ? `${entry.title}\n${entry.help}` : entry.title;
  row.dataset.tipTone = entry.important ? 'error' : 'warning';
  row.setAttribute('aria-description', `${entry.important ? 'Error' : 'Warning'}: ${row.dataset.tip}`);
  const mark = document.createElement('span'); mark.className = 'artifact-issue-mark'; mark.innerHTML = icon('warning', 14);
  const copy = document.createElement('div'); copy.className = 'artifact-copy';
  const name = document.createElement('span'); name.className = 'artifact-name'; name.textContent = entry.title;
  copy.append(name);
  row.append(mark, copy);
  if (entry.time != null) {
    const time = document.createElement('span'); time.className = 'artifact-detail artifact-time';
    time.textContent = clock(entry.time);
    const actions = document.createElement('div'); actions.className = 'artifact-marker-actions';
    const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'icon-btn icon-btn--compact';
    jump.innerHTML = icon('jump', 14); jump.title = 'Move to'; jump.setAttribute('aria-label', 'Move to');
    jump.addEventListener('click', () => moveTo(entry.time));
    actions.append(jump);
    row.append(time, actions);
    row.addEventListener('click', event => { if (!event.target.closest('button')) moveTo(entry.time); });
  }
  return row;
}

// The artifact pane's Errors and Warnings for the active layer; rebuilt only when they change.
export function renderRocksmithIssues() {
  scheduleCheck();
  if (!lists.size) return;
  const lane = S.state?.editLanes.find(item => item.active);
  const rows = S.state ? rowsFor(lane) : [];
  for (const [tone, section] of lists) {
    const mine = rows.filter(row => !!row.important === (tone === 'error'));
    const key = JSON.stringify([lane?.id, mine]);
    if (key === section.shown) continue;
    section.shown = key;
    section.list.replaceChildren(...mine.map(issueRow));
    section.count.textContent = String(mine.length);
    section.head.classList.toggle('is-empty', !mine.length); section.body.classList.toggle('is-empty', !mine.length);
  }
}

function issueSection(tone, label) {
  const head = document.createElement('div'); head.className = 'side-header';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'side-label';
  toggle.innerHTML = chevron;
  const title = document.createElement('span'); title.textContent = label;
  const count = document.createElement('span'); count.className = 'artifact-count'; count.setAttribute('aria-live', 'polite');
  toggle.append(title, count); head.append(toggle);
  const body = document.createElement('div'); body.className = 'artifact-panel-body'; body.id = `artifact${label}Body`;
  const list = document.createElement('ul'); list.className = 'artifact-list artifact-issue-list'; list.id = `artifact${label}`;
  list.dataset.tone = tone;
  body.append(list);
  const sync = () => {
    toggle.setAttribute('aria-controls', body.id); toggle.setAttribute('aria-expanded', String(!body.hidden));
    toggle.title = `${body.hidden ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`;
    toggle.setAttribute('aria-label', toggle.title);
  };
  toggle.addEventListener('click', () => { body.hidden = !body.hidden; sync(); }); sync();
  lists.set(tone, { list, count, head, body, shown: null });
  return [head, body];
}

export function initRocksmithIssues() {
  // First in the pane: what stops a clean export matters before what indexes the song.
  $('artifactsContent').querySelector('.artifact-sections').prepend(
    ...issueSection('error', 'Errors'), ...issueSection('warning', 'Warnings'));
  const reset = () => {
    inFlight?.abort(); clearTimeout(timer);
    results = new Map(); lastKey = null;
    for (const section of lists.values()) section.shown = null;
  };
  window.addEventListener('cw-project-opened', reset);
  window.addEventListener('cw-project-closed', () => { reset(); renderRocksmithIssues(); });
}
