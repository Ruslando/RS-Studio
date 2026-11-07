import { issueIgnored, showIgnoredIssues, setShowIgnoredIssues, openIssueMenu } from './issue-state.js';
import { issueInstanceKey } from './issue-identity.js';
// Live Rocksmith check: what the export would report, while the chart is edited.
//
// The server runs the export's own compile and its port of DLC Builder's
// checker (rocksmith/checker.py) on the spec the export would send, so the
// list here is the list DLC Builder shows for the finished package. A check
// starts once edits have settled; a newer one cancels the one in flight.
// Results are listed for the active layer in the artifact pane under Errors and
// Warnings, with the editor's own note problems (note-issues.js) and the flags'
// (design.md 10), and framed on the stage around the notes they concern.
import { issueTone, toneRank } from './issue-tone.js';
import { issueId } from './issue-identity.js';
import { $, scroll } from './dom.js';
import { S } from './store.js';
import { openDiagnosticMenu } from './edit.js';
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
import { shapeGroups } from './shapes.js';

const SETTLE_MS = 700;
const SAME_ONSET = 0.003;   // the check reports whole milliseconds of a float32 time
const KINDS = new Set(RS_KIND_OPTIONS.map(([kind]) => kind));
const chevron = '<svg class="side-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const clock = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;

let results = new Map();          // lane id -> { issues, warnings, error }
let lastKey = null, timer = 0, inFlight = null;
const expandedIssues = new Set();
const lists = new Map();         // 'error' | 'warning' | 'note' -> { list, count, head, body, shown }

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
      lane.notes.length, marks(lane.toneMarkers), (lane.phraseBoundaries || []).map(b => [b.t, b.name ?? null, !!b.solo]), marks(lane.crowdEvents?.map(e => ({ t: e.t, tone: e.code }))), lane.timing ?? null])]);
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
  window.dispatchEvent(new Event('cw-rocksmith-checked'));
}

// Called on every paint pass: starts a check once the chart has stopped changing.
// The latest check's answer; a new Map whenever one arrives.
export const checkResults = () => results;

export function scheduleCheck() {
  if (!S.state) return;
  const key = checkKey();
  if (key === lastKey) return;
  lastKey = key;
  clearTimeout(timer);
  timer = setTimeout(runCheck, SETTLE_MS);
}

// The silence the export will put in front, which it raises past the setting
// for an early first note; null until a check has measured it.
export function rocksmithLeadIn() {
  const lead = [...results.values()][0]?.leadIn;
  return Number.isFinite(lead) ? lead : null;
}

// What the export adds in front of a layer, in editor time: the COUNT phrase's
// start and the count-in events (B0 / B1 ticks). The active layer's when it has
// been checked, else the first checked one; null before any check.
export function rocksmithCountIn(lane) {
  const found = results.get(lane?.id) || [...results.values()][0];
  return found && Array.isArray(found.events) ? { count: found.count, events: found.events } : null;
}

// The events the export writes for one layer, in editor time: [{ t, code }].
export function rocksmithEvents(lane) {
  return results.get(lane?.id)?.events || [];
}

// The issues of one layer that sit on its notes, with those notes: what the stage frames.
export function rocksmithIssueNotes(lane) {
  const found = results.get(lane.id);
  if (!found?.issues?.length) return [];
  const out = [];
  for (const issue of rowsFor(lane).filter(row => row.code && (showIgnoredIssues || !issueIgnored(lane, row)))) {
    if (issue.time == null) continue;
    const notes = lane.notes.filter(note => Math.abs(note.start - issue.time) < SAME_ONSET);
    if (notes.length) out.push({ issue, notes });
  }
  return out;
}

// The export's problems with one layer's arpeggios and handshapes, per shape:
// shape id -> { plain, issues }. `plain` means the shape went out as ordinary
// notes. The export reports a broken shape at its first note and a hand change at
// the note inside it, so an issue belongs to the shape whose stretch holds it.
export function rocksmithShapeProblems(lane) {
  const out = new Map();
  const found = results.get(lane?.id);
  if (!found?.issues?.length) return out;
  const stretches = [...shapeGroups(lane.notes)].map(([id, notes]) => ({ id,
    t0: Math.min(...notes.map((n) => n.start)), t1: Math.max(...notes.map((n) => n.start)) }));
  for (const issue of rowsFor(lane).filter(row => row.code && (showIgnoredIssues || !issueIgnored(lane, row)))) {
    if (!String(issue.code).startsWith('shape-') || issue.time == null) continue;
    // A broken shape is reported at its own first note; nested shapes make that the
    // only safe match. A hand change lies anywhere inside its shape.
    const shape = issue.code === 'shape-hand'
      ? stretches.find((s) => issue.time > s.t0 - SAME_ONSET && issue.time < s.t1 + SAME_ONSET)
      : stretches.find((s) => Math.abs(issue.time - s.t0) < SAME_ONSET);
    if (!shape) continue;
    if (!out.has(shape.id)) out.set(shape.id, { plain: false, issues: [] });
    const entry = out.get(shape.id);
    entry.issues.push(issue);
    if (issue.code !== 'shape-hand') entry.plain = true;
  }
  return out;
}

// Every problem of a layer: the export's (Rocksmith), the editor's own
// (note-issues.js) and its flags'. `key` is the problem's kind, what the export
// window ignores: a stable ID independent of the message text.
export function rowsFor(lane) {
  const found = results.get(lane?.id);
  const rows = [];
  if (found?.error) rows.push({ id: found.errorId || 'export.compile-failed', key: found.errorId || 'export.compile-failed', title: `Not exported: ${found.error}`, help: '', tone: 'error', time: null });
  if (found?.warningIssues) for (const issue of found.warningIssues) rows.push({ ...issue, key: issue.id });
  else for (const text of found?.warnings || []) rows.push({ key: issueId(text), title: text, help: '', tone: 'warning', time: null });
  for (const issue of found?.issues || []) rows.push({ ...issue, tone: issueTone(issue), key: issue.id || issueId(issue.code) });
  if (lane) for (const issue of laneIssues(lane, laneFretTuning(lane), laneFretCount(lane), S.voicingRevision))
    rows.push({ ...issue, id: issue.id, key: issue.id, title: issue.title, help: issue.help, tone: issue.tone, time: issue.time, notes: issue.notes });
  for (const entry of markerArtifacts(lane)) if (entry.issue && entry.lane === lane)
    rows.push({ id: entry.issue.id, key: entry.issue.id, title: entry.issue.title, help: entry.issue.help, tone: entry.issue.tone, time: entry.t, target: entry.key });
  const slots = new Map();
  for (const row of rows) {
    row.laneId = lane?.id;
    if (!row.notes && !row.target && row.time != null) {
      row.notes = (lane?.notes || []).filter(n => Math.abs(n.start - row.time) < SAME_ONSET);
      if (!row.notes.length) {
        const markers = [...(lane?.toneMarkers || []), ...(lane?.phraseBoundaries || []), ...(lane?.crowdEvents || [])];
        const marker = markers.find(m => Math.abs(m.t - row.time) < SAME_ONSET);
        row.target = marker ? `marker:${marker.id}` : `time:${row.time}`;
      }
    }
    const base = issueInstanceKey(lane, row), slot = slots.get(base) || 0;
    slots.set(base, slot + 1); row.slot = slot || null;
  }
  return rows.sort((a, b) => (a.time ?? -1) - (b.time ?? -1));
}

// Every problem the pane lists for these layers, by kind: what the export
// window asks to fix or ignore before it exports. key -> { title, help, count, tone }.
export function rocksmithIssueKinds(lanes, includeIgnored = false) {
  const kinds = new Map();
  for (const lane of lanes) for (const row of rowsFor(lane)) {
    if (!includeIgnored && issueIgnored(lane, row)) continue;
    const seen = kinds.get(row.key) || { title: row.title, help: row.help || '', count: 0, tone: 'note' };
    seen.count += 1;
    if (toneRank[row.tone] > toneRank[seen.tone]) seen.tone = row.tone;
    kinds.set(row.key, seen);
  }
  return kinds;
}

function moveTo(t) {
  stopArtifactPreview(); stopViewportMotion();
  seekPlayback(t);
  moveViewportTo(xOf(t) - scroll.clientWidth * .2, scroll.scrollTop);
  draw();
}

function issueRow(entry) {
  const lane = S.state?.editLanes.find(l => l.id === entry.laneId);
  const row = document.createElement('li');
  row.className = 'artifact-row artifact-marker-row artifact-issue-row';
  row.toggleAttribute('data-important', entry.tone === 'error');
  row.dataset.tone = entry.tone;
  row.dataset.issueId = entry.key;
  row.toggleAttribute('data-ignored', issueIgnored(lane, entry));
  const menu = event => { event.preventDefault(); event.stopPropagation(); openIssueMenu(event.clientX, event.clientY, [{lane, issue: entry}]); };
  row.addEventListener('contextmenu', menu);
  const more = document.createElement('button'); more.type = 'button'; more.className = 'icon-btn icon-btn--compact';
  more.innerHTML = icon('more', 14); more.title = 'Options'; more.setAttribute('aria-label', 'Options'); more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', event => { event.stopPropagation(); const r = more.getBoundingClientRect(); openIssueMenu(r.left, r.bottom, [{lane, issue: entry}]); });
  row.dataset.tip = entry.help ? `${entry.title}\n${entry.help}` : entry.title;
  row.dataset.tipTone = entry.tone;
  row.setAttribute('aria-description', `${entry.tone[0].toUpperCase() + entry.tone.slice(1)}: ${row.dataset.tip}`);
  const mark = document.createElement('span'); mark.className = 'artifact-issue-mark'; mark.innerHTML = icon(entry.tone === 'note' ? 'info' : 'warning', 14);
  const copy = document.createElement('div'); copy.className = 'artifact-copy';
  const name = document.createElement('span'); name.className = 'artifact-name'; name.textContent = entry.title;
  copy.append(name);
  row.append(mark, copy);
  const actions = document.createElement('div'); actions.className = 'artifact-issue-actions';
  if (entry.time != null) {
    const time = document.createElement('span'); time.className = 'artifact-detail artifact-time';
    time.textContent = clock(entry.time);
    row.append(time);
    const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'icon-btn icon-btn--compact';
    jump.innerHTML = icon('jump', 14); jump.title = 'Jump to'; jump.setAttribute('aria-label', 'Jump to');
    jump.addEventListener('click', event => { event.stopPropagation(); moveTo(entry.time); });
    actions.append(jump);
    row.addEventListener('click', event => { if (!event.target.closest('button')) moveTo(entry.time); });
  }
  actions.append(more); row.append(actions);
  return row;
}

// The artifact pane's Errors and Warnings for the active layer; rebuilt only when they change.
export function renderRocksmithIssues() {
  scheduleCheck();
  if (!lists.size) return;
  const lane = S.state?.editLanes.find(item => item.active);
  const rows = S.state ? rowsFor(lane) : [];
  for (const [tone, section] of lists) {
    const all = rows.filter(row => row.tone === tone);
    const mine = all.filter(row => showIgnoredIssues || !issueIgnored(lane, row));
    const key = JSON.stringify([lane?.id, showIgnoredIssues, all.map(row => [issueInstanceKey(lane, row), row.title, row.help, row.time]), S.state?.metadata?.rocksmith]);
    if (key === section.shown) continue;
    section.shown = key;
    const groups = new Map();
    for (const entry of mine) {
      if (!groups.has(entry.key)) groups.set(entry.key, []);
      groups.get(entry.key).push(entry);
    }
    section.list.replaceChildren(...[...groups].map(([id, entries]) => {
      const item = document.createElement('li'); item.className = 'artifact-issue-group';
      const head = document.createElement('div'); head.className = 'artifact-row artifact-issue-group-head';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'artifact-row-head';
      const expandedKey = `${lane?.id}:${tone}:${id}`;
      toggle.setAttribute('aria-controls', `issue-instances-${lane?.id}-${tone}-${id}`);
      toggle.innerHTML = chevron;
      const title = document.createElement('span'); title.className = 'artifact-name'; title.textContent = entries[0].title;
      toggle.title = entries[0].title;
      const count = document.createElement('span'); count.className = 'artifact-count'; const activeCount = entries.filter(entry => !issueIgnored(lane, entry)).length;
      count.textContent = showIgnoredIssues && activeCount !== entries.length ? `${activeCount} (${entries.length - activeCount} ignored)` : String(activeCount);
      head.toggleAttribute('data-ignored', !activeCount);
      toggle.append(title, count);
      const children = document.createElement('ul'); children.className = 'artifact-list artifact-issue-instances';
      children.id = `issue-instances-${lane?.id}-${tone}-${id}`;
      const sync = () => { children.hidden = !expandedIssues.has(expandedKey); if (!children.hidden && !children.childElementCount) children.append(...entries.map(issueRow)); toggle.setAttribute('aria-expanded', String(!children.hidden)); };
      toggle.onclick = () => { if (expandedIssues.has(expandedKey)) expandedIssues.delete(expandedKey); else expandedIssues.add(expandedKey); sync(); };
      sync();
      const more = document.createElement('button'); more.type = 'button'; more.className = 'icon-btn icon-btn--compact'; more.innerHTML = icon('more', 14); more.title = 'Category options'; more.setAttribute('aria-label', 'Category options'); more.setAttribute('aria-haspopup', 'menu');
      const menu = (x, y) => openIssueMenu(x, y, [{lane, issue: entries[0]}], true);
      more.onclick = () => { const r = more.getBoundingClientRect(); menu(r.left, r.bottom); };
      head.oncontextmenu = event => { event.preventDefault(); menu(event.clientX, event.clientY); };
      const actions = document.createElement('div'); actions.className = 'artifact-issue-actions';
      actions.append(more); head.append(toggle, actions); item.append(head, children); return item;
    }));
    const active = all.filter(row => !issueIgnored(lane, row)).length;
    section.count.textContent = showIgnoredIssues && active !== all.length ? `${active} (${all.length - active} ignored)` : String(active);
    // Keep the header's menu reachable even when every occurrence is ignored.
    section.head.classList.toggle('is-empty', !all.length); section.body.classList.toggle('is-empty', !mine.length);
    section.options.toggleAttribute('data-show-ignored', showIgnoredIssues);
    section.options.title = showIgnoredIssues ? 'Issue options (showing ignored)' : 'Issue options';
  }
}

function issueSection(tone, label) {
  const head = document.createElement('div'); head.className = 'side-header artifact-issue-section-head';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'side-label';
  toggle.innerHTML = chevron;
  const title = document.createElement('span'); title.textContent = label;
  const count = document.createElement('span'); count.className = 'artifact-count'; count.setAttribute('aria-live', 'polite');
  toggle.append(title, count);
  const options = document.createElement('button'); options.type = 'button';
  options.className = 'icon-btn icon-btn--compact artifact-issue-options'; options.innerHTML = icon('more', 14);
  options.setAttribute('aria-label', `${label} options`); options.setAttribute('aria-haspopup', 'menu');
  options.onclick = () => {
    const rect = options.getBoundingClientRect();
    openDiagnosticMenu(rect.left, rect.bottom, [{
      label: `${showIgnoredIssues ? '\u2713 ' : ''}Show ignored`,
      fn: () => setShowIgnoredIssues(!showIgnoredIssues),
    }]);
  };
  head.append(toggle, options);
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
  lists.set(tone, { list, count, head, body, options, shown: null });
  return [head, body];
}

export function initRocksmithIssues() {
  // First in the pane: what stops a clean export matters before what indexes the song.
  $('artifactsContent').querySelector('.artifact-sections').prepend(
    ...issueSection('error', 'Errors'), ...issueSection('warning', 'Warnings'), ...issueSection('note', 'Notes'));
  const reset = () => {
    inFlight?.abort(); clearTimeout(timer);
    results = new Map(); lastKey = null; expandedIssues.clear();
    for (const section of lists.values()) section.shown = null;
  };
  window.addEventListener('cw-project-opened', reset);
  window.addEventListener('cw-project-closed', () => { reset(); renderRocksmithIssues(); });
}
