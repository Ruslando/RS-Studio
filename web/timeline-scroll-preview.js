import { $, scroll } from "./dom.js";
import { UI_PAINT as PAINT } from "./stage-paint.js";
import { dpr, playheadScrollLeft } from "./util.js";
import { stageMono } from "./constants.js";

let visible = false, frame = 0, paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    const time = Math.min(elapsed % 8, 7), speed = 80;
    const mode = canvas.dataset.scrollPreview;
    // Run the real paging rule at the editor's size, then shrink its result.
    // Applying its 60px edge margin directly to a thumbnail pages far too early.
    const referenceWidth = Math.max(viewport, scroll.clientWidth || window.innerWidth);
    const scale = viewport / referenceWidth;
    const left = playheadScrollLeft(time, speed / scale, referenceWidth, (viewport + 640) / scale,
      (offsets.get(mode) || 0) / scale, false, mode) * scale;
    offsets.set(mode, left);
    ctx.fillStyle = PAINT.chrome; ctx.fillRect(0, 0, width, height);
    ctx.save(); ctx.beginPath(); ctx.rect(inset, 0, viewport, height); ctx.clip();
    ctx.translate(inset - left, 0);
    ctx.font = stageMono(9, 400); ctx.textAlign = "left";
    for (let beat = 0; beat < 48; beat++) {
      const x = beat * 20;
      ctx.strokeStyle = beat % 4 ? PAINT.gridBeat : PAINT.gridBar;
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 19); ctx.lineTo(x, height); ctx.stroke();
      if (!(beat % 4)) { ctx.fillStyle = PAINT.label; ctx.fillText(String(beat / 4 + 1), x + 3, 13); }
      if (!(beat % 2)) {
        ctx.fillStyle = PAINT.ok;
        ctx.beginPath(); ctx.roundRect(x + 3, 28 + (beat / 2 % 3) * 12, beat % 6 ? 25 : 34, 5, 2); ctx.fill();
      }
    }
    const head = time * speed;
    ctx.strokeStyle = PAINT.accent; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(head, 19); ctx.lineTo(head, height); ctx.stroke();
    ctx.fillStyle = PAINT.accent;
    ctx.beginPath(); ctx.moveTo(head - 4, 17); ctx.lineTo(head + 4, 17); ctx.lineTo(head, 22); ctx.closePath(); ctx.fill();
    ctx.restore();
    canvas.dataset.scroll = String(left);
    canvas.dataset.playhead = String(head - left);
    canvas.dataset.running = String(visible && !paused);
  }
}

export const refreshTimelineScrollPreview = () => { if (visible) paint(); };

function tick(now) {
  frame = 0;
  if (!visible || paused) return;
  const before = elapsed % 8;
  elapsed += last == null ? 0 : Math.min(64, now - last) / 1000;
  last = now;
  if (elapsed % 8 < before) offsets.clear();
  paint(); frame = requestAnimationFrame(tick);
}

export function setTimelineScrollPreviewVisible(on) {
  visible = on;
  cancelAnimationFrame(frame); frame = 0; last = null;
  if (on) {
    elapsed = 0; offsets.clear(); paint();
    frame = requestAnimationFrame(paused ? () => { frame = 0; if (visible) paint(); } : tick);
  } else for (const canvas of document.querySelectorAll("canvas[data-scroll-preview]")) canvas.dataset.running = "false";
}

export function initTimelineScrollPreview() {
  const button = $("timelineScrollPreviewToggle");
  const sync = () => {
    button.textContent = paused ? "Play previews" : "Pause previews";
    button.setAttribute("aria-pressed", String(!paused));
  };
  button.addEventListener("click", () => {
    paused = !paused; sync(); last = null;
    cancelAnimationFrame(frame); frame = 0; paint();
    if (visible && !paused) frame = requestAnimationFrame(tick);
  });
  document.addEventListener("visibilitychange", () => { last = null; });
  sync();
}
