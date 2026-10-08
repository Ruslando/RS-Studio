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

const noteGlass = new WeakMap();
export function beginNoteGlassFrame(ctx) {
  const current = noteGlass.get(ctx);
  if (current) current.ready = false;
}

function noteBackdrop(ctx, blur) {
  let cached = noteGlass.get(ctx);
  if (!cached) {
    const canvas = document.createElement("canvas");
    const painter = canvas.getContext("2d");
    if (!painter) return ctx.canvas;
    cached = {canvas, painter, ready: false};
    noteGlass.set(ctx, cached);
  }
  if (!cached.ready) {
    const {canvas, painter} = cached;
    if (canvas.width !== ctx.canvas.width) canvas.width = ctx.canvas.width;
    if (canvas.height !== ctx.canvas.height) canvas.height = ctx.canvas.height;
    painter.clearRect(0, 0, canvas.width, canvas.height);
    painter.filter = `blur(${blur}px)`;
    painter.drawImage(ctx.canvas, 0, 0);
    cached.ready = true;
  }
  return cached.canvas;
}

export function paintNoteBar(ctx, x, y, width, height, color, selected = false, hovered = false, emphasis = 0) {
  const radius = Math.min(2, width / 2, height / 2);
  ctx.save();
  rectangle(ctx, x, y, width, height, radius);
  // Frost the actual backdrop inside the note silhouette, preserving layer tint.
  ctx.save();
  ctx.clip();
  const transform = ctx.getTransform();
  const blur = 2.5 * Math.abs(transform.a), padding = blur * 2;
  const backdrop = noteBackdrop(ctx, blur);
  const sx = Math.max(0, Math.floor(x * transform.a + transform.e - padding));
  const sy = Math.max(0, Math.floor(y * transform.d + transform.f - padding));
  const sw = Math.min(ctx.canvas.width - sx, Math.ceil(width * Math.abs(transform.a) + padding * 2));
  const sh = Math.min(ctx.canvas.height - sy, Math.ceil(height * Math.abs(transform.d) + padding * 2));
  if (sw > 0 && sh > 0) {
    ctx.resetTransform();
    if (backdrop === ctx.canvas) ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(backdrop, sx, sy, sw, sh, sx, sy, sw, sh);
  }
  ctx.restore();
  ctx.fillStyle = hexA(PAINT.chrome, .42); ctx.fill();
  ctx.fillStyle = hexA(color, selected ? .50 : hovered ? .40 : .28); ctx.fill();
  const sheen = ctx.createLinearGradient(x, y, x, y + height);
  sheen.addColorStop(0, hexA(PAINT.text, .18));
  sheen.addColorStop(1, hexA(PAINT.text, .015));
  ctx.fillStyle = sheen; ctx.fill();
  rectangle(ctx, x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1), radius);
  // A dark outer keyline survives bright spectral peaks; the inner edge keeps
  // layer identity readable even when labels are too small to render.
  ctx.lineWidth = 3.5; ctx.strokeStyle = hexA(PAINT.ink, 0.94); ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = selected ? PAINT.accent : hovered ? PAINT.text : color; ctx.stroke();
  if (emphasis > 0) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(PAINT.text, emphasis * .65); ctx.stroke();
  }
  // The attack edge preserves the layer identity at dense zoom levels.
  ctx.fillStyle = color;
  ctx.fillRect(x + 0.5, y + 1, Math.min(2, width - 0.5), Math.max(1, height - 2));
  ctx.restore();
}

export function paintMarkerFlag(ctx, rect, color) {
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
  ctx.strokeStyle = hexA(color, 0.65); ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}
