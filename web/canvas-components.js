// Visual primitives for data on the themed musical workspace.
// Timing/pitch bounds, hit tests and musical meanings remain feature-owned.
import { PAINT } from './stage-paint.js';
import { hexA } from './util.js';

const glowStyle = getComputedStyle(document.documentElement);
const glowRadius = parseFloat(glowStyle.getPropertyValue('--note-glow-radius'));
const glowStrength = parseFloat(glowStyle.getPropertyValue('--note-glow-strength'));
const glowEdge = parseFloat(glowStyle.getPropertyValue('--note-glow-edge'));

// Paint the current note silhouette before its body. Shadows never reach labels.
export function paintNoteGlow(ctx, level, bodyWidth = 0) {
  if (level <= 0) return;
  ctx.save();
  ctx.globalAlpha *= level * glowStrength;
  ctx.shadowColor = PAINT.text; ctx.shadowBlur = glowRadius;
  ctx.strokeStyle = PAINT.text; ctx.lineWidth = bodyWidth + glowEdge; ctx.stroke();
  ctx.restore();
}

function rectangle(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, width, height, Math.max(0, radius));
  else ctx.rect(x, y, width, height);
}

const selectionPatterns = new WeakMap();
export function noteSelectionFill(ctx) {
  const key = `${PAINT.paper}:${PAINT.ink}`;
  let cached = selectionPatterns.get(ctx);
  if (cached?.key !== key) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 8;
    const paint = tile.getContext('2d');
    paint.fillStyle = PAINT.paper; paint.fillRect(0, 0, 8, 8);
    paint.strokeStyle = PAINT.ink; paint.lineWidth = 1.25;
    paint.beginPath();
    for (const x of [-8, 0, 8]) { paint.moveTo(x, 0); paint.lineTo(x + 8, 8); }
    paint.stroke();
    cached = { key, pattern: ctx.createPattern(tile, 'repeat') };
    selectionPatterns.set(ctx, cached);
  }
  return cached.pattern;
}

// Stroke the current silhouette with light and dark edges. Neither edge relies
// on the layer colour, and selection stays opaque even on dimmed/bent notes.
// For ribbons, pass their body width and repaint the coloured centre afterward.
export function paintNoteSelection(ctx, bodyWidth = 0) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = PAINT.ink; ctx.lineWidth = bodyWidth + 4; ctx.stroke();
  ctx.strokeStyle = PAINT.paper; ctx.lineWidth = bodyWidth + 1.5; ctx.stroke();
  ctx.restore();
}

export function paintNoteBar(ctx, x, y, width, height, color, selected = false, hovered = false, emphasis = 0) {
  if (selected) {
    // A screen-space selection envelope stays readable when pitch rows shrink.
    // It changes only painting, never the note's pitch, duration or hit target.
    const visibleHeight = Math.max(6, height);
    y -= (visibleHeight - height) / 2;
    height = visibleHeight;
    ctx.save(); ctx.globalAlpha = 1;
    const radius = Math.min(2, width / 2, height / 2);
    rectangle(ctx, x + .5, y + .5, Math.max(1, width - 1), height - 1, radius);
    paintNoteSelection(ctx);
    // Paint inside the edge afterward: otherwise its dark backing swallows
    // the pattern completely on short rows.
    rectangle(ctx, x + 1.25, y + 1.25, Math.max(0, width - 2.5), height - 2.5, Math.min(1, radius));
    ctx.fillStyle = noteSelectionFill(ctx); ctx.fill();
    ctx.restore();
    return;
  }
  const radius = Math.min(2, width / 2, height / 2);
  ctx.save();
  rectangle(ctx, x, y, width, height, radius);
  // Glass-like tint without sampling or blurring the stage behind every note.
  // These flat layers are cheap enough to redraw during playback and dragging.
  ctx.fillStyle = hexA(PAINT.chrome, .72); ctx.fill();
  ctx.fillStyle = hexA(color, hovered ? .62 : .50); ctx.fill();
  ctx.strokeStyle = hexA(PAINT.text, .20); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x + 1, y + 1); ctx.lineTo(x + Math.max(1, width - 1), y + 1); ctx.stroke();
  rectangle(ctx, x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1), radius);
  // A dark outer keyline survives bright spectral peaks; the inner edge keeps
  // layer identity readable even when labels are too small to render.
  ctx.lineWidth = 3.5; ctx.strokeStyle = hexA(PAINT.ink, 0.94); ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = hovered ? PAINT.text : color; ctx.stroke();
  if (hovered) {
    rectangle(ctx, x - 1, y - 1, width + 2, height + 2, radius + 1);
    ctx.lineWidth = 2; ctx.strokeStyle = PAINT.text; ctx.stroke();
  }
  if (emphasis > 0) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(PAINT.text, emphasis * .65); ctx.stroke();
  }
  // The attack edge preserves the layer identity at dense zoom levels.
  ctx.fillStyle = color;
  ctx.fillRect(x + 0.5, y + 1, Math.min(2, width - 0.5), Math.max(1, height - 2));
  ctx.restore();
}

export function paintWarningSymbol(ctx, x, y, size) {
  ctx.save();
  ctx.strokeStyle = PAINT.warn; ctx.fillStyle = PAINT.warn; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x + size / 2, y); ctx.lineTo(x + size, y + size);
  ctx.lineTo(x, y + size); ctx.closePath(); ctx.stroke();
  ctx.fillRect(x + size / 2 - .5, y + 3, 1, 3);
  ctx.fillRect(x + size / 2 - .5, y + 7.5, 1, 1);
  ctx.restore();
}

// dashed: a flag that is only proposed (the export's, until you take it over).
export function paintMarkerFlag(ctx, rect, color, { dashed = false } = {}) {
  const { x0: x, y0: y, x1, y1 } = rect;
  const width = x1 - x, height = y1 - y;
  ctx.save();
  rectangle(ctx, x, y, width, height, 4);
  // Blur only the pixels behind this flag. Clip in world coordinates before
  // sampling the existing canvas in device pixels; labels are painted later.
  ctx.save();
  ctx.clip();
  const transform = ctx.getTransform();
  const blur = 3 * Math.abs(transform.a), padding = blur * 2;
  const sx = Math.max(0, Math.floor(x * transform.a + transform.e - padding));
  const sy = Math.max(0, Math.floor(y * transform.d + transform.f - padding));
  const sw = Math.min(ctx.canvas.width - sx, Math.ceil(width * transform.a + padding * 2));
  const sh = Math.min(ctx.canvas.height - sy, Math.ceil(height * transform.d + padding * 2));
  if (sw > 0 && sh > 0) {
    ctx.resetTransform(); ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(ctx.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
  }
  ctx.restore();
  ctx.fillStyle = hexA(PAINT.chrome, 0.55); ctx.fill();
  ctx.fillStyle = hexA(color, 0.10); ctx.fill();
  const sheen = ctx.createLinearGradient(x, y, x, y + height);
  sheen.addColorStop(0, hexA(PAINT.text, 0.12));
  sheen.addColorStop(1, hexA(PAINT.text, 0));
  ctx.fillStyle = sheen; ctx.fill();
  rectangle(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 4);
  ctx.strokeStyle = hexA(color, dashed ? 0.9 : 0.65); ctx.lineWidth = 1;
  if (dashed) ctx.setLineDash([3, 2]);
  ctx.stroke();
  ctx.restore();
}

// A small padlock, 7×9, its top-left at (x, y): a mark that cannot be moved.
export function paintLock(ctx, x, y, color) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x + 3.5, y + 3.5, 2.2, Math.PI, 0); ctx.lineTo(x + 5.7, y + 4.5);
  ctx.moveTo(x + 1.3, y + 4.5); ctx.lineTo(x + 1.3, y + 3.5); ctx.stroke();
  ctx.fillRect(x, y + 4.5, 7, 4.5);
  ctx.restore();
}
