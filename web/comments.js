// Free comments on the spectrogram. Each sits at a grid time and a pitch row
// (S.state.comments: { id, t, pitch, text }), belongs to the song rather than a
// layer, and is listed under Artifacts (marker-artifacts.js).
import { paintMarkerFlag } from './canvas-components.js';
import { stageUi } from './constants.js';
import { $, scroll, sctx, stage } from './dom.js';
import { commit, snapshotEdit, STATE_RESTORED } from './edit.js';
import { pitchAt, timeAt, xOf, yOf } from './geometry.js';
import { snap } from './grid.js';
import { placeFloating } from './floating-position.js';
import { registerEscapeLayer, ESC_DEPTH } from './escape-stack.js';
import { refreshSaveState } from './project.js';
import { draw } from './repaint.js';
import { PAINT } from './stage-paint.js';
import { S } from './store.js';

const H = 20, MAX_W = 220;
let rects = [], editing = null;

export function normalizeComments(list) {
  return (Array.isArray(list) ? list : [])
    .filter(c => c && Number.isFinite(+c.t) && Number.isFinite(+c.pitch))
    .map(c => ({ id: String(c.id || `comment_${Math.random().toString(36).slice(2)}`), t: +c.t, pitch: Math.round(+c.pitch), text: String(c.text || '') }));
}
const comments = () => (S.state.comments ||= []);
const clampTime = t => Math.max(0, Math.min(Number(S.state.duration) || Infinity, snap(Math.max(0, t))));
const toCanvas = (clientX, clientY) => {
  const r = stage.getBoundingClientRect();
  return [clientX - r.left + scroll.scrollLeft, clientY - r.top + scroll.scrollTop];
};
export const commentAt = (x, y) => rects.findLast(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)?.comment || null;

export function drawComments() {
  rects = [];
  if (!S.state?.comments?.length) return;
  const left = scroll.scrollLeft, right = left + scroll.clientWidth;
  sctx.save();
  sctx.font = stageUi(11, 600); sctx.textBaseline = 'middle';
  for (const comment of S.state.comments) {
    let label = comment.text.split('\n')[0] || 'Comment';
    const fits = s => sctx.measureText(s).width + 18 <= MAX_W;
    if (!fits(label)) { while (label && !fits(label + '…')) label = label.slice(0, -1); label += '…'; }
    const x = xOf(comment.t), y = yOf(comment.pitch) + S.state.rowH / 2 - H / 2;
    const rect = { comment, x0: x, x1: x + Math.ceil(sctx.measureText(label).width) + 18, y0: y, y1: y + H };
    rects.push(rect);
    if (rect.x0 > right || rect.x1 < left) continue;
    paintMarkerFlag(sctx, rect, PAINT.comment);
    sctx.fillStyle = PAINT.text;
    sctx.fillText(label, x + 9, y + H / 2);
  }
  sctx.restore();
}

export const commentCursorAt = (x, y) => (commentAt(x, y) ? 'grab' : null);

// Drag moves a comment along the grid and between pitch rows; a click opens it.
export function commentMouseDown(event) {
  if (!S.state || event.button !== 0) return false;
  const [x0, y0] = toCanvas(event.clientX, event.clientY);
  const comment = commentAt(x0, y0);
  if (!comment) return false;
  event.preventDefault();
  const prev = snapshotEdit(), t0 = comment.t, p0 = comment.pitch;
  let moved = false;
  const onMove = e => {
    const [x, y] = toCanvas(e.clientX, e.clientY);
    comment.t = clampTime(t0 + timeAt(x) - timeAt(x0));
    const { midi_low: lo, midi_high: hi } = S.state.spec;
    comment.pitch = Math.max(lo, Math.min(hi, p0 + pitchAt(y) - pitchAt(y0)));
    moved ||= comment.t !== t0 || comment.pitch !== p0;
    stage.style.cursor = 'grabbing';
    draw();
  };
  const onUp = e => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (moved) commit(prev); else openCommentPop(e.clientX, e.clientY, comment);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  return true;
}

export function addCommentAt(clientX, clientY) {
  if (!S.state) return;
  const [x, y] = toCanvas(clientX, clientY);
  const prev = snapshotEdit();
  const comment = { id: `comment_${Date.now()}`, t: clampTime(timeAt(x)), pitch: pitchAt(y), text: '' };
  comments().push(comment);
  commit(prev);
  openCommentPop(clientX, clientY, comment);
}

export function openCommentPop(clientX, clientY, comment) {
  closeCommentPop();
  editing = comment;
  $('commentText').value = comment.text;
  $('commentPop').hidden = false;
  placeFloating($('commentPop'), clientX, clientY);
  $('commentText').focus({ preventScroll: true });
}

// Closing an empty comment removes it, so a stray "Add comment" leaves nothing.
export function closeCommentPop() {
  if ($('commentPop').hidden) return false;
  $('commentPop').hidden = true;
  const comment = editing; editing = null;
  if (comment && !comment.text.trim()) removeComment(comment);
  return true;
}

function removeComment(comment) {
  if (!S.state?.comments?.includes(comment)) return;
  const prev = snapshotEdit();
  S.state.comments = S.state.comments.filter(c => c !== comment);
  commit(prev);
}

export function initComments() {
  $('commentText').addEventListener('input', () => {
    if (!editing) return;
    editing.text = $('commentText').value;
    refreshSaveState(); draw();
  });
  // Typing must not trigger editor shortcuts or playback.
  $('commentPop').addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation(); });
  $('commentPopClose').addEventListener('click', closeCommentPop);
  $('commentDelete').addEventListener('click', () => {
    const comment = editing; editing = null;
    $('commentPop').hidden = true;
    if (comment) removeComment(comment);
  });
  registerEscapeLayer(ESC_DEPTH.popover, closeCommentPop);
  // Undo replaced the comment objects; let go without deleting anything.
  window.addEventListener(STATE_RESTORED, () => { editing = null; $('commentPop').hidden = true; });
  window.addEventListener('cw-project-closed', () => { editing = null; $('commentPop').hidden = true; });
}
