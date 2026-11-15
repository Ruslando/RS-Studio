import { stageUi } from './constants.js';
import { PAINT, halo } from './stage-paint.js';
import { edgeSlide } from './spectrogram-labels.js';

const NOTE_LABEL_SIZE = 12;
const NOTE_LABEL_SIZES = [10, 12, 14, 16];
function noteLabelSize() {
  const size = Number(document.getElementById('noteLabelSize')?.value);
  return NOTE_LABEL_SIZES.includes(size) ? size : NOTE_LABEL_SIZE;
}

export function paintNoteLabel(ctx, text, x, width, y, height = Infinity, availableWidth = width) {
  if (!text) return;
  ctx.save();
  const preferred = noteLabelSize();
  ctx.font = stageUi(preferred, 600);
  const measured = ctx.measureText(text).width;
  // A note name has one configured, readable size. It either fits within the
  // note body or is omitted; scaling it down makes neighboring names look like
  // a different kind of annotation and is harder to read than no label.
  if (height < preferred + 4 || availableWidth < measured + 6) { ctx.restore(); return; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 2.5; ctx.strokeStyle = halo(); ctx.fillStyle = PAINT.text;
  ctx.strokeText(text, x + width / 2, y);
  ctx.fillText(text, x + width / 2, y);
  ctx.restore();
}

// A label just outside x on `side`, so it names a point without covering the note.
export function paintNoteLabelBeside(ctx, text, x, side, y, height, availableWidth) {
  if (!text) return;
  ctx.save(); ctx.font = stageUi(noteLabelSize(), 600);
  const half = ctx.measureText(text).width / 2 + 5; ctx.restore();
  paintNoteLabel(ctx, text, x + (side === 'left' ? -half : half), 0, y, height, availableWidth);
}

export function paintSlideLabel(ctx, slide, x0, x1, y, height = Infinity) {
  const mark = edgeSlide(slide);
  if (mark) paintNoteLabel(ctx, mark.glyph, mark.side === 'left' ? x0 - 9 : x1 + 9, 0, y, height, Math.abs(x1 - x0));
}
