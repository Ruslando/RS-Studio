import { paintNoteRow, paintTimeGridLine } from './timeline-paint.js';
import { $, scroll } from "./dom.js";
import { PAINT } from "./stage-paint.js";
import { dpr, playheadScrollLeft } from "./util.js";
import { stageMono } from "./constants.js";

let visible = false, frame = 0, activeMode = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let elapsed = 0, last = null;
const offsets = new Map();

function paint() {
  for (const canvas of document.querySelectorAll("canvas[data-scroll-preview]")) {
    const width = Math.max(200, canvas.clientWidth), height = 76, inset = 8;
    if (canvas.width !== Math.round(width * dpr()) || canvas.height !== Math.round(height * dpr())) {
      canvas.width = Math.round(width * dpr()); canvas.height = Math.round(height * dpr());
    }
    const ctx = canvas.getContext("2d"), viewport = width - 2 * inset;
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    const mode = canvas.dataset.scrollPreview;
    const time = mode === activeMode ? Math.min(elapsed % 8, 7) : 2, speed = 80;
    // Run the real paging rule at the editor's size, then shrink its result.
    // Applying its 60px edge margin directly to a thumbnail pages far too early.
    const referenceWidth = Math.max(viewport, scroll.clientWidth || window.innerWidth);
    const scale = viewport / referenceWidth;
    const left = playheadScrollLeft(time, speed / scale, referenceWidth, (viewport + 640) / scale,
      (offsets.get(mode) || 0) / scale, false, mode) * scale;
    offsets.set(mode, left);
    ctx.fillStyle = PAINT.ground; ctx.fillRect(0, 0, width, height);
    ctx.save(); ctx.beginPath(); ctx.rect(inset, 0, viewport, height); ctx.clip();
    ctx.translate(inset - left, 0);
    ctx.font = stageMono(9, 400); ctx.textAlign = "left";
    for (let beat = 0; beat < 48; beat++) {
      const x = beat * 20;
      paintTimeGridLine(ctx, x, 19, height, beat % 4 ? 'beat' : 'bar');
      if (!(beat % 4)) { ctx.fillStyle = PAINT.label; ctx.fillText(String(beat / 4 + 1), x + 3, 13); }
      if (!(beat % 2)) {
        const rowHeight = 12, row = [2, 1, 0, 1, 3, 2][beat / 2 % 6];
        paintNoteRow(ctx, x, 22 + row * rowHeight, beat % 6 ? 20 : 40, rowHeight, PAINT.ok);
      }
    }
    const head = time * speed;
    ctx.strokeStyle = PAINT.accent; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(head, 19); ctx.lineTo(head, height); ctx.stroke();
    ctx.restore();
    canvas.dataset.scroll = String(left);
    canvas.dataset.playhead = String(head - left);
    canvas.dataset.running = String(visible && activeMode === mode && !reducedMotion.matches && !document.hidden);
  }
}

export const refreshTimelineScrollPreview = () => { if (visible) paint(); };

function tick(now) {
  frame = 0;
  if (!visible || !activeMode || reducedMotion.matches || document.hidden) return;
  const before = elapsed % 8;
  elapsed += last == null ? 0 : Math.min(64, now - last) / 1000;
  last = now;
  if (elapsed % 8 < before) offsets.clear();
  paint(); frame = requestAnimationFrame(tick);
}

function stop() {
  cancelAnimationFrame(frame); frame = 0; last = null;
}

function start(mode) {
  stop(); activeMode = mode; elapsed = 0; offsets.clear();
  if (!visible) return;
  paint();
  if (mode && !reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(tick);
}

export function setTimelineScrollPreviewVisible(on) {
  visible = on; start(null);
  if (on) frame = requestAnimationFrame(() => { frame = 0; if (visible) paint(); });
  else for (const canvas of document.querySelectorAll('canvas[data-scroll-preview]')) canvas.dataset.running = 'false';
}

export function initTimelineScrollPreview() {
  for (const canvas of document.querySelectorAll('canvas[data-scroll-preview]')) {
    const card = canvas.closest('label');
    card.addEventListener('mouseenter', () => start(canvas.dataset.scrollPreview));
    card.addEventListener('mouseleave', () => start(null));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); if (visible) paint(); }
    else if (visible) {
      const hovered = [...document.querySelectorAll('canvas[data-scroll-preview]')].find(canvas => canvas.closest('label').matches(':hover'));
      start(hovered?.dataset.scrollPreview || null);
    }
  });
  reducedMotion.addEventListener('change', () => start(activeMode));
}
