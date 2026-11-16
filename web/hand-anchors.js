// Editable saved hand changes and derived slide positions on the anchor rail.
import { scroll, sctx, stage, mmctx as minimapCtx } from './dom.js';
import { S, setSelection } from './store.js';
import { stageMono } from './constants.js';
import { activeLane, canEditLane } from './lanes.js';
import { laneFretCount } from './lane-tuning.js';
import { timeAt, xOf } from './geometry.js';
import { isMarkerSelected, markerKey, registerMarkerRail, railBand, setMarkerSelection } from './marker-rails.js';
import { paintMarkerFlag } from './canvas-components.js';
import { PAINT } from './stage-paint.js';
import { laneFingering, laneFingeringKey } from './lane-fingering.js';
import { slideHandChanges } from './hand-anchor-core.js';
import { gridAt } from './grid-read.js';
import { chordColumns, handChoices, handProfileForTuning } from './voicing-core.js';
import { draw } from './repaint.js';
import { moveHandAnchor, setHandAnchor } from './edit.js';
import { laneFretTuning } from './lane-tuning.js';
import { nearestHandStart } from './hand-anchor-state.js';
import { openDiagnosticMenu } from './editor-menu.js';
import { ESC_DEPTH, registerEscapeLayer } from './escape-stack.js';

const RAIL = 'hand-anchor', HEIGHT = 20;
const shownLane = () => { const lane = S.state ? activeLane() : null; return lane?.visible ? lane : null; };

// Flags come from saved changes; asynchronous fingering refreshes conflict hints.
const cache = new WeakMap();
let rects = [], dragging = null;
function changesOf(lane) {
  if (!lane) return { saved: [], slides: [] };
  const key = `${laneFingeringKey(lane)}:f${S.fingerRevision || 0}`;
  let entry = cache.get(lane);
  if (entry?.key !== key) {
    entry?.controller.abort();
    entry = { key, controller: new AbortController() };
    cache.set(lane, entry);
    laneFingering(lane, entry.controller.signal).then(found => {
      if (cache.get(lane) !== entry) return;
      entry.found = found;
      entry.slides = slideHandChanges(found.notes, found.seats, found.voiced,
        t => 30 / (gridAt(t)?.bpm || 120));
      draw();
    }).catch(() => {});
  }
  return { saved: lane.handHolds || [], slides: entry.slides || [] };
}

function drawAnchors() {
  rects = [];
  const lane = shownLane();
  if (!lane) return;
  const top = scroll.scrollTop + railBand(RAIL).y;
  const problems = new Set(lane._handConflicts?.values() || []);
  sctx.save(); sctx.font = stageMono(11, 500); sctx.textAlign = 'left'; sctx.textBaseline = 'middle';
  const { saved, slides } = changesOf(lane);
  const drawFlag = (marker, derived = false) => {
    const t = dragging?.lane === lane && dragging.id === marker.id ? dragging.time : marker.t;
    const problem = !derived && problems.has(marker.id);
    const label = `${Math.round(marker.fret)}${problem ? ' !' : ''}`, x = xOf(t);
    const width = Math.ceil(sctx.measureText(label).width) + 14;
    const rect = { marker, lane, x0: x, x1: x + width, y0: top + 2, y1: top + HEIGHT - 2 };
    if (!derived) rects.push(rect);
    if (x > scroll.scrollLeft + scroll.clientWidth || x + width < scroll.scrollLeft) return;
    paintMarkerFlag(sctx, rect, problem ? PAINT.warn : lane.color || PAINT.accent,
      { dashed: derived, selected: !derived && isMarkerSelected(RAIL, marker.id) });
    sctx.fillStyle = PAINT.text; sctx.fillText(label, x + 7, top + HEIGHT / 2);
  };
  for (const marker of saved) drawFlag(marker);
  for (const marker of slides) drawFlag(marker, true);
  sctx.restore();
}

const hitAt = (x, y) => rects.find(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
function point(event) {
  const rect = stage.getBoundingClientRect();
  return [event.clientX - rect.left + scroll.scrollLeft, event.clientY - rect.top + scroll.scrollTop];
}

function choicesAt(lane, time) {
  const found = cache.get(lane)?.found;
  const notes = found?.notes || lane.notes;
  const column = chordColumns(notes).find(c => c.t0 >= time - 1e-6);
  if (!column) return [];
  const shape = new Map(column.notes.flatMap(note => {
    const position = found?.voiced.get(note) || note.pos;
    return position ? [[note, position]] : [];
  }));
  return handChoices(shape, handProfileForTuning(laneFretTuning(lane)), laneFretCount(lane) - 3);
}

function exceedsSoftLimit(lane, time, seat) {
  const found = cache.get(lane)?.found;
  const notes = found?.notes || lane.notes;
  const column = chordColumns(notes).find(c => c.t0 >= time - 1e-6);
  return !!column?.notes.some(note => {
    const fret = (found?.voiced.get(note) || note.pos)?.fret;
    return fret > 0 && fret - seat > 3;
  });
}

function menu(hit, event) {
  const { lane, marker } = hit, first = lane.handHolds?.[0]?.id === marker.id;
  const change = value => {
    const live = lane.handHolds?.find(h => h.id === marker.id);
    if (live) setHandAnchor(lane, live.t, value);
    if (!lane.handHolds?.some(h => h.id === marker.id)) setMarkerSelection([]);
  };
  const choices = new Set(choicesAt(lane, marker.t));
  choices.add(marker.fret);
  openDiagnosticMenu(event.clientX, event.clientY, [
    { label: first ? 'Initial hand position' : 'Hand position', children:
      [...choices].sort((a, b) => a - b).map(fret => ({
        label: `${marker.fret === fret ? '✓ ' : ''}${fret}`,
        note: exceedsSoftLimit(lane, marker.t, fret) ? 'Exceeds 4-fret soft limit' : '',
        disabled: !canEditLane(lane),
        fn: () => change(fret),
      })) },
    { label: 'Delete hand change', disabled: first || !canEditLane(lane),
      tip: first ? 'The initial value stays at the first note. Change its value instead.' : '',
      fn: () => change(null) },
  ]);
}

function cancelDrag() {
  if (!dragging) return false;
  const cleanup = dragging.cleanup;
  dragging = null; cleanup(); draw(); return true;
}

function mouseDown(event) {
  if (event.button !== 0 || dragging) return false;
  const hit = hitAt(...point(event));
  if (!hit) return false;
  event.preventDefault();
  if (!canEditLane(hit.lane)) return true;
  setSelection(new Set()); setMarkerSelection([markerKey(RAIL, hit.marker.id)]);
  const { lane, marker } = hit, first = lane.handHolds[0].id === marker.id;
  const offset = timeAt(point(event)[0]) - marker.t;
  const state = { lane, id: marker.id, time: marker.t, moved: false, cleanup: () => {} };
  const move = e => {
    if (dragging !== state || first) return;
    const time = nearestHandStart(lane.notes, timeAt(point(e)[0]) - offset);
    if (time == null || time <= lane.handHolds[0].t + 1e-6) return;
    state.time = time; state.moved = time !== marker.t; draw();
  };
  const up = e => {
    if (dragging !== state) return;
    dragging = null; state.cleanup();
    if (shownLane() !== lane) { draw(); return; }
    if (state.moved) {
      moveHandAnchor(lane, marker.id, state.time);
      if (!lane.handHolds.some(h => h.id === marker.id)) setMarkerSelection([]);
    }
    else menu(hit, e);
    draw();
  };
  state.cleanup = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    window.removeEventListener('blur', cancelDrag);
  };
  dragging = state;
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  window.addEventListener('blur', cancelDrag); draw(); return true;
}

export function init_hand_anchors() {
  registerEscapeLayer(ESC_DEPTH.popover + 1, cancelDrag);
  window.addEventListener('cw-project-closed', cancelDrag);
  window.addEventListener('cw-project-opened', cancelDrag);
  window.addEventListener('cw-state-restored', cancelDrag);
  registerMarkerRail({
    id: RAIL, height: HEIGHT, count: () => {
      const { saved, slides } = changesOf(shownLane());
      return saved.length + slides.length;
    },
    draw: drawAnchors, mouseDown,
    flags: () => rects.map(r => ({ ...r, kind: RAIL, key: r.marker.id, t: r.marker.t })),
    cursorAt: (x, y) => {
      const hit = hitAt(x, y);
      return hit && canEditLane(hit.lane) ? hit.marker === hit.lane.handHolds[0] ? 'pointer' : 'grab' : null;
    },
    tipAt: (x, y) => {
      const hit = hitAt(x, y);
      if (!hit) return null;
      const problem = [...(hit.lane._handConflicts?.values() || [])].includes(hit.marker.id);
      return { title: `Hand position ${hit.marker.fret}`, tone: problem ? 'warning' : 'note',
        body: problem ? 'Some notes or chosen fingers cannot use this hand. Change the hand, fingers or note positions.'
          : hit.marker === hit.lane.handHolds[0] ? 'Initial value. Click to edit; it stays at the first note.'
            : 'Applies until the next hand change. Drag to a note or chord start; click to edit or delete.' };
    },
    contextMenu: event => {
      const hit = hitAt(...point(event));
      if (!hit) return false;
      event.preventDefault(); menu(hit, event); return true;
    },
    drawMinimap: (at, mmctx = minimapCtx) => {
      const lane = shownLane();
      const { saved, slides } = changesOf(lane);
      for (const anchor of [...saved, ...slides]) {
        mmctx.fillStyle = lane.color || PAINT.accent; mmctx.fillRect(at(anchor.t) - 1, 36, 3, 5);
      }
    },
  });
}
