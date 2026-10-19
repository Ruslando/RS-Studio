import { stageUi } from './constants.js';
import { PAINT, halo } from './stage-paint.js';
import { edgeSlide } from './spectrogram-labels.js';

export const NOTE_LABEL_SIZE = 12;
export const NOTE_LABEL_SIZES = [10, 12, 14, 16];
export function noteLabelSize() {
  const size = Number(document.getElementById('noteLabelSize')?.value);
  return NOTE_LABEL_SIZES.includes(size) ? size : NOTE_LABEL_SIZE;
}

export function paintNoteLabel(ctx, text, x, width, y) {
  if (!text) return;
  ctx.save();
  ctx.font = stageUi(noteLabelSize(), 600);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 2.5; ctx.strokeStyle = halo(); ctx.fillStyle = PAINT.text;
  ctx.strokeText(text, x + width / 2, y);
  ctx.fillText(text, x + width / 2, y);
  ctx.restore();
}

export function paintSlideLabel(ctx, slide, x0, x1, y) {
  const mark = edgeSlide(slide);
  if (mark) paintNoteLabel(ctx, mark.glyph, mark.side === 'left' ? x0 - 9 : x1 + 9, 0, y);
}
