// Persistent, named repeat groups for the current layer. Scanning only annotates;
// applying positions is a separate, explicit edit.
import { compareCopy, groupsFromRepeats, resolveRepeatGroups } from './repeats-core.js';
import { commit, commitStructure, snapshotEdit, setHandAnchor } from './edit.js';
import { scroll, sctx, stage } from './dom.js';
import { xOf, yOf } from './geometry.js';
import { activeLane, canEditLane, refreshCounts } from './lanes.js';
import { toast } from './notify.js';
import { boxOfNote, laneClock, noteBounds } from './references.js';
import { draw } from './repaint.js';
import { PAINT, halo } from './stage-paint.js';
import { S } from './store.js';
import { laneFingering, refreshTabIfOpen } from './tablature.js';
import { stageUi } from './constants.js';
import { manualViewportNavigation, moveViewportTo } from './viewport-motion.js';
import { registerEscapeLayer, ESC_DEPTH } from './escape-stack.js';
import { clearMatches } from './tracing.js';
import { previewFretboardNote, setFretboardVisible } from './fretboard.js';
import { noteName } from './util.js';
import { applyNoteCounterpart, applyPresenceCounterpart, curveGraph, noteChangeRows, noteInstanceRows } from './repeat-change-details.js';
import { placeFloatingAvoiding } from './floating-position.js';
import { hideTooltip } from './tooltip.js';
import { pitchCurve } from './whammy.js';
import { noteRibbon } from './note-render.js';
import { modalOpen } from './modal-focus.js';
import { nid } from './ids.js';

const $ = id => document.getElementById(id);
let worker = null, scanLane = null, scanProject = null, scanSignature = null;
let hover = null, hoverTargets = [], hideHoverTimer = 0;
let stopCache = null;
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
const groupsOf = lane => resolveRepeatGroups(lane, laneClock(lane).beatAt);
const timeLabel = copy => {
  const b = noteBounds(copy.notes.map(n => n.note));
  const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  return `${fmt(b.t0)}–${fmt(b.t1)}`;
};
function current() {
  const lane = S.state ? activeLane() : null;
  if (!review || !lane || review.lane !== lane.id) return null;
  const groups = groupsOf(lane);
  const group = groups.find(g => g.id === review.group) || groups[0];
  if (!group) return null;
  review.group = group.id;
  const index = Math.max(0, group.copies.findIndex(c => review.copyKey ? c.ids[0] === review.copyKey : c.notes[0].note.id === review.first));
  const copy = group.copies[index];
  review.first = copy.notes[0].note.id; review.copyKey = copy.ids[0];
  return { lane, groups, group, copy, index, model: group.copies[0] };
}
function repeatCopyBounds(state, copy) {
  const clock = laneClock(state.lane), origin = clock.beatAt(copy.notes[0].note.start);
  const projected = state.group.copies.flatMap(other => other.notes.map(({ note, beat }) => ({
    pitch: note.pitch, start: clock.timeAt(origin + beat),
    end: clock.timeAt(origin + beat + clock.beatAt(note.end) - clock.beatAt(note.start)),
  })));
  // Interior missing notes still belong to the passage. Include their pitch
  // and sustain in its frame, even when no present note reaches that row.
  return noteBounds([...copy.notes.map(entry => entry.note), ...projected]);
}
function revealCurrent() {
  hideRepeatHover();
  if (review) { review.changeKey = null; review.changeAnchor = null; }
  const state = current();
  if (!state) { draw(); return; }
  const b = repeatCopyBounds(state, state.copy);
  moveViewportTo(xOf(b.t0) - scroll.clientWidth * 0.2, yOf((b.pLo + b.pHi) / 2) - scroll.clientHeight / 2);
  draw();
}
function stepCopy(delta) {
  const state = current();
  if (!state) return;
  const index = (state.index + delta + state.group.copies.length) % state.group.copies.length;
  review.first = state.group.copies[index].notes[0].note.id;
  review.copyKey = state.group.copies[index].ids[0];
  revealCurrent();
}
export function closeRepeats() {
  if (!review && !worker) return false;
  hideRepeatHover();
  worker?.terminate(); worker = null; scanLane = null; scanProject = null;
  review = null; navKey = null; handRequest = null; handResult = null; handSeats = null; stopCache = null;
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
  scanLane = lane; scanProject = S.state; scanSignature = signature(lane);
  const beatAt = laneClock(lane).beatAt;
  clearMatches();
  review = { lane: lane.id, group: lane.repeatGroups?.[0]?.id };
  navKey = null;
  setFretboardVisible(true);
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
    const repeats = data.map(r => ({ copies: r.copies.map(ids => ({ notes: ids.map(id => ({ note: byId.get(id) })) })) }));
    const groups = groupsFromRepeats(repeats, lane.repeatGroups);
    if (JSON.stringify(groups) !== JSON.stringify(lane.repeatGroups || [])) editGroups(lane, () => { lane.repeatGroups = groups; });
    review = groups.length ? { lane: lane.id, group: groups[0].id } : null;
    navKey = null;
    toast(`${groups.length} repeat group${groups.length === 1 ? '' : 's'} in “${lane.name}”`);
    revealCurrent();
  };
  worker.onerror = () => {
    if (worker !== pending) return;
    pending.terminate(); worker = null; scanLane = null; scanProject = null;
    toast('Could not scan repeats. Try again.', 3000, 'error'); draw();
  };
  worker.postMessage(lane.notes.map(n => ({ id: n.id, start: beatAt(n.start), end: beatAt(n.end), pitch: n.pitch, gripOnly: n.gripOnly })));
  draw();
}

export function renderRepeatNavigator() {
  const nav = $('repeatNavigator');
  if (!nav) return;
  const lane = S.state ? activeLane() : null, state = current(), scanning = !!worker && scanLane === lane;
  nav.hidden = !scanning && !state;
  if (nav.hidden) { hideRepeatHover(); return; }
  if (hover && (hover.lane !== lane || hover.group !== state?.group.id || hover.instance !== state?.copy.ids[0]
    || hover.revision !== S.voicingRevision || S.drag)) hideRepeatHover();
  const key = [S.state, lane, lane?.notes, lane?.repeatGroups, S.voicingRevision,
    review?.group, review?.first, review?.changeKey, scanning, !!lane?.locked, !!lane?.visible, S.fingerRevision, handResult];
  if (navKey && key.every((v, i) => v === navKey[i])) return;
  navKey = key;
  const groups = state?.groups || [];
  const optionSig = JSON.stringify(groups.map(g => [g.id, g.name, g.copies.length]));
  const select = $('repeatGroup');
  if (optionsKey !== optionSig) {
    optionsKey = optionSig;
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
  $('repeatPosition').textContent = state ? `${state.index + 1} / ${state.group.copies.length}` : 'Scanning…';
  $('repeatPosition').title = state ? timeLabel(state.copy) : 'Finding repeated passages';
  $('repeatPrevious').disabled = $('repeatNext').disabled = scanning || !state || state.group.copies.length < 2;
  $('repeatGroupPrevious').disabled = $('repeatGroupNext').disabled = scanning || groups.length < 2;
  const stops = state ? changeStops(state) : [];
  const changeIndex = stops.findIndex(stop => stop.key === review?.changeKey);
  $('repeatChangePosition').textContent = stops.length ? `${changeIndex < 0 ? '–' : changeIndex + 1} / ${stops.length}` :
    state ? `${state.index + 1} / ${state.group.copies.length}` : '– / 0';
  if ($('repeatChangeLabel')) $('repeatChangeLabel').textContent = stops.length ? 'Change' : 'Instance';
  $('repeatChangePrevious').disabled = $('repeatChangeNext').disabled = scanning || !state || (!stops.length && state.group.copies.length < 2);
  if (hover && state) fillHoverRows(state);

}

function comparisonDetails(state) {
  const clock = laneClock(state.lane), fingers = displayedFingers(state.lane);
  const markers = [], byNote = new Map(), ghosts = new Map();
  const targets = state.copy.notes.map(({ note }) => {
    const marker = { note, current: note, first: note, anchor: note, anchorCopy: state.copy };
    byNote.set(note, marker); return marker;
  });
  const changed = (note, kind, color) => {
    const marker = byNote.get(note);
    if (!marker) return;
    if (!marker.kind) markers.push(marker);
    // A played difference takes precedence over finger-only highlighting.
    if (!marker.kind || kind === 'played') Object.assign(marker, { kind, color });
  };
  const origin = clock.beatAt(state.copy.notes[0].note.start);
  for (const other of state.group.copies) {
    if (other === state.copy) continue;
    const comparison = compareCopy(state.copy, other, clock.beatAt, fingers);
    for (const change of comparison.changes) {
      const firstOrigin = clock.beatAt(state.copy.notes[0].note.start), otherOrigin = clock.beatAt(other.notes[0].note.start);
      const rows = noteChangeRows(change.from, change.to, { beatAt: clock.beatAt, fingers,
        firstBeat: clock.beatAt(change.from.start) - firstOrigin, currentBeat: clock.beatAt(change.to.start) - otherOrigin });
      if (rows.some(row => row.key !== 'whammy' && (row.before !== row.after || row.curves))) changed(change.from, 'played', PAINT.warn);
    }
    for (const [a] of comparison.positionDifferences) changed(a, 'played', PAINT.warn);
    for (const [a] of comparison.fingerDifferences) changed(a, 'finger', PAINT.accent);
    for (const { note } of comparison.missing) changed(note, 'extra', PAINT.ok);
    for (const { note, beat } of comparison.added) {
      const key = `${Math.round(beat * 10000)}:${note.pitch}`;
      if (ghosts.has(key)) continue;
      const start = clock.timeAt(origin + beat);
      const end = clock.timeAt(origin + beat + clock.beatAt(note.end) - clock.beatAt(note.start));
      const marker = { kind: 'missing', first: note, current: null, anchor: note, anchorCopy: other,
        note: { pitch: note.pitch, start, end }, color: PAINT.error };
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
function changeStops(state) {
  const key = [S.state, state.lane, state.lane.notes, state.lane.repeatGroups, state.group.id, S.voicingRevision, S.fingerRevision, handResult];
  if (stopCache && key.every((value, i) => value === stopCache.key[i])) return stopCache.stops;
  const stops = state.group.copies.flatMap((copy, index) => comparisonDetails({ ...state, copy, index }).markers.map(marker =>
    ({ key: markerKey(copy, marker), copy, marker })));
  stops.sort((a, b) => a.marker.note.start - b.marker.note.start || a.marker.note.pitch - b.marker.note.pitch);
  stopCache = { key, stops };
  return stops;
}
function stepChange(delta) {
  const state = current();
  if (!state) return;
  const stops = changeStops(state);
  if (!stops.length) { stepCopy(delta); return; }
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
  openRepeatMarker(state, marker, true);
  draw();
}
function jumpToNoteInstance() {
  const state = current();
  if (!hover || !state) return;
  const copy = state.group.copies[hover.selected], anchorCopy = state.group.copies.find(c => c.ids[0] === hover.anchorKey);
  if (!copy || !anchorCopy || !hover.marker.anchor) return;
  const selected = hover.marker.first, anchor = hover.marker.anchor, beatAt = laneClock(state.lane).beatAt;
  const relativeBeat = beatAt(anchor.start) - beatAt(anchorCopy.notes[0].note.start);
  review.copyKey = copy.ids[0]; review.first = copy.notes[0].note.id; navKey = null;
  const next = current();
  if (!next) return;
  const origin = beatAt(next.copy.notes[0].note.start);
  const marker = comparisonDetails(next).targets.find(target => selected ? target.current?.id === selected.id :
    !target.current && target.note.pitch === anchor.pitch && Math.abs(beatAt(target.note.start) - origin - relativeBeat) <= .125);
  if (marker) focusRepeatMarker(next, marker);
  else revealCurrent();
}
export function handleRepeatNavigationKey(event) {
  if (!review || worker || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || S.drag
    || !['ArrowLeft', 'ArrowRight'].includes(event.key) || !current()
    || $('repeatNavigator').hidden || $('repeatNavigator').closest?.('[hidden], [inert]')
    || modalOpen('[aria-modal="true"]:not([data-editor-keys])')) return false;
  const target = event.target;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(target?.tagName) || target?.isContentEditable
    || target?.closest?.('[contenteditable="true"], [role="listbox"], [role="menu"]')) return false;
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  if (event.shiftKey) stepGroup(delta);
  else if (event.altKey) stepCopy(delta);
  else stepChange(delta);
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
    return { note, handAnchor: handAnchorAt(state.lane, note), onset: note ? beatAt(note.start) - beatAt(copy.notes[0].note.start) : null,
      slideCurve: note ? noteRibbon(state.lane, note)?.points || [] : [] };
  });
}
function applyCommonValue(key, sourceIndex = null, targetIndex = null) {
  const state = current();
  if (!hover || !state || !canEditLane(state.lane)) return;
  const clock = laneClock(state.lane), instances = hoverInstances(state), viewed = hover.selected, selected = targetIndex ?? viewed;
  const row = noteInstanceRows(instances, selected, { beatAt: clock.beatAt, fingers: displayedFingers(state.lane), activeIndex: hover.index }).find(row => row.key === key);
  if (!row) return;
  if (sourceIndex != null) { row.commonIndex = sourceIndex; delete row.commonLength; }
  else if (!row.uncommon || row.commonIndex == null) return;
  const target = instances[selected].note;
  let source = instances[row.commonIndex].note;
  if (row.commonLength != null && source) source = { ...source, end: clock.timeAt(clock.beatAt(source.start) + row.commonLength) };
  if (target && boxOfNote(target)?.group.locked) return;
  const targetCopy = state.group.copies[selected], sourceCopy = state.group.copies[row.commonIndex];
  const options = { ...clock, fingers: displayedFingers(state.lane), mintId: nid, targetIds: targetCopy.ids,
    sourceOrigin: clock.beatAt(sourceCopy.notes[0].note.start), targetOrigin: clock.beatAt(targetCopy.notes[0].note.start) };
  const prev = snapshotEdit(), anchorId = hover.marker.anchor?.id, currentId = hover.marker.current?.id;
  let result = null, changed = false, alreadyCommitted = false;
  if (key === 'handAnchor' && target) {
    const revision = S.voicingRevision;
    setHandAnchor(state.lane, target.start, instances[row.commonIndex].handAnchor || null);
    changed = S.voicingRevision !== revision; alreadyCommitted = true;
  } else if (key === 'presence') {
    result = applyPresenceCounterpart(state.lane, source, target, options); changed = result.changed;
    if (result.note && !target && boxOfNote(result.note)?.group.locked) {
      state.lane.notes = state.lane.notes.filter(note => note !== result.note);
      const i = targetCopy.ids.indexOf(result.note.id); if (i >= 0) targetCopy.ids.splice(i, 1);
      return;
    }
  } else changed = applyNoteCounterpart(key, source, target, options);
  if (!changed) return;
  if (!alreadyCommitted && commit(prev, undefined, null, { preserveTiming: true }) === false) { hideRepeatHover(); return; }
  if (key === 'presence' && !source && target) S.selection.delete(target);
  const byId = new Map(state.lane.notes.map(note => [note.id, note]));
  const updated = result ? result.note : byId.get(target?.id);
  hover.marker.first = selected === viewed ? updated || null : byId.get(instances[viewed].note?.id) || null;
  hover.marker.current = selected === hover.index ? updated || null : byId.get(currentId) || null;
  hover.marker.anchor = byId.get(anchorId) || source && byId.get(source.id) || updated || null;
  if (!hover.marker.anchor) { hideRepeatHover(); navKey = null; draw(); return; }
  if (!byId.has(anchorId) && source) hover.anchorKey = sourceCopy.ids[0];
  if (hover.marker.current) hover.marker.note = hover.marker.current;
  hover.revision = S.voicingRevision; hover.pinned = true;
  handRequest = null; handResult = null; handSeats = null; stopCache = null; navKey = null;
  refreshCounts(); refreshTabIfOpen();
  const next = current();
  if (!next) { hideRepeatHover(); draw(); return; }
  fillHoverRows(next); updateHoverPreview(); renderRepeatNavigator();
}
function fillHoverRows(state) {
  const rows = $('repeatHoverRows'); rows.replaceChildren();
  const beatAt = laneClock(state.lane).beatAt, instances = hoverInstances(state);
  for (const row of noteInstanceRows(instances, hover.selected, { beatAt, fingers: displayedFingers(state.lane), activeIndex: hover.index })) {
    const tr = document.createElement('tr'), heading = document.createElement('th'), cell = document.createElement('td');
    heading.textContent = row.label; heading.setAttribute('scope', 'row'); tr.append(heading);
    const opened = instances[hover.index], viewed = instances[hover.selected];
    const pairDiffers = hover.selected !== hover.index && (row.key === 'handAnchor'
      ? opened.handAnchor !== viewed.handAnchor : row.key === 'slideCurve'
      ? JSON.stringify(opened.slideCurve) !== JSON.stringify(viewed.slideCurve)
      : noteChangeRows(opened.note, viewed.note, { beatAt, fingers: displayedFingers(state.lane), firstBeat: opened.onset ?? 0, currentBeat: viewed.onset ?? 0 }).some(change => change.key === row.key));
    if (hover.selected !== hover.index ? pairDiffers : row.uncommon) {
      cell.className = 'repeat-uncommon';
      cell.setAttribute('aria-label', `${row.label}, less common across instances`);
    }
    const paintValue = valueRow => {
      cell.replaceChildren();
      const isCurve = ['whammyPoints', 'bendPoints', 'slideCurve'].includes(row.key);
      const absentCurve = isCurve && !valueRow.curve?.length;
      heading.className = absentCurve ? 'repeat-curve-unavailable' : '';
      heading.setAttribute('aria-label', absentCurve ? `${row.label} unavailable` : row.label);
      if (isCurve || valueRow.curve?.length) {
        const points = valueRow.curve || [], range = row.curveRange || valueRow.curveRange || [0, 0];
        curveCell(cell, points, row.label, range[0], range[1]);
      } else { const value = document.createElement('span'); value.textContent = valueRow.value; cell.append(value); }
    };
    paintValue(row);
    const actions = document.createElement('td'); actions.className = 'repeat-row-actions';
    if (pairDiffers) {
      for (const [source, target, symbol] of [[hover.index, hover.selected, '→'], [hover.selected, hover.index, '←']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'repeat-copy-direction';
        button.textContent = symbol; button.dataset.change = row.key; button.dataset.source = String(source); button.dataset.target = String(target);
        button.setAttribute('aria-label', `Copy ${row.label.toLowerCase()} from instance ${source + 1} to instance ${target + 1}`);
        button.disabled = !canEditLane(state.lane) || (!instances[target].note && row.key !== 'presence') || !!(instances[target].note && boxOfNote(instances[target].note)?.group.locked);
        const sourceRow = noteInstanceRows(instances, source, { beatAt, fingers: displayedFingers(state.lane) }).find(value => value.key === row.key);
        const preview = () => { if (!button.disabled && sourceRow) paintValue(sourceRow); };
        button.addEventListener('mouseenter', preview); button.addEventListener('focus', preview);
        button.addEventListener('mouseleave', () => paintValue(row)); button.addEventListener('blur', () => paintValue(row));
        button.addEventListener('click', () => applyCommonValue(row.key, source, target)); actions.append(button);
      }
    } else if (row.uncommon && row.commonIndex != null) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'repeat-apply-common';
      button.textContent = row.key === 'presence' ? (instances[row.commonIndex].note ? 'Add' : 'Remove') : 'Apply';
      button.dataset.change = row.key;
      const actionLabel = row.key === 'presence' && !instances[row.commonIndex].note ? 'Remove this note to match the common absence' : `Apply the common ${row.label.toLowerCase()}`;
      button.setAttribute('aria-label', actionLabel);
      button.disabled = !canEditLane(state.lane) || !!(instances[hover.selected].note && boxOfNote(instances[hover.selected].note)?.group.locked);
      const commonRow = row.commonLength != null ? { ...row, value: row.commonDisplay } :
        noteInstanceRows(instances, row.commonIndex, { beatAt, fingers: displayedFingers(state.lane) }).find(common => common.key === row.key);
      const preview = () => { if (!button.disabled && commonRow) paintValue(commonRow); };
      const restore = () => paintValue(row);
      button.addEventListener('mouseenter', preview); button.addEventListener('mouseleave', restore);
      button.addEventListener('focus', preview); button.addEventListener('blur', restore);
      button.addEventListener('click', () => applyCommonValue(row.key)); actions.append(button);
    }
    tr.append(cell, actions); rows.append(tr);
  }
}
function counterpart(state, anchorCopy, anchor, targetCopy) {
  if (!anchor) return null;
  if (anchorCopy.ids[0] === targetCopy.ids[0]) return anchor;
  const result = compareCopy(anchorCopy, targetCopy, laneClock(state.lane).beatAt, displayedFingers(state.lane));
  return result.pairs.find(([a]) => a === anchor)?.[1] || result.changes.find(change => change.from === anchor)?.to || null;
}
function showNoteVersion(delta) {
  const state = current();
  if (!hover || !state) return;
  clearTimeout(hideHoverTimer); hideHoverTimer = 0;
  hover.pinned = true;
  hover.selected = (hover.selected + delta + state.group.copies.length) % state.group.copies.length;
  const copy = state.group.copies[hover.selected], anchorCopy = state.group.copies.find(c => c.ids[0] === hover.anchorKey);
  hover.marker.first = anchorCopy ? counterpart(state, anchorCopy, hover.marker.anchor, copy) : null;
  hover.origins.first = laneClock(state.lane).beatAt(copy.notes[0].note.start);
  hover.showFirst = hover.selected !== hover.index;
  fillHoverRows(state);
  updateHoverPreview();
}
export function repeatPreviewHiddenNote() {
  return hover?.showFirst ? hover.marker.current : null;
}
function projectedFirstNote(state) {
  if (!hover?.marker.first) return null;
  const source = hover.marker.first, clock = laneClock(state.lane);
  const origin = hover.origins.current, beat = clock.beatAt(source.start) - hover.origins.first;
  const start = clock.timeAt(origin + beat);
  return { ...source, start, end: clock.timeAt(origin + beat + clock.beatAt(source.end) - clock.beatAt(source.start)) };
}
function hoverAvoidance() {
  const state = current();
  if (!hover || !state) return { rects: [] };
  const frame = stage.getBoundingClientRect();
  const region = { left: frame.left, top: frame.top, right: frame.right ?? frame.left + scroll.clientWidth,
    bottom: frame.bottom ?? frame.top + scroll.clientHeight };
  const rects = [];
  const protect = (note, original) => {
    if (!note) return;
    const ribbon = original && noteRibbon(state.lane, original);
    const curve = pitchCurve(note) || ribbon?.points;
    const offsets = curve ? curve.map(([, value]) => value * S.state.rowH) : [0];
    const x = frame.left + xOf(note.start) - scroll.scrollLeft;
    const y = frame.top + yOf(note.pitch) - scroll.scrollTop;
    // Include the whole slide and curve, including a projected slide's end.
    const ratio = original && original.end > original.start ? (note.end - note.start) / (original.end - original.start) : 1;
    const end = ribbon?.end ? note.start + (ribbon.end - original.start) * ratio : note.end;
    const width = Math.max(2, xOf(end) - xOf(note.start));
    rects.push({ left: x - 7, right: x + width + 7,
      top: y - Math.max(0, ...offsets) - 7, bottom: y + S.state.rowH - Math.min(0, ...offsets) + 7 });
  };
  protect(hover.marker.current || hover.marker.note, hover.marker.current);
  protect(projectedFirstNote(state), hover.marker.first);
  return { rects, region };
}
function updateHoverPreview() {
  if (!hover) return;
  $('repeatHoverTitle').textContent = hover.marker.first ? `${noteName(hover.marker.first.pitch)} · Note` : 'Missing note';
  $('repeatNoteVersion').textContent = `${hover.selected + 1} / ${current()?.group.copies.length || 1}`;
  $('repeatNoteFirst').disabled = $('repeatNoteCurrent').disabled = (current()?.group.copies.length || 0) < 2;
  previewFretboardNote(hover.lane, hover.marker.first, `Instance ${hover.selected + 1}`);
  placeFloatingAvoiding($('repeatHover'), hoverAvoidance);
  draw();
}
export function hideRepeatHover() {
  clearTimeout(hideHoverTimer); hideHoverTimer = 0;
  const wasOpen = !!hover;
  hover = null; hoverTargets = [];
  if ($('repeatHover')) $('repeatHover').hidden = true;
  if ($('repeatNoteNavigation')) $('repeatNoteNavigation').hidden = true;
  if (wasOpen) { previewFretboardNote(); draw(); }
  return wasOpen;
}
export function scheduleRepeatHoverHide() {
  if (!hover || hover.pinned || hideHoverTimer || $('repeatHover').contains(document.activeElement) || $('repeatNoteNavigation').contains(document.activeElement)) return;
  hideHoverTimer = setTimeout(hideRepeatHover, 250);
}
// Called by the stage's existing pointer handler, before diagnostic tooltips.
export function hoverRepeatDifference(x, y, clientX, clientY) {
  const state = current();
  if (!state || S.drag) { hideRepeatHover(); return false; }
  const target = hoverTargets.filter(t => x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1)
    .sort((a, b) => Math.abs(y - yOf(a.marker.note.pitch)) - Math.abs(y - yOf(b.marker.note.pitch)))[0];
  if (!target) { scheduleRepeatHoverHide(); return false; }
  clearTimeout(hideHoverTimer); hideHoverTimer = 0;
  const marker = target.marker;
  if (hover?.marker.anchor === marker.anchor && hover?.revision === S.voicingRevision) return true;
  openRepeatMarker(state, marker);
  return true;
}
function openRepeatMarker(state, marker, pinned = false) {
  const clock = laneClock(state.lane);
  review.changeKey = markerKey(state.copy, marker); review.changeAnchor = { start: marker.note.start, pitch: marker.note.pitch };
  navKey = null;
  const anchorCopy = marker.anchorCopy || state.copy;
  marker.anchor ||= marker.current || marker.first; marker.first = marker.current;
  hover = { lane: state.lane, group: state.group.id, instance: state.copy.ids[0], marker, pinned, revision: S.voicingRevision,
    selected: state.index, index: state.index, anchorKey: anchorCopy.ids[0],
    origins: { first: clock.beatAt(state.copy.notes[0].note.start), current: clock.beatAt(state.copy.notes[0].note.start) } };
  hideTooltip();
  fillHoverRows(state);
  $('repeatHoverTitle').textContent = `${noteName(marker.note.pitch)} · Note`;
  hover.showFirst = false;
  $('repeatHover').hidden = false;
  placeFloatingAvoiding($('repeatHover'), hoverAvoidance, { reset: true });
  $('repeatNoteNavigation').hidden = false;
  updateHoverPreview();
}
// The regular note renderer paints the projected note; this only adds its
// hit target so hovering the preview keeps the card open.
function drawFirstPreview(state) {
  if (!hover || !hover.showFirst || !hover.marker.first) return;
  const preview = projectedFirstNote(state), x = xOf(preview.start), y = yOf(preview.pitch);
  const source = hover.marker.first, ribbon = noteRibbon(state.lane, source);
  const curve = pitchCurve(source) || ribbon?.points;
  const offsets = curve ? curve.map(([, value]) => value * S.state.rowH) : [0];
  const ratio = source.end > source.start ? (preview.end - preview.start) / (source.end - source.start) : 1;
  const end = ribbon?.end ? preview.start + (ribbon.end - source.start) * ratio : preview.end;
  hoverTargets.push({ marker: hover.marker, x0: x - 5, x1: xOf(end) + 5,
    y0: y - Math.max(0, ...offsets) - 5, y1: y + S.state.rowH - Math.min(0, ...offsets) + 5 });
}
export function repeatPreviewNote() {
  const state = current();
  if (!state || !hover?.showFirst || !hover.marker.first) return null;
  return { lane: state.lane, source: hover.marker.first, note: projectedFirstNote(state), alpha: .55 };
}
function drawDifference(marker, left, right) {
  const { note, color, kind } = marker;
  const x = xOf(note.start), end = xOf(note.end);
  if (x > right || end < left) return;
  const pad = kind === 'finger' ? 5 : 2, y = yOf(note.pitch);
  sctx.strokeStyle = color; sctx.lineWidth = 3; sctx.setLineDash(kind === 'missing' ? [4, 3] : []);
  sctx.strokeRect(x - pad, y - pad, Math.max(2, end - x) + pad * 2, S.state.rowH + pad * 2);
  sctx.setLineDash([]);
  if (kind === 'missing') {
    sctx.beginPath(); sctx.moveTo(x, y); sctx.lineTo(Math.max(x + 2, end), y + S.state.rowH);
    sctx.moveTo(x, y + S.state.rowH); sctx.lineTo(Math.max(x + 2, end), y); sctx.stroke();
  }
  const curve = pitchCurve(note);
  const offsets = curve ? curve.map(([, v]) => v * S.state.rowH) : [0];
  hoverTargets.push({ marker, x0: x - pad - 3, x1: Math.max(x + 2, end) + pad + 3,
    y0: y - pad - Math.max(0, ...offsets), y1: y + S.state.rowH + pad - Math.min(0, ...offsets) });
}
export function drawRepeats() {
  hoverTargets = [];
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
    const label = `${group.name} · instance ${i + 1}`, labelX = Math.max(left + 3, x0 + 3);
    sctx.strokeStyle = halo(); sctx.lineWidth = 3; sctx.strokeText(label, labelX, y0 - 2);
    sctx.fillStyle = PAINT.trace; sctx.fillText(label, labelX, y0 - 2);
  });
  sctx.globalAlpha = 1;
  {
    const details = comparisonDetails(state);
    for (const marker of details.markers) {
      if (hover?.showFirst && marker.anchor === hover.marker.anchor) continue;
      drawDifference(marker, left, right);
    }
    for (const marker of details.targets) {
      if (marker.kind === 'missing') continue;
      const n = marker.note, x = xOf(n.start), end = xOf(n.end), y = yOf(n.pitch);
      if (x <= right && end >= left) hoverTargets.push({ marker, x0: x - 2, x1: Math.max(x + 2, end) + 2, y0: y - 2, y1: y + S.state.rowH + 2 });
    }
    if (hover) {
      const n = hover.marker.note, x = xOf(n.start), y = yOf(n.pitch);
      hoverTargets.push({ marker: hover.marker, x0: x - 5, x1: xOf(n.end) + 5, y0: y - 5, y1: y + S.state.rowH + 5 });
    }
    drawFirstPreview(state);
  }
  sctx.restore();
}
export function init_repeats() {
  const card = $('repeatHover'), arrows = $('repeatNoteNavigation'); document.body.append(card);
  for (const panel of [card]) {
    panel.addEventListener('mouseenter', () => { clearTimeout(hideHoverTimer); hideHoverTimer = 0; });
    panel.addEventListener('mouseleave', scheduleRepeatHoverHide);
    panel.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget) && !arrows.contains(event.relatedTarget)) scheduleRepeatHoverHide(); });
  }
  $('repeatNoteFirst').addEventListener('click', () => showNoteVersion(-1));
  $('repeatNoteCurrent').addEventListener('click', () => showNoteVersion(1));
  $('repeatNoteJump').addEventListener('click', jumpToNoteInstance);
  $('repeatHoverClose').addEventListener('click', hideRepeatHover);
  $('repeatClose').addEventListener('click', closeRepeats);
  for (const type of ['wheel', 'mousedown']) window.addEventListener(type, event => {
    if (!card.contains(event.target) && !arrows.contains(event.target)) hideRepeatHover();
  }, true);
  window.addEventListener('blur', hideRepeatHover);
  registerEscapeLayer(ESC_DEPTH.popover, hideRepeatHover);
  $('repeatGroup').addEventListener('change', () => {
    if (!review) return;
    review.group = $('repeatGroup').value; review.first = null; review.copyKey = null;
    revealCurrent();
  });
  $('repeatPrevious').addEventListener('click', () => stepCopy(-1));
  $('repeatNext').addEventListener('click', () => stepCopy(1));
  $('repeatGroupPrevious').addEventListener('click', () => stepGroup(-1));
  $('repeatGroupNext').addEventListener('click', () => stepGroup(1));
  $('repeatChangePrevious').addEventListener('click', () => stepChange(-1));
  $('repeatChangeNext').addEventListener('click', () => stepChange(1));
  window.addEventListener('keydown', handleRepeatNavigationKey, true);
  registerEscapeLayer(ESC_DEPTH.transient, closeRepeats);
  const reset = () => { closeRepeats(); optionsKey = null; };
  window.addEventListener('cw-project-opened', reset);
  window.addEventListener('cw-project-closed', reset);
}
