// Explicit fretting-hand anchors. `handHolds` remains the persisted field used
// by existing projects and the voicing engine; the UI calls them Hand anchors.
import { $, scroll, stage, sctx, mmctx } from './dom.js';
import { S } from './store.js';
import { stageMono } from './constants.js';
import { activeLane, canEditLane } from './lanes.js';
import { handColumnAt, laneHandColumns, refreshTabIfOpen } from './tablature.js';
import { snap } from './grid.js';
import { timingIdOf, withTiming } from './timing.js';
import { xOf, timeAt } from './geometry.js';
import { registerMarkerRail, railBand, inRailBand } from './marker-rails.js';
import { paintMarkerFlag } from './canvas-components.js';
import { PAINT } from './stage-paint.js';
import { STATE_RESTORED, snapshotEdit, commit } from './edit.js';
import { draw } from './repaint.js';
import { refreshSaveState } from './project.js';
import { placeFloating } from './floating-position.js';
import { toast } from './notify.js';
import { ESC_DEPTH, registerEscapeLayer } from './escape-stack.js';

const RAIL = 'hand-anchor', HEIGHT = 20;
let rects = [], editAnchor = null, editLaneId = null, popSnapshot = null;
const editingLane = () => S.state?.editLanes.find(lane => lane.id === editLaneId);
const shownLane = () => { const lane = S.state ? activeLane() : null; return lane?.visible ? lane : null; };
const sameTime = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-6;
const stillEditing = lane => canEditLane(lane) && lane.handHolds?.includes(editAnchor);
const localPoint = event => {
  const rect = stage.getBoundingClientRect();
  return [event.clientX - rect.left + scroll.scrollLeft, event.clientY - rect.top + scroll.scrollTop];
};

function snapAnchorTime(time, lane) {
  return withTiming(timingIdOf(lane), () => {
    const limit = Number(S.state.duration) || Number(S.state.scoreDuration) || Infinity;
    const t = Math.max(0, Math.min(limit, Number(time)));
    return Math.max(0, Math.min(limit, snap(t)));
  });
}

function changed() { refreshSaveState(); draw(); refreshTabIfOpen(); }

export function closeHandAnchorPop() {
  // Focus left on a hidden control would swallow the next shortcut (Ctrl+Z).
  if ($('handAnchorPop').contains(document.activeElement)) document.activeElement.blur();
  $('handAnchorPop').hidden = true;
  const previous = popSnapshot;
  popSnapshot = null; editAnchor = null; editLaneId = null;
  if (previous) { commit(previous); changed(); }
}

export function openHandAnchorPop(clientX, clientY, anchor, lane) {
  closeHandAnchorPop();
  if (!canEditLane(lane) || !lane.handHolds?.includes(anchor)) return;
  editAnchor = anchor; editLaneId = lane.id;
  fillFrets(lane, anchor);
  $('handAnchorTime').value = String(+Number(anchor.t).toFixed(3));
  $('handAnchorTime').max = String(S.state.duration || S.state.scoreDuration);
  $('handAnchorPop').hidden = false;
  placeFloating($('handAnchorPop'), clientX, clientY);
  $('handAnchorFret').querySelector('[aria-checked="true"]')?.focus();
}

// THE FRETS THIS ANCHOR CAN BE: the hands that can play its note or chord
// (laneHandColumns), so an unreachable one cannot be chosen. Its own fret stays on
// offer while it is still chosen, however it came about.
function fillFrets(lane, anchor) {
  const choices = handColumnAt(laneHandColumns(lane, { now: true }), anchor.t)?.choices || [];
  const frets = [...new Set([...choices, Number(anchor.fret)])].sort((a, b) => a - b);
  $('handAnchorFret').replaceChildren(...frets.map(fret => {
    const button = document.createElement('button');
    button.type = 'button'; button.setAttribute('role', 'radio');
    button.dataset.value = String(fret); button.textContent = String(fret);
    button.setAttribute('aria-checked', String(fret === Number(anchor.fret)));
    button.disabled = !choices.includes(fret) && fret !== Number(anchor.fret);
    return button;
  }));
}

// Whether a hand on `fret` can play the note or chord an anchor at `t` belongs to.
// Unknown while the lane's fingering is still being worked out: allowed, and the
// rail shows it once it is known.
function reaches(lane, t, fret, now = false) {
  const column = handColumnAt(laneHandColumns(lane, { now }), t);
  return !column || column.choices.includes(Number(fret));
}

function applyFields(fretValue = null) {
  const lane = editingLane();
  if (!stillEditing(lane)) return;
  const timeInput = $('handAnchorTime');
  if (!timeInput.checkValidity()) return;
  const fret = fretValue ?? Number(editAnchor.fret), time = Number(timeInput.value);
  if (timeInput.value === '' || !Number.isFinite(time) || !Number.isInteger(fret)) return;
  const t = snapAnchorTime(time, lane);
  if (!reaches(lane, t, fret, true)) {
    timeInput.value = String(+Number(editAnchor.t).toFixed(3));
    toast(`A hand on fret ${fret} cannot reach the note there`); return;
  }
  if (lane.handHolds.some(anchor => anchor !== editAnchor && sameTime(anchor.t, t))) {
    timeInput.value = String(+Number(editAnchor.t).toFixed(3));
    toast('A hand anchor already exists at this beat'); return;
  }
  timeInput.value = String(+t.toFixed(3));
  if (sameTime(editAnchor.t, t) && editAnchor.fret === fret) return;
  if (!popSnapshot) popSnapshot = snapshotEdit();
  editAnchor.t = t; editAnchor.fret = fret;
  lane.handHolds.sort((a, b) => a.t - b.t);
  fillFrets(lane, editAnchor);
  // Fingering previews must respond before this editor session is committed.
  S.voicingRevision++;
  changed();
}

function anchorAt(event) {
  const [x, y] = localPoint(event);
  if (!inRailBand(RAIL, y - scroll.scrollTop)) return null;
  return rects.find(rect => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) || null;
}

function mouseDown(event) {
  if (event.button !== 0) return false;
  const hit = anchorAt(event);
  if (!hit || !canEditLane(hit.lane)) return false;
  event.preventDefault();
  closeHandAnchorPop();
  const {anchor, lane} = hit, [startX] = localPoint(event);
  const delta = timeAt(startX) - anchor.t;
  let previous = null;
  const move = event => {
    const [x] = localPoint(event), t = snapAnchorTime(timeAt(x) - delta, lane);
    if (sameTime(t, anchor.t) || lane.handHolds.some(other => other !== anchor && sameTime(other.t, t))) return;
    if (!reaches(lane, t, anchor.fret)) return;       // only onto notes this hand can play
    if (!previous) previous = snapshotEdit();
    anchor.t = t; lane.handHolds.sort((a, b) => a.t - b.t);
    S.voicingRevision++; changed();
  };
  const up = event => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    if (previous) { commit(previous); changed(); }
    else openHandAnchorPop(event.clientX, event.clientY, anchor, lane);
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  return true;
}

function drawAnchors() {
  rects = [];
  const lane = shownLane();
  if (!lane) return;
  const top = scroll.scrollTop + railBand(RAIL).y;
  sctx.save(); sctx.font = stageMono(11, 500); sctx.textAlign = 'left'; sctx.textBaseline = 'middle';
  const columns = laneHandColumns(lane);
  for (const anchor of lane.handHolds || []) {
    // One that no longer reaches its note (the note changed under it) says so.
    const column = handColumnAt(columns, anchor.t);
    const lost = !!column && !column.choices.includes(Number(anchor.fret));
    const label = `Fret ${Math.round(anchor.fret)}${lost ? " · can't reach" : ""}`, x = xOf(anchor.t);
    const width = Math.ceil(sctx.measureText(label).width) + 14;
    if (x > scroll.scrollLeft + scroll.clientWidth || x + width < scroll.scrollLeft) continue;
    const rect = {anchor, lane, x0:x, x1:x + width, y0:top + 2, y1:top + HEIGHT - 2};
    rects.push(rect);
    paintMarkerFlag(sctx, rect, lost ? PAINT.error : lane.color || PAINT.accent);
    sctx.fillStyle = PAINT.text; sctx.fillText(label, x + 7, top + HEIGHT / 2);
  }
  sctx.restore();
}

export function init_hand_anchors() {
  registerEscapeLayer(ESC_DEPTH.popover, () => {
    if ($('handAnchorPop').hidden) return false;
    if ($('handAnchorPop').contains(document.activeElement)) document.activeElement.blur();
    closeHandAnchorPop(); return true;
  });
  registerMarkerRail({
    id: RAIL, height: HEIGHT, count: () => shownLane()?.handHolds?.length || 0,
    draw: drawAnchors, mouseDown,
    cursorAt: (x, y) => inRailBand(RAIL, y - scroll.scrollTop) && rects.some(rect =>
      canEditLane(rect.lane) && x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) ? 'grab' : null,
    contextMenu: event => {
      const hit = anchorAt(event);
      if (!hit) return false;
      openHandAnchorPop(event.clientX, event.clientY, hit.anchor, hit.lane); return true;
    },
    drawMinimap: scale => {
      const lane = shownLane();
      for (const anchor of lane?.handHolds || []) {
        mmctx.fillStyle = lane.color || PAINT.accent; mmctx.fillRect(xOf(anchor.t) * scale - 1, 36, 3, 5);
      }
    },
  });
  $('handAnchorFret').addEventListener('click', event => {
    const button = event.target.closest('[data-value]');
    if (button && !button.disabled) applyFields(Number(button.dataset.value));
  });
  $('handAnchorTime').addEventListener('change', () => applyFields());
  $('handAnchorPopClose').addEventListener('click', closeHandAnchorPop);
  $('handAnchorDelete').addEventListener('click', () => {
    const lane = editingLane();
    if (!stillEditing(lane)) return;
    if (!popSnapshot) popSnapshot = snapshotEdit();
    lane.handHolds = lane.handHolds.filter(anchor => anchor !== editAnchor);
    closeHandAnchorPop();
  });
  for (const name of [STATE_RESTORED, 'cw-project-opened', 'cw-project-closed']) window.addEventListener(name, () => {
    popSnapshot = null; closeHandAnchorPop();
  });
}
