import { paintNoteBar } from './canvas-components.js';
import { PAINT } from './stage-paint.js';

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
