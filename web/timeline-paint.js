import { paintNoteBar } from './canvas-components.js';
import { PAINT, veil } from './stage-paint.js';
import { STAGE_ANCHORED, stageMono } from './constants.js';

// Shared row geometry for the editor and settings examples.
export function paintNoteRow(ctx, x, y, width, rowHeight, color, selected = false, hovered = false, emphasis = 0, reveal = 0) {
  const inset = Math.min(2, rowHeight * .12) * (1 - reveal);
  paintNoteBar(ctx, x, y + inset, width, rowHeight - 2 * inset, color, selected, hovered, emphasis);
}

export function paintTimeGridLine(ctx, x, top, bottom, kind) {
  ctx.strokeStyle = kind === 'bar' ? PAINT.gridBar : kind === 'beat' ? PAINT.gridBeat : PAINT.gridSub;
  ctx.lineWidth = kind === 'bar' ? 2 : 1;
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
}

// A bar's number on a chip, just right of its bar line, sitting on `bottom`.
// Returns the x where the next number may start, so callers can skip a crowded one.
export function paintBarNumber(ctx, x, bottom, label) {
  ctx.save();
  ctx.font = stageMono(STAGE_ANCHORED); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  const w = ctx.measureText(label).width;
  ctx.fillStyle = veil(); ctx.fillRect(x + 2, bottom - 11, w + 4, 12);
  ctx.fillStyle = PAINT.label; ctx.fillText(label, x + 4, bottom);
  ctx.restore();
  return x + w + 10;
}
