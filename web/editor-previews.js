import { $ } from './dom.js';
import { paintNoteRow, paintTimeGridLine } from './timeline-paint.js';
import { S } from './store.js';
import { noteMarks } from './note-effects.js';
import { paintNoteLabel, paintSlideLabel } from './note-label-paint.js';
import { resolveNoteAppearance, spectrogramLabel, spectrogramLabelOptions } from './spectrogram-labels.js';
import { PAINT } from './stage-paint.js';
import { dpr } from './util.js';
import { drawFretboardSettingsPreview } from './fretboard.js';
import { notePreviewLayout } from './editor-preview-layout.js';

let noteHover = -1, boardFrame = 0, boardStart = null, boardHover = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function drawNoteAppearancePreview() {
  const canvas = $('noteAppearancePreview');
  if (!canvas) return;
  const width = Math.max(260, canvas.clientWidth || 420), height = 128, dp = dpr();
  canvas.width = Math.round(width * dp); canvas.height = Math.round(height * dp);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dp, 0, 0, dp, 0, 0);
  ctx.fillStyle = PAINT.ground; ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = 1; ctx.strokeStyle = PAINT.gridBeat;
  const layout = notePreviewLayout(width, S.state?.rowH || 12);
  for (let beat = 0; beat * layout.cellWidth < width; beat++)
    paintTimeGridLine(ctx, beat * layout.cellWidth, 0, height, beat % 4 ? 'beat' : 'bar');
  const options = spectrogramLabelOptions();
  for (let i = 0; i < 2; i++) {
    const { x, y, width: span, height: rowHeight } = layout.notes[i], hovered = i === noteHover;
    const note = { pitch: [64, 67][i], slide: ['inBelow', 'outUp'][i], fx: { palmMute: i === 1 } };
    const { mode, effects } = resolveNoteAppearance(options, hovered);
    paintNoteRow(ctx, x, y, span, rowHeight, S.state?.lanes.find(lane => lane.active)?.color || PAINT.ok, false, hovered);
    const label = spectrogramLabel(note, { string: 1, fret: [5, 8][i] }, mode, effects ? noteMarks(note) : [], options.fromNut ? 2 : 0);
    paintNoteLabel(ctx, label, x, span, y + rowHeight / 2);
    if (effects) paintSlideLabel(ctx, note.slide, x, x + span, y + rowHeight / 2);
  }
}

function boardTick(now) {
  boardFrame = 0;
  const canvas = $('fretboardSettingsPreview');
  if (!boardHover || document.hidden || canvas.closest('[hidden]') || reducedMotion.matches) return;
  boardStart ??= now;
  drawFretboardSettingsPreview(1.5 + (now - boardStart) / 1000);
  boardFrame = requestAnimationFrame(boardTick);
}

function resetBoard() {
  cancelAnimationFrame(boardFrame); boardFrame = 0; boardStart = null;
  const canvas = $('fretboardSettingsPreview');
  if (canvas.closest('[hidden]') || !canvas.matches(':hover')) boardHover = false;
  drawFretboardSettingsPreview(1.5);
  if (boardHover && !document.hidden && !reducedMotion.matches)
    boardFrame = requestAnimationFrame(boardTick);
}

export function refreshEditorPreviews() {
  const note = $('noteAppearancePreview');
  if (!note.matches(':hover') && document.activeElement !== note) noteHover = -1;
  drawNoteAppearancePreview(); resetBoard();
}

export function initEditorPreviews() {
  const note = $('noteAppearancePreview'), board = $('fretboardSettingsPreview');
  note.addEventListener('mousemove', event => {
    const rect = note.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const layout = notePreviewLayout(Math.max(260, note.clientWidth || 420), S.state?.rowH || 12);
    noteHover = layout.notes.findIndex(rect => x >= rect.x - 14 && x <= rect.x + rect.width + 14 && y >= rect.y && y <= rect.y + rect.height);
    drawNoteAppearancePreview();
  });
  note.addEventListener('mouseleave', () => { noteHover = -1; drawNoteAppearancePreview(); });
  note.addEventListener('focus', () => { noteHover = 1; drawNoteAppearancePreview(); });
  note.addEventListener('blur', () => { noteHover = -1; drawNoteAppearancePreview(); });
  board.addEventListener('mouseenter', () => { boardHover = true; resetBoard(); });
  board.addEventListener('mouseleave', () => { boardHover = false; resetBoard(); });
  document.addEventListener('visibilitychange', resetBoard);
  reducedMotion.addEventListener('change', resetBoard);
  new ResizeObserver(refreshEditorPreviews).observe($('spTrace'));
  refreshEditorPreviews();
}
