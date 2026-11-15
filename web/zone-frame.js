import { stageUi } from './constants.js';
import { fitChordName, layoutChordName } from './chord-name-ranges.js';

export const ZONE_PADDING = 6;
const labels = new WeakMap();

export function beginZoneLabels(ctx, occupied = []) {
  labels.set(ctx, [...occupied]);
}

export function reserveZoneLabels(ctx, rectangles) {
  if (!labels.has(ctx)) beginZoneLabels(ctx);
  labels.get(ctx).push(...rectangles.filter(Boolean));
}

export function zoneLabelAt(ctx, x, y) {
  return labels.get(ctx)?.find(rect => rect.title && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h);
}

// All zone kinds use this same edge tolerance for their visual hover state.
// Owners may interpret the returned sides as resize handles or merely use it
// to brighten their frame.
export function zoneFrameEdge({ x, y, width, height }, pointerX, pointerY, tolerance = 5) {
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)
    || pointerX < x - tolerance || pointerX > x + width + tolerance
    || pointerY < y - tolerance || pointerY > y + height + tolerance) return '';
  return (Math.abs(pointerY - y) <= tolerance ? 't' : Math.abs(pointerY - (y + height)) <= tolerance ? 'b' : '')
    + (Math.abs(pointerX - x) <= tolerance ? 'l' : Math.abs(pointerX - (x + width)) <= tolerance ? 'r' : '');
}

// Every zone uses the same silhouette. Bounds and interactions stay with its
// owner, so rounding a reference never changes which notes it captures.
export function paintZoneFrame(ctx, { x, y, width, height, color, fill = null, emphasized = false }) {
  if (!(width > 0 && height > 0)) return;
  ctx.save();
  ctx.beginPath();
  const radius = Math.min(6, width / 2, height / 2);
  if (ctx.roundRect) ctx.roundRect(x, y, width, height, radius);
  else ctx.rect(x, y, width, height);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.strokeStyle = color; ctx.lineWidth = emphasized ? 2 : 1.25;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.restore();
}

export function paintZoneLabel(ctx, { title, x0, x1, y0, left, right, top = 0, color, halo, reserveRight = 0 }) {
  if (!labels.has(ctx)) beginZoneLabels(ctx);
  ctx.save();
  ctx.font = stageUi(11, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  const measure = text => ctx.measureText(text).width;
  // A short zone still needs a readable type/name. Captions use the available
  // viewport width; the shared rows keep neighboring captions separate.
  const start = Math.max(x0 + 3, left + 3), end = right - 3 - reserveRight;
  const name = fitChordName(title, end - start - 6, measure);
  const placement = layoutChordName({ name, chords: [{}] }, {
    left: start, right: end, y: y0 - 1, top,
  }, measure, labels.get(ctx));
  if (!placement) { ctx.restore(); return null; }
  ctx.setLineDash([]); ctx.lineJoin = 'round';
  ctx.strokeStyle = halo; ctx.lineWidth = 3; ctx.strokeText(placement.name, placement.x, placement.y);
  ctx.fillStyle = color; ctx.fillText(placement.name, placement.x, placement.y);
  ctx.restore();
  const rect = { ...placement.labelBox, baseline: placement.y, text: placement.name, title };
  reserveZoneLabels(ctx, [rect]);
  return rect;
}
