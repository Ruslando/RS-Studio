// Persistent, named repeat groups for the current layer. Scanning only annotates;
// applying positions is a separate, explicit edit.
import { compareCopy, copyOrigin, groupsFromRepeats, resolveRepeatGroups } from './repeats-core.js';
import { commit, commitStructure, snapshotEdit } from "./edit-history.js";
import { scroll, sctx } from './dom.js';
import { xOf, yOf } from './geometry.js';
import { activeLane, canEditLane, refreshCounts } from './lanes.js';
import { toast } from './notify.js';
import { boxOfNote, noteBounds } from "./references.js";
import { laneClock } from "./reference-clock.js";
import { draw } from './repaint.js';
import { PAINT, halo } from './stage-paint.js';
import { S } from './store.js';
import { laneFingering } from "./lane-fingering.js";
import { refreshTabIfOpen } from "./tablature.js";
import { stageUi } from './constants.js';
import { manualViewportNavigation, moveViewportTo } from './viewport-motion.js';
import { registerEscapeLayer, ESC_DEPTH } from './escape-stack.js';
import { clearMatches } from './tracing.js';
let actions;
import { applyNoteCounterpart, applyPresenceCounterpart, curveGraph, instanceChangeRows, noteChangeRows } from './repeat-change-details.js';
import { hideTooltip } from './tooltip.js';
import { noteRibbon } from './note-render.js';
import { paintNoteGlow } from './canvas-components.js';
import { modalOpen } from './modal-focus.js';
import { nid } from './ids.js';
import { renderRepeatPicker } from './repeat-picker.js';
import { playbackTime, seekPlayback, setPlaybackZone, transportPlaying } from './playback.js';
import { initRepeatDock } from './repeat-dock.js';

const $ = id => document.getElementById(id);
let worker = null, scanLane = null, scanProject = null, scanSignature = null;
let hover = null;
let stopCache = null;
let groupsCache = null;
let handSeats = null;
let review = null, navKey = null, optionsKey = null, handRequest = null, handResult = null;
// Use the same generated fingers as the fretboard, without selecting notes.
// Results belong to one project/layer/revision and are discarded after edits.
function displayedFingers(lane) {
  const key = [S.state, lane, lane.notes, S.voicingRevision, S.fingerRevision];
  if (handRequest && key.every((v, i) => v === handRequest.key[i])) return handResult;
  const request = { key }; handRequest = request; handResult = null; handSeats = null;
  laneFingering(lane).then(found => {
    if (handRequest !== request || !review || key[0] !== S.state || lane.notes !== key[2]
      || S.voicingRevision !== key[3] || S.fingerRevision !== key[4]) return;
    handResult = new Map([...found.fingers].map(([note, finger]) => [note.id, finger]));
    handSeats = new Map([...(found.seats || [])].map(([note, seat]) => [note.id, seat]));
    navKey = null; draw();
  }).catch(() => {}); // Authored finger values remain available if voicing fails.
  return null;
}
const signature = lane => {
  const beatAt = laneClock(lane).beatAt;
  return JSON.stringify(lane.notes.map(n => [n.id, n.start, n.end, beatAt(n.start), n.pitch, n.gripOnly]));
};
const groupsOf = lane => {
  const key = [S.state, lane, lane.notes, lane.repeatGroups, S.voicingRevision];
  if (!groupsCache || key.some((v, i) => v !== groupsCache.key[i]))
    // A passage with one instance has nothing to compare: it is kept, not shown.
    groupsCache = { key, groups: resolveRepeatGroups(lane, laneClock(lane).beatAt).filter(group => group.copies.length > 1) };
  return groupsCache.groups;
};
function current() {
  const lane = S.state ? activeLane() : null;
  if (!review || !lane || review.lane !== lane.id) return null;
  const groups = groupsOf(lane);
  const parent = groups.find(g => g.id === review.group) || groups[0];
  if (!parent) return null;
  review.group = parent.id;
  // One list of every instance in the group; variations are not shown for now.
  const group = { ...parent, copies: parent.copies };
  const navigationCopies = group.copies;
  const navigationIndex = Math.max(0, group.copies.findIndex(c => review.copyKey ? c.ids[0] === review.copyKey : c.notes[0].note.id === review.first));
  const copy = navigationCopies[navigationIndex];
  // Beside the split view's other pane, this instance is compared with the one
  // shown there alone; on its own, with every instance of the group.
  const partner = review.other && partnerCopy(parent, copy);
  group.copies = partner ? parent.copies.filter(c => c === copy || c === partner) : navigationCopies;
  const index = group.copies.indexOf(copy);
  review.first = copy.notes[0].note.id; review.copyKey = copy.ids[0];
  return { lane, groups, parent, group, copy, index, navigationCopies, navigationIndex, model: group.copies[0] };
}
// The other pane's instance: the one it chose, while it is in this group and
// not this pane's, or else the next one after this pane's.
function partnerCopy(parent, copy) {
  // A single instance has no partner; both panes show it. Choosing "another"
  // would pick itself and queue a reveal that repeats this forever.
  if (parent.copies.length < 2) return null;
  const other = review.other;
  if (other.copyKey === copy.ids[0] || !parent.copies.some(c => c.ids[0] === other.copyKey)) {
    const next = parent.copies[(parent.copies.indexOf(copy) + 1) % parent.copies.length];
    Object.assign(other, { copyKey: next.ids[0], first: next.notes[0].note.id,
      changeKey: null, changeAnchor: null, playheadMarker: null, manualSeekTime: null });
    queueMicrotask(revealOther);   // it now shows another instance
  }
  return parent.copies.find(c => c.ids[0] === other.copyKey);
}

// ---- the split view's other pane (split-view.js connects itself) ----
// Each pane has its own instance. The live pane's is review's
// own; the other pane's wait in review.other and change places on a swap.
let splitHost = null;
export function connectRepeatSplit(host) { splitHost = host; }
const PANE = ['copyKey', 'first', 'changeKey', 'changeAnchor', 'playheadMarker', 'manualSeekTime'];
// Keep identities and navigation choices, never note objects or render caches.
export function savedRepeatReview() {
  if (!review || worker) return null;
  const pane = value => Object.fromEntries(['copyKey', 'first', 'changeKey', 'changeAnchor', 'manualSeekTime']
    .filter(key => value[key] != null).map(key => [key, structuredClone(value[key])]));
  return { lane: review.lane, group: review.group, ...pane(review),
    ...(review.other ? { other: pane(review.other) } : {}) };
}
export function restoreRepeatReview(saved) {
  closeRepeats(); optionsKey = null;
  const lane = S.state?.editLanes.find(lane => lane.id === saved?.lane);
  if (!lane || !groupsOf(lane).some(group => group.id === saved.group)) return;
  review = structuredClone(saved);
  if (splitHost?.isOpen()) {
    pairRepeats(true); splitHost.reviewing(true);
  } else delete review.other;
  actions.setFretboardVisible(true);
  renderRepeatNavigator(); draw();
}
function swapPane() {
  const theirs = review.other;
  review.other = Object.fromEntries(PANE.map(key => [key, review[key]]));
  for (const key of PANE) review[key] = theirs[key];
}
export function swapRepeatPane() {
  if (!review?.other) return;
  hideRepeatHover(); swapPane(); navKey = null; stopCache = null;
}
// The pane's own playhead is back on the transport: that is where the pane left
// it, not a seek to follow into another instance.
export function holdRepeatPlayhead() { if (review?.other) review.manualSeekTime = playbackTime(); }
export function withRepeatPane(fn) {
  if (!review?.other) return fn();
  swapPane();
  try { return fn(); } finally { swapPane(); }
}
// The split view opened or closed under a running review.
// Paired, the playhead stays inside the instance its pane shows.
// The comparison lives in the split view: leaving it ends the review.
export function pairRepeats(on) {
  if (!on) { closeRepeats(); return; }
  if (!review) return;
  if (!review.other) { review.other = {}; current(); }
  setPlaybackZone(review.other ? instanceZone : null);
  navKey = null; stopCache = null; draw();
}
function instanceZone() {
  const state = current();
  if (!state) return null;
  const { t0, t1 } = repeatCopyBounds(state, state.copy);
  return { t0, t1 };
}
// `linked`: only a linked pane follows, to the start of its own instance.
function revealOther({ linked = false } = {}) {
  if (!review?.other || !splitHost?.isOpen()) return;
  const target = withRepeatPane(() => {
    const state = current();
    if (!state) return null;
    const b = repeatCopyBounds(state, state.copy);
    return { t0: b.t0, pitch: (b.pLo + b.pHi) / 2 };
  });
  if (target) splitHost.reveal(target, { linked });
}
// Each pane's instance, as the range its playhead may move in.
export function repeatZones() {
  return review?.other ? { live: instanceZone(), other: withRepeatPane(instanceZone) } : null;
}
const originalIndex = (state, copy) => state.parent.copies.findIndex(c => c.ids[0] === copy.ids[0]) + 1;
function repeatCopyBounds(state, copy) {
  const clock = laneClock(state.lane), origin = copyOrigin(copy, clock.beatAt);
  const projected = state.group.copies.flatMap(other => other.notes.map(({ note, beat }) => ({
    pitch: note.pitch, start: clock.timeAt(origin + beat),
    end: clock.timeAt(origin + beat + clock.beatAt(note.end) - clock.beatAt(note.start)),
  })));
  // Interior missing notes still belong to the passage. Include their pitch
  // and sustain in its frame, even when no present note reaches that row.
  const bounds = noteBounds([...copy.notes.map(entry => entry.note), ...projected]);
  return copy.phraseLength > 0 ? { ...bounds, t0: Math.min(clock.timeAt(origin), copy.notes[0].note.start),
    t1: clock.timeAt(origin + copy.phraseLength) } : bounds;
}
function seekRepeatPosition(time) {
  seekPlayback(time);
  // Media clocks can round a seek to just before the requested note or phrase.
  // Keep the explicit destination until the transport actually moves again.
  review.manualSeekTime = playbackTime();
}
function revealCurrent({ seek = true } = {}) {
  hideRepeatHover();
  if (review) { review.changeKey = null; review.changeAnchor = null; }
  const state = current();
  if (!state) { draw(); return; }
  const b = repeatCopyBounds(state, state.copy);
  if (seek) { review.playheadMarker = null; seekRepeatPosition(b.t0); revealOther({ linked: true }); }
  syncRepeatPlayhead();
  moveViewportTo(xOf(b.t0) - scroll.clientWidth * 0.2, yOf((b.pLo + b.pHi) / 2) - scroll.clientHeight / 2);
  draw();
}
// The other pane's instance can't be chosen here as well.
const shownElsewhere = copy => review?.other?.copyKey === copy.ids[0];
const choosableCopies = state => state.navigationCopies.filter(c => c === state.copy || !shownElsewhere(c));
function stepCopy(delta) {
  const state = current();
  if (!state) return;
  const copies = choosableCopies(state);
  const next = copies[(copies.indexOf(state.copy) + delta + copies.length) % copies.length];
  review.first = next.notes[0].note.id;
  review.copyKey = next.ids[0];
  revealCurrent();
}
function closeRepeats() {
  if (!review && !worker) return false;
  hideRepeatHover(); closeRepeatPickers();
  worker?.terminate(); worker = null; scanLane = null; scanProject = null;
  review = null; navKey = null; handRequest = null; handResult = null; handSeats = null; stopCache = null; groupsCache = null;
  setPlaybackZone(null); splitHost?.reviewing(false);
  renderRepeatNavigator(); draw();
  return true;
}
function editGroups(lane, change) {
  if (!canEditLane(lane)) return;
  const prev = snapshotEdit();
  change();
  // Annotation only: do not snap imported notes or mirror reference contents.
  commitStructure(prev, { preserveTiming: true });
}
export function runFindRepeats(lane = activeLane()) {
  if (!S.state || !lane) return;
  if (!canEditLane(lane)) { toast(`Layer “${lane.name}” is ${lane.locked ? 'locked' : 'hidden'}`); return; }
  hideRepeatHover();
  worker?.terminate();
  setPlaybackZone(null);   // the last review's instance no longer holds the playhead
  scanLane = lane; scanProject = S.state; scanSignature = signature(lane);
  const beatAt = laneClock(lane).beatAt;
  clearMatches();
  review = { lane: lane.id, group: lane.repeatGroups?.[0]?.id };
  navKey = null;
  actions.setFretboardVisible(true);
  worker = new Worker(new URL('./repeats-worker.js', import.meta.url), { type: 'module' });
  const pending = worker;
  worker.onmessage = ({ data }) => {
    if (worker !== pending) return;
    pending.terminate(); worker = null;
    const project = scanProject;
    scanLane = null; scanProject = null;
    if (S.state !== project || !S.state.editLanes.includes(lane) || !canEditLane(lane) || signature(lane) !== scanSignature) {
      toast('The layer changed during the scan. Find repeats again.'); draw(); return;
    }
    const byId = new Map(lane.notes.map(n => [n.id, n]));
    const repeats = data.map(r => ({ ...(r.phraseLength > 0 ? { phraseLength: r.phraseLength } : {}),
      copies: r.copies.map((ids, index) => {
        const origin = beatAt(byId.get(ids[0]).start) - (r.offsets?.[index] || 0);
        return { notes: ids.map(id => ({ note: byId.get(id), beat: beatAt(byId.get(id).start) - origin })) };
      }) }));
    const groups = groupsFromRepeats(repeats, lane.repeatGroups, beatAt);
    if (JSON.stringify(groups) !== JSON.stringify(lane.repeatGroups || [])) editGroups(lane, () => { lane.repeatGroups = groups; });
    const shown = groups.filter(group => group.copies.length > 1);
    review = shown.length ? { lane: lane.id, group: shown[0].id } : null;
    navKey = null;
    toast(`${shown.length} repeat group${shown.length === 1 ? '' : 's'} in “${lane.name}”`);
    revealCurrent();
    if (review) splitHost?.open(lane.id);   // the comparison opens split: one instance in each pane
  };
  worker.onerror = () => {
    if (worker !== pending) return;
    pending.terminate(); worker = null; scanLane = null; scanProject = null;
    toast('Could not scan repeats. Try again.', 3000, 'error'); draw();
  };
  worker.postMessage(lane.notes.map(n => ({ id: n.id, start: beatAt(n.start), end: beatAt(n.end), pitch: n.pitch, gripOnly: n.gripOnly })));
  draw();
}

const navigatorCaches = new WeakMap();
export function renderRepeatNavigator(elements = null) {
  const $ = id => elements ? elements[id] : document.getElementById(id);
  const nav = $('repeatNavigator');
  if (!nav) return;
  if (!elements) syncRepeatPlayhead();
  const lane = S.state ? activeLane() : null, state = current(), scanning = !!worker && scanLane === lane;
  nav.hidden = !scanning && !state;
  if (nav.hidden) { if (!elements) hideRepeatHover(); return; }
  if (!elements && hover && (hover.lane !== lane || hover.group !== state?.group.id || hover.instance !== state?.copy.ids[0]
    || hover.revision !== S.voicingRevision || S.drag)) hideRepeatHover();
  const key = [S.state, lane, lane?.notes, lane?.repeatGroups, S.voicingRevision,
    review?.group, review?.other?.copyKey, review?.first, review?.changeKey, scanning, !!lane?.locked, !!lane?.visible, S.fingerRevision, handResult];
  const cache = elements ? navigatorCaches.get(elements) || {} : null;
  const previousKey = elements ? cache.key : navKey;
  if (previousKey && key.every((v, i) => v === previousKey[i])) return;
  if (elements) { cache.key = key; navigatorCaches.set(elements, cache); }
  else navKey = key;
  const groups = state?.groups || [];
  const optionSig = JSON.stringify(groups.map(g => [g.id, g.name, g.copies.length]));
  const select = $('repeatGroup');
  if ((elements ? cache.options : optionsKey) !== optionSig) {
    if (elements) cache.options = optionSig;
    else optionsKey = optionSig;
    select.replaceChildren();
    for (const group of groups) {
      const option = document.createElement('option');
      option.value = group.id; option.textContent = group.name;
      select.append(option);
    }
  }
  select.value = state?.group.id || '';
  select.disabled = scanning || !state;
  nav.setAttribute('aria-busy', String(scanning));
  const instanceChoices = (state?.navigationCopies || []).map(copy => ({ value: copy.ids[0],
    label: `Instance ${originalIndex(state, copy)}`, disabled: copy !== state.copy && shownElsewhere(copy) }));
  renderRepeatPicker($('repeatInstance'), instanceChoices, state?.copy.ids[0], { disabled: scanning || !state });
  $('repeatPosition').textContent = state ? `${state.navigationIndex + 1} / ${state.navigationCopies.length}` +
    (state.parent.copies.length !== state.navigationCopies.length ? ` · #${originalIndex(state, state.copy)}` : '') : 'Scanning…';
  $('repeatPrevious').disabled = $('repeatNext').disabled = scanning || !state || choosableCopies(state).length < 2;
  $('repeatGroupPrevious').disabled = $('repeatGroupNext').disabled = scanning || groups.length < 2;
  const stops = state ? changeStops(state) : [];
  const changeIndex = stops.findIndex(stop => stop.key === review?.changeKey);
  $('repeatChangeNavigation').hidden = scanning || !stops.length;
  const changes = $('repeatChangePosition'); changes.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = `– / ${stops.length}`; placeholder.disabled = true; changes.append(placeholder);
  for (const [index, stop] of stops.entries()) {
    const option = document.createElement('option'); option.value = stop.key;
    option.textContent = `${index + 1} / ${stops.length}`; changes.append(option);
  }
  changes.value = changeIndex < 0 ? '' : stops[changeIndex].key;
  changes.disabled = scanning || !stops.length;
  $('repeatChangePrevious').disabled = $('repeatChangeNext').disabled = scanning || !state || !stops.length;
  if (!elements && hover && state) fillHoverRows(state);

}

function comparisonDetails(state) {
  const clock = laneClock(state.lane), fingers = displayedFingers(state.lane);
  const markers = [], byNote = new Map(), ghosts = new Map();
  const targets = state.copy.notes.map(({ note }) => {
    const marker = { note, current: note, first: note, anchor: note, anchorCopy: state.copy };
    byNote.set(note, marker); return marker;
  });
  const changed = note => {
    const marker = byNote.get(note);
    if (!marker) return;
    if (!marker.kind) markers.push(marker);
    marker.kind = 'changed';
  };
  const origin = copyOrigin(state.copy, clock.beatAt);
  for (const other of state.group.copies) {
    if (other === state.copy) continue;
    const comparison = compareCopy(state.copy, other, clock.beatAt, fingers);
    for (const change of comparison.changes) {
      const firstOrigin = copyOrigin(state.copy, clock.beatAt), otherOrigin = copyOrigin(other, clock.beatAt);
      const rows = noteChangeRows(change.from, change.to, { beatAt: clock.beatAt, fingers,
        firstBeat: clock.beatAt(change.from.start) - firstOrigin, currentBeat: clock.beatAt(change.to.start) - otherOrigin });
      if (rows.some(row => row.key !== 'whammy' && (row.before !== row.after || row.curves))) changed(change.from);
    }
    for (const [a] of comparison.positionDifferences) changed(a);
    for (const [a] of comparison.fingerDifferences) changed(a);
    for (const { note } of comparison.missing) changed(note);
    for (const { note, beat } of comparison.added) {
      if (state.copy.phraseLength > 0 && (beat < -.06 || beat >= state.copy.phraseLength - .06)) continue;
      const key = `${Math.round(beat * 10000)}:${note.pitch}`;
      if (ghosts.has(key)) continue;
      const start = clock.timeAt(origin + beat);
      const end = clock.timeAt(origin + beat + clock.beatAt(note.end) - clock.beatAt(note.start));
      const marker = { kind: 'missing', first: note, current: null, anchor: note, anchorCopy: other,
        note: { pitch: note.pitch, start, end } };
      ghosts.set(key, marker); markers.push(marker); targets.push(marker);
    }
  }
  return { markers: markers.sort((a, b) => a.note.start - b.note.start), targets };
}
const markerKey = (copy, marker) => `${copy.ids[0]}:${marker.anchor?.id || ''}`;
function stepGroup(delta) {
  const state = current();
  if (!state) return;
  const index = (state.groups.findIndex(group => group.id === state.group.id) + delta + state.groups.length) % state.groups.length;
  review.group = state.groups[index].id; review.first = null; review.copyKey = null;
  revealCurrent();
}
function selectInstance(value) {
  const state = current();
  if (!state || !choosableCopies(state).some(copy => copy.ids[0] === value)) return;
  review.copyKey = value; revealCurrent();
}
function changeStops(state) {
  const key = [S.state, state.lane, state.lane.notes, state.lane.repeatGroups, state.group.id, state.copy.ids[0], state.group.copies.map(c => c.ids[0]).join(), S.voicingRevision, S.fingerRevision, handResult];
  if (stopCache && key.every((value, i) => value === stopCache.key[i])) return stopCache.stops;
  const stops = comparisonDetails(state).markers.map(marker =>
    ({ key: markerKey(state.copy, marker), copy: state.copy, marker }));
  stops.sort((a, b) => a.marker.note.start - b.marker.note.start || a.marker.note.pitch - b.marker.note.pitch);
  stopCache = { key, stops };
  return stops;
}
function stepChange(delta) {
  const state = current();
  if (!state) return;
  const stops = changeStops(state);
  if (!stops.length) return;
  let index = stops.findIndex(stop => stop.key === review.changeKey);
  if (index >= 0) index = (index + delta + stops.length) % stops.length;
  else {
    const anchor = hover?.marker.note || review.changeAnchor;
    const time = anchor?.start ?? (delta > 0 ? state.copy.notes[0].note.start : noteBounds(state.copy.notes.map(n => n.note)).t1);
    const pitch = anchor?.pitch ?? (delta > 0 ? -Infinity : Infinity);
    const after = stop => stop.marker.note.start > time || (stop.marker.note.start === time && stop.marker.note.pitch > pitch);
    const before = stop => stop.marker.note.start < time || (stop.marker.note.start === time && stop.marker.note.pitch < pitch);
    index = delta > 0 ? stops.findIndex(after) : stops.findLastIndex(before);
    if (index < 0) index = delta > 0 ? 0 : stops.length - 1;
  }
  const stop = stops[index];
  review.first = stop.copy.notes[0].note.id; review.copyKey = stop.copy.ids[0];
  focusRepeatMarker(current(), stop.marker);
}
function focusRepeatMarker(state, marker) {
  if (!state || !marker) return;
  hideRepeatHover();
  // A changed-note jump is immediate: its popup and fretboard should arrive
  // together, rather than anchoring a popup halfway through a scroll tween.
  manualViewportNavigation();
  const clamp = (n, max) => Math.max(0, Math.min(Math.max(0, max), n));
  scroll.scrollLeft = clamp(xOf(marker.note.start) - scroll.clientWidth * .2, scroll.scrollWidth - scroll.clientWidth);
  scroll.scrollTop = clamp(yOf(marker.note.pitch) - scroll.clientHeight / 2, scroll.scrollHeight - scroll.clientHeight);
  review.changeKey = markerKey(state.copy, marker); review.playheadMarker = null;
  seekRepeatPosition(marker.note.start);
  syncRepeatPlayhead();
  draw();
}
export function handleRepeatNavigationKey(event) {
  if (!review || worker || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || S.drag
    || !['ArrowLeft', 'ArrowRight'].includes(event.key) || !current()
    || $('repeatNavigator').hidden || $('repeatNavigator').closest?.('[hidden], [inert]')
    || modalOpen('[aria-modal="true"]:not([data-editor-keys])')) return false;
  const target = event.target;
  if (target === $('repeatDrag') || target?.closest?.('.repeat-picker')) return false;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(target?.tagName) || target?.isContentEditable
    || target?.closest?.('[contenteditable="true"], [role="listbox"], [role="menu"]')) return false;
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  if (event.shiftKey) stepGroup(delta);
  else if (event.altKey) stepCopy(delta);
  else return false; // Plain arrows retain the editor's individual-note navigation.
  event.preventDefault(); event.stopImmediatePropagation();
  return true;
}
function curveCell(cell, points, label, low, high) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 96 28'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
  svg.classList.add('repeat-curve');
  const graph = curveGraph(points, low, high);
  for (const [path, className] of [[`M3,${graph.baseline} L93,${graph.baseline}`, 'repeat-curve-zero'], [graph.path, 'repeat-curve-shape']]) {
    const shape = document.createElementNS(ns, 'path'); shape.setAttribute('d', path); shape.setAttribute('class', className); svg.append(shape);
  }
  for (const [time, value] of points) {
    const point = document.createElementNS(ns, 'circle');
    point.setAttribute('cx', String(3 + time * 90));
    point.setAttribute('cy', String(25 - (value - low) / Math.max(1, high - low) * 22));
    point.setAttribute('r', '2'); point.setAttribute('class', 'repeat-curve-point'); svg.append(point);
  }
  cell.append(svg);
}
function handAnchorAt(lane, note) {
  if (!note) return null;
  if (handSeats?.has(note.id)) return handSeats.get(note.id) || null;
  const previous = Math.max(-Infinity, ...lane.notes.filter(n => n.start < note.start - 1e-6).map(n => n.start));
  return lane.handHolds?.find(h => h.t > previous + 1e-6 && h.t <= note.start + 1e-6)?.fret ?? null;
}
function hoverInstances(state) {
  const beatAt = laneClock(state.lane).beatAt;
  const anchorCopy = state.group.copies.find(copy => copy.ids[0] === hover.anchorKey);
  return state.group.copies.map(copy => {
    const note = anchorCopy ? counterpart(state, anchorCopy, hover.marker.anchor, copy) : null;
    return { note, handAnchor: handAnchorAt(state.lane, note), onset: note ? beatAt(note.start) - copyOrigin(copy, beatAt) : null,
      slideCurve: note ? noteRibbon(state.lane, note)?.points || [] : [] };
  });
}
// Copy one difference from one instance's note onto the other's.
function copyValue(key, source, target) {
  const state = current();
  if (!hover || !state || !canEditLane(state.lane)) return;
  const clock = laneClock(state.lane), instances = hoverInstances(state);
  const targetNote = instances[target].note, sourceNote = instances[source].note;
  if (targetNote && boxOfNote(targetNote)?.group.locked) return;
  const targetCopy = state.group.copies[target], sourceCopy = state.group.copies[source];
  const options = { ...clock, fingers: displayedFingers(state.lane), mintId: nid, targetIds: targetCopy.ids,
    sourceOrigin: copyOrigin(sourceCopy, clock.beatAt), targetOrigin: copyOrigin(targetCopy, clock.beatAt) };
  const prev = snapshotEdit(), anchorId = hover.marker.anchor?.id, currentId = hover.marker.current?.id;
  let result = null, changed = false, alreadyCommitted = false;
  if (key === 'handAnchor' && targetNote) {
    const revision = S.voicingRevision;
    actions.setHandAnchor(state.lane, targetNote.start, instances[source].handAnchor || null);
    changed = S.voicingRevision !== revision; alreadyCommitted = true;
  } else if (key === 'presence') {
    result = applyPresenceCounterpart(state.lane, sourceNote, targetNote, options); changed = result.changed;
    if (result.note && !targetNote && boxOfNote(result.note)?.group.locked) {
      state.lane.notes = state.lane.notes.filter(note => note !== result.note);
      const i = targetCopy.ids.indexOf(result.note.id); if (i >= 0) targetCopy.ids.splice(i, 1);
      return;
    }
  } else changed = applyNoteCounterpart(key, sourceNote, targetNote, options);
  if (!changed) return;
  if (!alreadyCommitted && commit(prev, undefined, null, { preserveTiming: true }) === false) { hideRepeatHover(); return; }
  if (key === 'presence' && !sourceNote && targetNote) S.selection.delete(targetNote);
  const byId = new Map(state.lane.notes.map(note => [note.id, note]));
  const updated = result ? result.note : byId.get(targetNote?.id);
  hover.marker.current = target === hover.index ? updated || null : byId.get(currentId) || null;
  hover.marker.anchor = byId.get(anchorId) || sourceNote && byId.get(sourceNote.id) || updated || null;
  if (!hover.marker.anchor) { hideRepeatHover(); navKey = null; draw(); return; }
  if (!byId.has(anchorId) && sourceNote) hover.anchorKey = sourceCopy.ids[0];
  if (hover.marker.current) hover.marker.note = hover.marker.current;
  hover.revision = S.voicingRevision;
  handRequest = null; handResult = null; handSeats = null; stopCache = null; navKey = null;
  refreshCounts(); refreshTabIfOpen();
  const next = current();
  if (!next) { hideRepeatHover(); draw(); return; }
  fillHoverRows(next); updateHoverPreview(); renderRepeatNavigator();
}
const differences = (state, instances, a, b) => instanceChangeRows(instances[a], instances[b],
  { beatAt: laneClock(state.lane).beatAt, fingers: displayedFingers(state.lane) });
// The note beside the one it is compared with, only where they differ: beside
// the split view, the other pane's instance, in the column on its side; alone,
// the next instance whose note differs.
function fillHoverRows(state) {
  const instances = hoverInstances(state), here = hover.index, count = state.group.copies.length;
  const paired = !!review.other && count === 2;
  let there = paired ? 1 - here : null, rows = [];
  for (let step = 1; step < count && !rows.length; step++) {
    if (!paired) there = (here + step) % count;
    rows = differences(state, instances, here, there);
  }
  const flip = paired && splitHost?.liveSide?.() === 1;   // this pane is on the right
  const names = [here, there].map(index => index == null ? '' : `Instance ${originalIndex(state, state.group.copies[index])}`);
  const columns = flip ? [1, 0] : [0, 1];   // left and right column, as indexes into [this, compared]
  // The left column leans right and the right one left, toward the arrows between them.
  const sideClass = (column, mine) => `${column ? 'repeat-right' : 'repeat-left'}${mine ? ' repeat-here' : ''}`;
  const th = (text, className = '') => {
    const cell = document.createElement('th'); cell.textContent = text; cell.setAttribute('scope', 'col');
    cell.className = className;
    return cell;
  };
  $('repeatHoverHead').replaceChildren(th(''), th(names[columns[0]], sideClass(0, columns[0] === 0)), th(''),
    th(names[columns[1]], sideClass(1, columns[1] === 0)));
  const body = $('repeatHoverRows'); body.replaceChildren();
  for (const row of rows) {
    const values = [{ text: row.before, curve: row.curves?.before, index: here }, { text: row.after, curve: row.curves?.after, index: there }];
    const [left, right] = columns.map(side => values[side]);
    const range = [Math.min(0, ...[left, right].flatMap(v => (v.curve || []).map(([, y]) => y))),
      Math.max(0, ...[left, right].flatMap(v => (v.curve || []).map(([, y]) => y)))];
    const tr = document.createElement('tr'), heading = document.createElement('th');
    heading.textContent = row.label; heading.setAttribute('scope', 'row'); tr.append(heading);
    const shown = value => {
      const holder = document.createElement('span');
      if (value.curve?.length) curveCell(holder, value.curve, row.label, range[0], range[1]);
      else holder.textContent = value.curve ? 'None' : value.text;
      return holder;
    };
    // Each cell holds its value and, hidden, what a copy into it would make of
    // it: the old value, an arrow, the new one. Both take the same space, so
    // previewing never moves the card.
    const cells = [left, right].map((value, column) => {
      const cell = document.createElement('td'); cell.className = sideClass(column, value.index === here);
      const layers = document.createElement('div'); layers.className = 'repeat-value';
      const now = document.createElement('div'); now.className = 'repeat-now'; now.append(shown(value));
      layers.append(now); cell.append(layers);
      return { cell, layers, value };
    });
    cells.forEach((target, column) => {
      const change = document.createElement('div'); change.className = 'repeat-change';
      const arrow = document.createElement('span'); arrow.className = 'repeat-arrow'; arrow.textContent = '→';
      const old = shown(target.value); old.className = 'repeat-old';
      change.append(old, arrow, shown(cells[1 - column].value)); target.layers.append(change);
    });
    const buttons = document.createElement('td'); buttons.className = 'repeat-row-actions';
    for (const [from, to, symbol] of [[0, 1, '→'], [1, 0, '←']]) {
      const source = cells[from], target = cells[to];
      const button = document.createElement('button'); button.type = 'button'; button.className = 'repeat-copy-direction';
      button.textContent = symbol; button.dataset.change = row.key; button.dataset.target = String(target.value.index);
      const into = instances[target.value.index].note;
      button.setAttribute('aria-label', `Copy ${row.label.toLowerCase()} to ${names[columns[to]].toLowerCase()}`);
      button.disabled = !canEditLane(state.lane) || (!into && row.key !== 'presence') || !!(into && boxOfNote(into)?.group.locked);
      const preview = () => { if (!button.disabled) target.cell.dataset.preview = ''; };
      const restore = () => { delete target.cell.dataset.preview; };
      button.addEventListener('mouseenter', preview); button.addEventListener('focus', preview);
      button.addEventListener('mouseleave', restore); button.addEventListener('blur', restore);
      button.addEventListener('click', () => copyValue(row.key, source.value.index, target.value.index));
      buttons.append(button);
    }
    tr.append(cells[0].cell, buttons, cells[1].cell); body.append(tr);
  }
}
function counterpart(state, anchorCopy, anchor, targetCopy) {
  if (!anchor) return null;
  if (anchorCopy.ids[0] === targetCopy.ids[0]) return anchor;
  const result = compareCopy(anchorCopy, targetCopy, laneClock(state.lane).beatAt, displayedFingers(state.lane));
  return result.pairs.find(([a]) => a === anchor)?.[1] || result.changes.find(change => change.from === anchor)?.to || null;
}
function updateHoverPreview() {
  if (!hover) return;
  // Below the repeat toolbar, or above it where the pane has no room below.
  const card = $('repeatHover'), nav = $('repeatNavigator').getBoundingClientRect?.(), room = $('repeatNavigator').parentElement?.getBoundingClientRect?.();
  card.classList.toggle('repeat-hover-above', !!nav && !!room && nav.bottom + card.offsetHeight + 8 > room.bottom);
  draw();
}
export function hideRepeatHover() {
  const wasOpen = !!hover;
  hover = null;
  if ($('repeatHover')) $('repeatHover').hidden = true;
  if (wasOpen) draw();
  return wasOpen;
}
// The transport is the only source of automatic comparison-card selection.
// Keep manual preview choices and explicit dismissal until the playhead reaches
// another note, rather than reopening the card on every repaint.
// A seek lands a hair before its target: Chromium reports media time in whole
// microseconds. Where one note ends as the next begins, that hair must not
// leave the playhead on the earlier note (the fretboard allows the same 1 ms).
const SEEK_SLACK = 1e-3;
export function syncRepeatPlayhead() {
  let state = current();
  if (!state || worker || S.drag) {
    if (review) review.playheadMarker = null;
    hideRepeatHover(); return;
  }
  const time = playbackTime();
  if (transportPlaying() || time !== review.manualSeekTime) review.manualSeekTime = null;
  const manual = review.manualSeekTime === time;
  // Only the instance and group controls choose the instance. The playhead,
  // placed anywhere, even inside another instance, never does.
  if (transportPlaying()) {
    review.playheadMarker = null;
    hideRepeatHover(); return;
  }
  const atPlayhead = marker => time >= marker.note.start - SEEK_SLACK && time < marker.note.end - SEEK_SLACK;
  const stops = changeStops(state);
  // Under the playhead, only this instance's own notes: a note missing here is
  // the other instance's, so only the difference buttons open it.
  const changed = stops.filter(stop => stop.marker.current && atPlayhead(stop.marker));
  const marker = (manual && stops.find(stop => stop.key === review.changeKey)
    || changed.find(stop => stop.key === review.changeKey) || changed[0])?.marker;
  const identity = [state.parent.id, state.copy.ids[0], marker && markerKey(state.copy, marker),
    S.voicingRevision, S.fingerRevision, handResult, state.group.copies.map(c => c.ids[0]).join()];
  if (review.playheadMarker && identity.every((value, i) => value === review.playheadMarker[i])) return;
  review.playheadMarker = identity;
  if (hover && marker && hover.instance === state.copy.ids[0] && hover.group === state.group.id
    && markerKey(state.copy, hover.marker) === markerKey(state.copy, marker) && hover.revision === S.voicingRevision) return;
  hideRepeatHover();
  if (marker) openRepeatMarker(state, marker);
}
function openRepeatMarker(state, marker) {
  review.changeKey = markerKey(state.copy, marker); review.changeAnchor = { start: marker.note.start, pitch: marker.note.pitch };
  navKey = null;
  const anchorCopy = marker.anchorCopy || state.copy;
  marker.anchor ||= marker.current || marker.first; marker.first = marker.current;
  hover = { lane: state.lane, group: state.group.id, instance: state.copy.ids[0], marker, revision: S.voicingRevision,
    index: state.index, anchorKey: anchorCopy.ids[0] };
  hideTooltip();
  fillHoverRows(state);
  $('repeatHover').hidden = false;
  updateHoverPreview();
}
function drawDifference(marker, left, right) {
  const { note, kind } = marker;
  const x = xOf(note.start), end = xOf(note.end);
  if (x > right || end < left) return;
  const pad = 2, y = yOf(note.pitch);
  sctx.strokeStyle = PAINT.warn; sctx.lineWidth = 3; sctx.setLineDash(kind === 'missing' ? [4, 3] : []);
  sctx.strokeRect(x - pad, y - pad, Math.max(2, end - x) + pad * 2, S.state.rowH + pad * 2);
  sctx.setLineDash([]);
}
// The note being compared on the other side: what is selected there (the arrow
// keys select as they go), or what its comparison card shows. Its counterpart in
// this pane's instance lights up.
let glowCache = null;
function comparedHere(state) {
  const elsewhere = state.group.copies.find(c => c !== state.copy);
  if (!elsewhere) return [];
  const mine = new Set(elsewhere.notes.map(entry => entry.note));
  const asked = [...S.selection, hover?.marker.current].filter(note => note && mine.has(note));
  if (!asked.length) return [];
  const key = [state.copy, elsewhere, S.selection, hover?.marker.current, S.voicingRevision, S.fingerRevision, handResult];
  if (glowCache && key.every((v, i) => v === glowCache.key[i])) return glowCache.notes;
  const result = compareCopy(elsewhere, state.copy, laneClock(state.lane).beatAt, displayedFingers(state.lane));
  const across = new Map([...result.pairs, ...result.changes.map(change => [change.from, change.to])]);
  glowCache = { key, notes: asked.map(note => across.get(note)).filter(Boolean) };
  return glowCache.notes;
}
export function drawRepeats() {
  const state = current();
  if (!state || !state.lane.visible) return;
  const { group, copy: focused } = state;
  const left = scroll.scrollLeft, right = left + scroll.clientWidth;
  sctx.save(); sctx.font = stageUi(11, 700); sctx.textAlign = 'left'; sctx.textBaseline = 'bottom';
  group.copies.forEach((copy, i) => {
    const bounds = repeatCopyBounds(state, copy);
    const x0 = xOf(bounds.t0) - 6, x1 = xOf(bounds.t1) + 6;
    if (x0 > right || x1 < left) return;
    const y0 = yOf(bounds.pHi) - 21, y1 = yOf(bounds.pLo) + S.state.rowH + 7;
    const active = copy === focused;
    sctx.globalAlpha = active ? 1 : 0.5;
    sctx.strokeStyle = PAINT.trace; sctx.lineWidth = active ? 2 : 1; sctx.setLineDash(active ? [] : [5, 3]);
    sctx.strokeRect(x0, y0, Math.max(1, x1 - x0), y1 - y0); sctx.setLineDash([]);
    // Only the shown instance keeps its label in view; another's scrolls off with its frame.
    const label = `${group.name} · instance ${originalIndex(state, copy)}`, labelX = active ? Math.max(left + 3, x0 + 3) : x0 + 3;
    sctx.strokeStyle = halo(); sctx.lineWidth = 3; sctx.strokeText(label, labelX, y0 - 2);
    sctx.fillStyle = PAINT.trace; sctx.fillText(label, labelX, y0 - 2);
  });
  sctx.globalAlpha = 1;
  for (const note of comparedHere(state)) {
    const x = xOf(note.start);
    if (x > right || xOf(note.end) < left) continue;
    sctx.beginPath(); sctx.rect(x, yOf(note.pitch), Math.max(2, xOf(note.end) - x), S.state.rowH);
    paintNoteGlow(sctx, 1);
  }
  {
    const details = comparisonDetails(state);
    for (const marker of details.markers) {
      drawDifference(marker, left, right);
    }
  }
  sctx.restore();
}
function closeRepeatPickers(except = null) {
  let closed = false;
  for (const id of ['repeatInstance']) {
    const picker = $(id);
    if (picker !== except && picker.open) {
      picker.open = false; closed = true;
      if (picker.contains(document.activeElement)) picker.children[0]?.focus();
    }
  }
  return closed;
}
export function init_repeats(dependencies) {
  actions = dependencies;
  initRepeatDock($('repeatNavigator'), $('repeatDrag'));
  for (const id of ['repeatInstance']) $(id).addEventListener('toggle', () => {
    if ($(id).open) closeRepeatPickers($(id));
  });
  window.addEventListener('pointerdown', event => {
    for (const id of ['repeatInstance']) if (!$(id).contains(event.target)) $(id).open = false;
  });
  $('repeatHoverClose').addEventListener('click', hideRepeatHover);
  $('repeatClose').addEventListener('click', closeRepeats);
  registerEscapeLayer(ESC_DEPTH.popover, () => closeRepeatPickers() || hideRepeatHover());
  $('repeatGroup').addEventListener('change', () => {
    if (!review) return;
    review.group = $('repeatGroup').value; review.first = null; review.copyKey = null;
    revealCurrent();
  });
  $('repeatInstance').addEventListener('change', () => selectInstance($('repeatInstance').value));
  $('repeatPrevious').addEventListener('click', () => stepCopy(-1));
  $('repeatNext').addEventListener('click', () => stepCopy(1));
  $('repeatGroupPrevious').addEventListener('click', () => stepGroup(-1));
  $('repeatGroupNext').addEventListener('click', () => stepGroup(1));
  $('repeatChangePosition').addEventListener('change', () => {
    const state = current();
    const stop = state && changeStops(state).find(stop => stop.key === $('repeatChangePosition').value);
    if (stop) focusRepeatMarker(state, stop.marker);
  });
  $('repeatChangePrevious').addEventListener('click', () => stepChange(-1));
  $('repeatChangeNext').addEventListener('click', () => stepChange(1));
  window.addEventListener('keydown', handleRepeatNavigationKey, true);
  registerEscapeLayer(ESC_DEPTH.transient, closeRepeats);
  const reset = () => { closeRepeats(); optionsKey = null; };
  window.addEventListener('cw-project-closed', reset);
}
