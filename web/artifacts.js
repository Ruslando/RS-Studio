// Project references, indexed directly from their persisted capture boxes.
import { $, audio, scroll } from "./dom.js";
import { pitchAt, timeAt, xOf, yOf } from "./geometry.js";
import { snap, snapNote } from "./grid.js";
import { localXY } from "./interaction.js";
import { activateLane, activeLane, canEditLane, renderLanes } from "./lanes.js";
import { seekPlayback } from "./playback.js";
import { refreshSaveState } from "./project.js";
import { eachRefGroup, laneClock, noteBounds, notesInBox, occurrenceBox, overlapsRefBox, shiftOf, spanAt, toggleRefEditLock, toggleRefPitchLock } from "./references.js";
import { toast } from "./notify.js";
import { icon } from "./icons.js";
import { draw } from "./repaint.js";
import { S, setSelection } from "./store.js";
import { moveViewportTo, stopViewportMotion } from "./viewport-motion.js";
import { initArtifactsPanel } from "./artifacts-panel.js";
import { paintArtifactPreviews, referencePreview, resetArtifactPreviews, stopArtifactPreview, stopArtifactPreviewFor, removeArtifactPreview } from "./artifact-preview.js";

import { clipOf, doCopy, doPaste, openRefMenu, openMotifMenu, placeClip } from "./edit.js";

import { motifGroups } from './motifs.js';
import { artifactName, beginArtifactRename } from './artifact-names.js';
import { initMarkerArtifacts, renderMarkerArtifacts, clearMarkerArtifacts } from './marker-artifacts.js';
import { initRocksmithIssues, renderRocksmithIssues } from './rocksmith-check.js';

const rows = new Map();
let dragged = null;
const NO_DRAG_IMAGE = Object.assign(new Image(), { src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });   // 1px transparent   // the reference or motif being dragged onto the stage
const collapsedArtifacts = new Set();
const disclosureIcon = '<svg class="side-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function jumpToReference(lane, ref, index) {
  const group = lane.refBoxes?.[ref];
  if (!group || group.anchors[index] == null) return;
  stopArtifactPreview();
  const o = occurrenceBox(group, index, laneClock(lane));
  const box = { ...o, t0: Math.max(0, o.t0), t1: Math.min(S.state.duration, o.t1) };
  revealArtifact(lane, box, notesInBox(box, lane.notes));
}

function revealArtifact(lane, box, notes) {
  stopArtifactPreview(); lane.visible = true;
  activateLane(lane);
  setSelection(new Set(notes));
  seekPlayback(box.t0);
  moveViewportTo(xOf(box.t0) - scroll.clientWidth * 0.2,
    yOf((box.pLo + box.pHi) / 2) - scroll.clientHeight / 2);
  renderLanes(); refreshSaveState(); draw();
}

export function renderArtifacts() {
  if (!$('artifactList')) return;
  const references = [], motifs = [];
  if (S.state) {
    // Only the active layer's artifacts: the pane follows the edit target.
    const active = activeLane();
    eachRefGroup((lane, ref) => { if (lane === active) references.push({lane, ref, kind:'reference'}); });
    if (active) for (const [ref] of motifGroups(active.notes)) motifs.push({lane: active, ref, kind:'motif'});
  }
  references.sort((a,b) => a.ref-b.ref);
  const entries = [...references, ...motifs];
  const liveKeys = new Set(entries.map(({lane, ref, kind}) => `${kind}:${lane.id}:${ref}`));
  for (const [key, row] of rows) if (!liveKeys.has(key)) {
    removeArtifactPreview(row.querySelector('.artifact-preview')); row.remove(); rows.delete(key);
  }
  for (const [countId, collection] of [['artifactCount',references],['motifCount',motifs]]) {
    if ($(countId).textContent !== String(collection.length)) $(countId).textContent = String(collection.length);
    // An empty list is not shown at all, header included.
    const head = $(countId).closest('.side-header');
    head.classList.toggle('is-empty', !collection.length); head.nextElementSibling.classList.toggle('is-empty', !collection.length);
  }
  const orders = {reference:0, motif:0};
  for (const {lane, ref, kind} of entries) {
    const list = $(kind === 'motif' ? 'motifList' : 'artifactList');
    const order = orders[kind]++;
    const rowKey = `${kind}:${lane.id}:${ref}`;
    if (rows.has(rowKey)) {
      const row = rows.get(rowKey), name = row.querySelector('.artifact-name');
      const label = artifactName(kind, lane, ref);
      if (name.textContent !== label) name.textContent = label;
      syncPitchLock(row, lane, ref);
      if (list.children[order] !== row) list.insertBefore(row, list.children[order] || null);
      continue;
    }
    const row = document.createElement("li"); row.className = "artifact-row";
    const copy = document.createElement("div"); copy.className = "artifact-copy";
    const name = document.createElement("span"); name.className = "artifact-name"; name.textContent = artifactName(kind, lane, ref);
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', event => {
      event.stopPropagation();
      const currentLane = S.state?.editLanes.find(item => item.id === lane.id);
      if (canEditLane(currentLane)) beginArtifactRename(kind, currentLane, ref, name.getBoundingClientRect());
    });
    const key = rowKey;
    row.dataset[kind] = String(ref);
    // The whole head is the disclosure, like a sidebar section header.
    const toggle = document.createElement('button'); toggle.type = 'button';
    toggle.className = 'artifact-row-head artifact-reference-toggle';
    toggle.innerHTML = disclosureIcon;
    // Framed as on the stage: a reference solid gold, a motif dashed.
    row.dataset.kind = kind;
    copy.append(name); toggle.append(copy);
    const bar = document.createElement('div'); bar.className = 'artifact-row-bar'; bar.append(toggle);
    if (kind === 'reference') {
      const lock = document.createElement('button'); lock.type = 'button';
      lock.className = 'icon-btn icon-btn--compact artifact-transpose';
      lock.addEventListener('click', () => {
        const currentLane = S.state?.editLanes.find(item => item.id === lane.id);
        if (canEditLane(currentLane)) toggleRefPitchLock(currentLane, ref);
      });
      const protect = document.createElement('button'); protect.type = 'button';
      protect.className = 'icon-btn icon-btn--compact artifact-edit-lock';
      protect.setAttribute('aria-label', 'Lock reference');
      protect.addEventListener('click', () => {
        const currentLane = S.state?.editLanes.find(item => item.id === lane.id);
        if (canEditLane(currentLane)) toggleRefEditLock(currentLane, ref);
      });
      bar.append(lock, protect);
    }
    row.append(bar);
    const occurrences = referencePreview(lane, ref, index => {
      const currentLane = S.state.editLanes.find(item => item.id === lane.id);
      if (kind === 'motif') {
        const notes = motifGroups(currentLane?.notes).get(ref);
        if (notes?.length) revealArtifact(currentLane, noteBounds(notes), notes);
      } else jumpToReference(currentLane, ref, index);
    }, kind === 'motif');
    occurrences.id = `artifact-occurrences-${kind}-${lane.id}-${ref}`;
    toggle.setAttribute('aria-controls', occurrences.id);
    const syncCollapse = () => {
      const collapsed = collapsedArtifacts.has(key);
      occurrences.hidden = collapsed;
      if (collapsed) stopArtifactPreviewFor(occurrences);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${name.textContent}`;
    };
    toggle.addEventListener('click', () => {
      if (collapsedArtifacts.has(key)) collapsedArtifacts.delete(key); else collapsedArtifacts.add(key);
      syncCollapse();
    });
    syncCollapse();
    row.addEventListener('contextmenu', event => {
      event.preventDefault(); event.stopPropagation(); stopArtifactPreview(); stopViewportMotion();
      const currentLane = S.state?.editLanes.find(item => item.id === lane.id);
      if (!currentLane || !canEditLane(currentLane)) return;
      if (kind === 'motif') {
        const notes = motifGroups(currentLane.notes).get(ref);
        if (!notes?.length) return;
        activateLane(currentLane); setSelection(new Set(notes)); draw();
        openMotifMenu(event.clientX, event.clientY, ref, currentLane); return;
      }
      const group = currentLane?.refBoxes?.[ref];
      if (!group?.anchors?.length || !canEditLane(currentLane)) return;
      const ordered = group.anchors.map((anchor, index) => ({anchor, index})).sort((a,b) => a.anchor-b.anchor);
      const position = Math.min(Number(occurrences.dataset.instance || 1) - 1, ordered.length - 1);
      const {anchor, index} = ordered[position];
      const o = occurrenceBox(group, index, laneClock(currentLane)), box = {...o, t0: Math.max(0, o.t0), t1: Math.min(S.state.duration, o.t1)};
      activateLane(currentLane); setSelection(new Set(notesInBox(box, currentLane.notes))); draw();
      openRefMenu(event.clientX, event.clientY, {lane: currentLane, group, ref, i: index}, {origin: 'artifact'});
    });
    // Double-click moves there, as Move to does (the name renames instead).
    row.addEventListener('dblclick', event => {
      if (event.target.closest('button:not(.artifact-reference-toggle), .artifact-name')) return;
      occurrences.querySelector('.artifact-jump').click();
    });
    // Drag onto the spectrogram to place another copy where it is dropped.
    row.draggable = true;
    row.addEventListener('dragstart', event => {
      if (kind === 'reference' && S.state?.editLanes.find(item => item.id === lane.id)?.refBoxes?.[ref]?.locked) {
        event.preventDefault(); return;
      }
      dragged = {kind, laneId: lane.id, ref, position: Number(occurrences.dataset.instance || 1) - 1};
      event.dataTransfer.effectAllowed = 'copy';
      // The stage preview is the feedback; no ghost of the row follows the pointer.
      event.dataTransfer.setDragImage(NO_DRAG_IMAGE, 0, 0);
      event.dataTransfer.setData('text/plain', name.textContent);
    });
    row.addEventListener('dragend', () => { dragged = null; clearDropPreview(); });
    row.append(occurrences); rows.set(rowKey, row); syncPitchLock(row, lane, ref);
    list.insertBefore(row, list.children[order] || null);
  }
  paintArtifactPreviews();
  renderMarkerArtifacts();
  renderRocksmithIssues();
}

// Transposition is enabled when occurrences may use independent pitch offsets.
function syncPitchLock(row, lane, ref) {
  const transpose = row.querySelector('.artifact-transpose');
  if (!transpose) return;
  const group = lane.refBoxes?.[ref], free = !!group?.transposable, locked = !!group?.locked;
  row.draggable = !locked;
  row.toggleAttribute('data-locked', locked);
  transpose.disabled = locked;
  if (transpose.dataset.free !== String(free)) {
    transpose.dataset.free = String(free);
    transpose.innerHTML = icon('transpose', 18);
    transpose.title = free ? 'Transposable: instances may be transposed independently. Click to use the same pitch' : 'Same pitch for all instances. Click to allow independent transposition';
    transpose.setAttribute('aria-label', 'Transposable');
    transpose.setAttribute('aria-pressed', String(free));
  }
  const protect = row.querySelector('.artifact-edit-lock');
  if (protect.dataset.locked !== String(locked)) {
    protect.dataset.locked = String(locked);
    protect.innerHTML = icon(locked ? 'lock' : 'unlock', 16);
    protect.title = locked ? 'Reference locked: all instances are protected. Click to allow edits' : 'Lock reference: protect all instances from moving, editing and deletion';
    protect.setAttribute('aria-pressed', String(locked));
  }
}

// The notes of a reference's displayed occurrence (with that occurrence's
// shift), or of a motif.
function artifactNotes({kind, lane, ref, position}) {
  if (kind === 'motif') return {notes: motifGroups(lane.notes).get(ref) || [], shift: 0};
  const group = lane.refBoxes?.[ref];
  if (!group?.anchors?.length) return {notes: [], shift: 0};
  const order = group.anchors.map((a, i) => i).sort((p, q) => group.anchors[p] - group.anchors[q]);
  const index = order[Math.min(position, order.length - 1)];
  return {notes: notesInBox(occurrenceBox(group, index, laneClock(lane)), lane.notes), shift: shiftOf(group, index)};
}

// A drop at world (x, y) puts the first note under the pointer. A motif keeps
// only its intervals, so it moves in pitch too; so does a reference whose pitch
// is not locked.
function dropPlacement(item, notes, x, y, lane) {
  const first = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)[0];
  const t = timeAt(x), dt = snap(Math.max(0, t));   // where the first note lands: the preview's key
  if (item.kind !== 'motif' && !lane.refBoxes?.[item.ref]?.transposable) return { t, dt, shift: 0 };
  const spec = S.state.spec, lo = Math.min(...notes.map(n => n.pitch)), hi = Math.max(...notes.map(n => n.pitch));
  const shift = Math.max(spec.midi_low - lo, Math.min(spec.midi_high - hi, Math.round(pitchAt(y)) - first.pitch));
  return { t, dt, shift };
}

// Where the drop would put the notes, worked out exactly as doPaste does:
// a reference keeps its shape, a copy snaps each note onto the grid.
function showDropPreview(item, x, y) {
  const lane = S.state?.editLanes.find(l => l.id === item.laneId);
  const { notes, shift: base } = lane ? artifactNotes({...item, lane}) : {};
  if (!notes?.length) return;
  const { dt, shift } = dropPlacement(item, notes, x, y, lane);
  const key = `${item.kind}:${item.laneId}:${item.ref}:${item.position}:${dt}:${shift}`;
  if (S.dropPreview?.key === key) return;
  // Exactly as doPaste will place them: in beats on this layer's grid.
  const placed = placeClip(clipOf(notes), lane, dropPlacement(item, notes, x, y, lane).t, item.kind === 'reference');
  const moved = notes.map((n, k) => ({ start: placed[k].start, end: placed[k].end, pitch: n.pitch + shift }));
  // A reference's new box is anchored at its earliest note, as linkPasteAsReference does.
  const group = item.kind === 'reference' && lane.refBoxes?.[item.ref];
  const at = group && Math.min(...moved.map(n => n.start));
  const box = group ? { ...spanAt(group, at, laneClock(lane)), pLo: group.pLo + base + shift, pHi: group.pHi + base + shift } : null;
  S.dropPreview = { key, kind: item.kind, color: lane.color, notes: moved, box,
    blocked: overlapsRefBox(lane, box || noteBounds(moved)) };
  draw();
}

function clearDropPreview() {
  if (!S.dropPreview) return;
  S.dropPreview = null; draw();
}

// Paste through the editor's own path (a reference as another linked occurrence,
// a motif as an independent copy), leaving the user's clipboard as it was.
async function dropArtifact(item, x, y) {
  const lane = S.state?.editLanes.find(l => l.id === item.laneId);
  const { notes, shift: base } = lane ? artifactNotes({...item, lane}) : {};
  if (!notes?.length || !canEditLane(lane)) return;
  const { t, shift } = dropPlacement(item, notes, x, y, lane);
  const saved = [S.clipboard, S.clipboardSrc, S.clipboardRef];
  try {
    activateLane(lane); setSelection(new Set(notes)); doCopy();
    await doPaste({mode: item.kind === 'reference' && S.clipboardRef ? 'reference' : 'copy', at: t, shift, refShift: base + shift});
  } finally { [S.clipboard, S.clipboardSrc, S.clipboardRef] = saved; }
}

export function init_artifacts() {
  // On the scroller, not the canvas: overlays above the canvas receive the events.
  scroll.addEventListener('dragover', event => {
    if (!dragged) return;
    event.preventDefault();
    showDropPreview(dragged, ...localXY(event));
    event.dataTransfer.dropEffect = S.dropPreview?.blocked ? 'none' : 'copy';
  });
  scroll.addEventListener('dragleave', event => {
    if (dragged && !scroll.contains(event.relatedTarget)) clearDropPreview();
  });
  scroll.addEventListener('drop', event => {
    if (!dragged) return;
    event.preventDefault();
    const item = dragged, blocked = S.dropPreview?.blocked; dragged = null; clearDropPreview();
    if (blocked) { toast('A reference cannot sit inside another reference'); return; }
    dropArtifact(item, ...localXY(event));
  });
  initArtifactsPanel();
  initMarkerArtifacts();
  initRocksmithIssues();
  for (const [toggleId, bodyId, name] of [['artifactReferencesToggle','artifactReferencesBody','references'],['artifactMotifsToggle','artifactMotifsBody','motifs']]) {
    $(toggleId).addEventListener('click', () => {
      const button = $(toggleId), body = $(bodyId);
      body.hidden = !body.hidden;
      if (body.hidden) stopArtifactPreview();
      button.setAttribute('aria-expanded', String(!body.hidden));
      button.title = `${body.hidden ? 'Expand' : 'Collapse'} ${name}`;
      button.setAttribute('aria-label', button.title);
    });
  }
  audio.addEventListener("play", stopArtifactPreview);
  window.addEventListener("cw-transport", event => { if (event.detail === "play") stopArtifactPreview(); });
  const clear = () => {
    clearMarkerArtifacts();
    resetArtifactPreviews(true); rows.clear(); collapsedArtifacts.clear(); $('artifactList').replaceChildren(); $('motifList').replaceChildren();
  };
  window.addEventListener('cw-project-opened', () => { clear(); renderArtifacts(); });
  window.addEventListener('cw-project-closed', clear);
  window.addEventListener('blur', stopArtifactPreview);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopArtifactPreview(); });
  renderArtifacts();
}
