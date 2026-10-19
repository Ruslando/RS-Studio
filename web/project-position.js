import { $, scroll, stage } from './dom.js';
import { S } from './store.js';
import { projectShiftPlan, projectStart } from './project-position-core.js';
import { restoreGridState } from './grid.js';
import { SONG, timingData } from './timing.js';
import { commitStructure, snapshotEdit, undo, redo, STATE_RESTORED } from './edit.js';
import { draw, drawNow } from './repaint.js';
import { layout, timeAt, xOf } from './geometry.js';
import { closeMarkerPop } from './markers.js';
import { closeSectionMarkerPop, sectionMarkersChanged } from './section-markers.js';
import { closeToneMarkerPop } from './tone-markers.js';
import { closePhraseMarkerPop } from './phrase-markers.js';
import { closeHandAnchorPop } from './hand-anchors.js';
import { clearMatches } from './tracing.js';
import { refreshTabIfOpen } from './tablature.js';
import { updateAutoScroll } from './interaction.js';

const handle = $('projectStartHandle');
const readout = handle.querySelector('output');
const handleWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s-panel'));
const startGap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s-row'));
let gesture = null;

function timingPlan() {
  const ids = new Set([SONG, S.state.liveTiming || SONG, ...Object.keys(S.state.timings || {})]);
  const timings = [...ids].map(timingData);
  const live = timings[[...ids].indexOf(S.state.liveTiming || SONG)];
  return { plan: projectShiftPlan(S.state, timings), live };
}

export function syncProjectStartHandle() {
  if (!S.state || !S.state.spec) { handle.hidden = true; return; }
  const x = xOf(projectStart(S.state));
  handle.hidden = x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth;
  // The line sits before every start marker; the marker timestamps stay exact.
  // The viewer gutter keeps it reachable even when the project starts at zero.
  handle.style.left = `${scroll.offsetLeft + x - scroll.scrollLeft - startGap - handleWidth / 2}px`;
  handle.style.top = `${scroll.offsetTop}px`;
  handle.style.height = `${S.stageHeight}px`;
  readout.value = `Start ${projectStart(S.state).toFixed(3)} s`;
  handle.setAttribute('aria-label', `Project start: ${projectStart(S.state).toFixed(3)} seconds. Move entire project`);
}

function applyPosition(edit, delta) {
  delta = Math.max(edit.plan.min, Math.min(edit.plan.max, delta));
  edit.plan.apply(delta);
  restoreGridState(edit.live.grid);
  S.state.baseGrid = { ...timingData(SONG).grid };
  S.voicingRevision++;
  sectionMarkersChanged();
  if (!S.state.stems.length) layout();
  readout.hidden = false;
  edit.delta = delta;
  drawNow();
}

export function updateProjectStartAt(x) {
  if (!gesture || S.state !== gesture.state) return;
  if (!gesture.prev && Math.abs(x - gesture.x0) < 3) return;
  if (!gesture.prev) gesture.prev = snapshotEdit();
  applyPosition(gesture, Math.round(timeAt(x - gesture.x0) * 1000) / 1000);
}

function finish(cancel = false) {
  if (!gesture) return;
  const edit = gesture;
  gesture = null;
  S.drag = null;
  if (S.autoScrollRaf) cancelAnimationFrame(S.autoScrollRaf);
  S.autoScrollRaf = 0; S.autoScrollVel = 0;
  document.body.classList.remove('col-resizing');
  handle.classList.remove('is-dragging');
  if (handle.hasPointerCapture(edit.pointer)) handle.releasePointerCapture(edit.pointer);
  if (S.state === edit.state && edit.prev) {
    if (cancel) applyPosition(edit, 0);
    else if (Math.abs(edit.delta || 0) > 1e-9) commitStructure(edit.prev, { translation: edit.delta });
    refreshTabIfOpen();
  }
  readout.hidden = true;
  handle.blur();
  draw();
}

function closeEditors() {
  closeMarkerPop(); closeSectionMarkerPop(); closeHandAnchorPop();
  closeToneMarkerPop(); closePhraseMarkerPop(); clearMatches();
}

export function init_project_position() {
  const point = event => {
    const box = handle.getBoundingClientRect();
    const at = Math.max(14, Math.min(box.height - 14, event.clientY - box.top));
    handle.style.setProperty('--at', `${at}px`);
    handle.style.setProperty('--readout-at', `${Math.min(box.height - 28, at + 18)}px`);
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !S.state || S.drag) return;
    event.preventDefault();
    closeEditors();
    point(event);
    gesture = { mode: 'projectStart', state: S.state, pointer: event.pointerId,
      x0: event.clientX - stage.getBoundingClientRect().left + scroll.scrollLeft, ...timingPlan() };
    S.drag = gesture;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    document.body.classList.add('col-resizing');
  });
  handle.addEventListener('pointermove', event => {
    point(event);
    if (gesture) {
      S.lastPointerX = event.clientX; S.lastPointerY = event.clientY;
      updateProjectStartAt(event.clientX - stage.getBoundingClientRect().left + scroll.scrollLeft);
      updateAutoScroll(event.clientX);
    }
  });
  handle.addEventListener('pointerup', () => finish());
  handle.addEventListener('pointercancel', () => finish(true));
  handle.addEventListener('lostpointercapture', () => finish(true));
  handle.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
        event.preventDefault(); event.stopPropagation();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) redo(); else undo();
      }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !S.state) return;
    event.preventDefault(); event.stopPropagation();
    closeEditors();
    const edit = { ...timingPlan(), prev: snapshotEdit() };
    applyPosition(edit, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .1 : .01));
    if (Math.abs(edit.delta) > 1e-9) commitStructure(edit.prev, { translation: edit.delta });
    readout.hidden = true;
    refreshTabIfOpen();
  });
  window.addEventListener('keydown', event => {
    const cancelUndo = (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
    if (gesture && (event.key === 'Escape' || cancelUndo)) {
      event.preventDefault(); event.stopImmediatePropagation(); finish(true);
    }
  }, true);
  window.addEventListener('blur', () => finish(true));
  window.addEventListener(STATE_RESTORED, () => { readout.hidden = true; draw(); });
  // The region before the origin has no editing gestures or context menus.
  for (const type of ['mousedown', 'dblclick', 'contextmenu', 'mousemove']) stage.addEventListener(type, event => {
    if (!S.state || S.drag) return;
    const t = timeAt(event.clientX - stage.getBoundingClientRect().left + scroll.scrollLeft);
    if (t >= projectStart(S.state) - 1e-9) return;
    if (type !== 'mousemove') event.preventDefault();
    event.stopImmediatePropagation();
    stage.style.cursor = 'not-allowed';
    S.mouseX = S.mouseY = null; S.hoverNote = null;
    draw();
  }, true);
}
