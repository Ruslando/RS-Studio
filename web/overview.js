// The overview: a time ruler over a whole-song minimap (spectrogram, notes,
// markers, a window and the playhead). The editor's timeline and the Rocksmith
// export's preview clip are each one of these; the host says what its time,
// its window and a drag in its body mean.
//
// Ruler and headroom (the strip above the spectrogram) scrub the playhead, the
// arrow keys on the ruler nudge it, and the time label takes a typed time.
import { MM_HEAD, stageMono } from "./constants.js";
import { drawMinimapMarkers } from "./markers.js";
import { overviewMarkerRails } from "./marker-rails.js";
import { intensityRevision, paintIntensity } from "./spectrogram-intensity.js";
import { PAINT, UI_PAINT, wash } from "./stage-paint.js";
import { S } from "./store.js";
import { createOverviewTime, formatTimelineTime } from "./timeline-time.js";
import { dpr } from "./util.js";

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * ruler, map: canvases. time: { root, button, input } of the time label.
 * seek(t, phase): phase is "scrub" (dragging), "end" (drag released) or "jump".
 * frame(): the window as { t0, t1, y0, y1 } (seconds; 0..1 of the band), or null.
 * bodyDown(t): a drag in the spectrogram as { move(t, moved), up(t, moved) };
 *   null (or no bodyDown) scrubs like the headroom. moved: past 3 px.
 * getLead(): seconds of silence shown before 0, as the editor's leading silence.
 */
export function createOverview({ ruler, map, time, getTime, seek, getImage = () => S.spectImg,
  getDuration = () => S.state?.duration || 0, getLead = () => 0, frame = () => null, bodyDown = null,
  bodyCursor = () => "pointer", onDrag = () => {} }) {
  const rulerCtx = ruler.getContext("2d"), ctx = map.getContext("2d");
  // Downscaling the full spectrogram is the expensive part, so it is cached and
  // rebuilt only when its inputs change; a frame blits it and draws the rest.
  const backdrop = document.createElement("canvas"), backdropCtx = backdrop.getContext("2d");
  let backdropKey = "", backdropImg = null, seeking = false;
  // Song time <-> overview px, the silence before 0 included.
  const span = () => Math.max(1e-6, getDuration() + getLead());
  const xAt = (t, width) => (t + getLead()) / span() * width;
  const clock = createOverviewTime({ ...time, getProject: () => S.state, getTime, onSeek: (t) => seek(t, "jump") });

  function drawRuler(width, dp) {
    const height = ruler.height / dp, duration = getDuration() || 1, lead = getLead();
    rulerCtx.setTransform(dp, 0, 0, dp, 0, 0);
    rulerCtx.fillStyle = UI_PAINT.toolbar; rulerCtx.fillRect(0, 0, width, height);
    // Labels remain readable as the panel width and song duration change.
    const desired = (duration + lead) / Math.max(1, Math.floor(width / 80));
    const power = 10 ** Math.floor(Math.log10(desired));
    const step = [1, 2, 5, 10].map(value => value * power).find(value => value >= desired);
    rulerCtx.font = stageMono(11); rulerCtx.fillStyle = UI_PAINT.label;
    rulerCtx.textBaseline = "top"; rulerCtx.strokeStyle = UI_PAINT.line; rulerCtx.lineWidth = 1;
    for (let i = 0; i * step / 5 <= duration; i++) {
      const t = i * step / 5, x = xAt(t, width), major = i % 5 === 0;
      rulerCtx.beginPath(); rulerCtx.moveTo(x + .5, height); rulerCtx.lineTo(x + .5, height - (major ? 4 : 2)); rulerCtx.stroke();
      if (major) {
        const label = formatTimelineTime(t, step < 1);
        rulerCtx.fillText(label, Math.max(2, Math.min(width - rulerCtx.measureText(label).width - 2, x + 3)), 1);
      }
    }
    const now = getTime(), x = xAt(now, width);
    rulerCtx.strokeStyle = UI_PAINT.accent;
    rulerCtx.beginPath(); rulerCtx.moveTo(x + .5, 0); rulerCtx.lineTo(x + .5, height); rulerCtx.stroke();
    clock.sync(now, duration, width, x);
    ruler.setAttribute("aria-valuemax", String(duration));
    ruler.setAttribute("aria-valuenow", String(+now.toFixed(3)));
    ruler.setAttribute("aria-valuetext", formatTimelineTime(now, true));
  }

  function draw() {
    if (!S.state?.spec) { clock.sync(0, 0, 0); return; }
    const dp = dpr(), W = map.width / dp, H = map.height / dp;
    if (W < 1 || H < 1) return;
    drawRuler(W, dp);
    ctx.setTransform(dp, 0, 0, dp, 0, 0);
    const OY = MM_HEAD, CH = H - OY;    // the spectrogram band sits below the headroom
    const image = getImage();
    // Built at device resolution, so the blit is 1:1 (no resample blur).
    const lead = getLead();
    const key = `${map.width}x${Math.round(CH * dp)}:${lead}:${image?.naturalWidth}:${S.state.viewIntensity || [0, 100]}:${intensityRevision()}`;
    if (key !== backdropKey || image !== backdropImg) {
      backdrop.width = map.width; backdrop.height = Math.round(CH * dp);
      backdropCtx.fillStyle = PAINT.ground; backdropCtx.fillRect(0, 0, backdrop.width, backdrop.height);
      const x0 = Math.round(xAt(0, backdrop.width));   // the silence stays bare ground
      if (image?.naturalWidth) paintIntensity(backdropCtx, image, 0, 0, image.width, image.height, x0, 0,
        backdrop.width - x0, backdrop.height, ...(S.state.viewIntensity || [0, 100]));
      backdropKey = key; backdropImg = image;
    }
    ctx.fillStyle = UI_PAINT.toolbar; ctx.fillRect(0, 0, W, OY);
    ctx.strokeStyle = PAINT.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, OY + 0.5); ctx.lineTo(W, OY + 0.5); ctx.stroke();
    ctx.drawImage(backdrop, 0, 0, backdrop.width, backdrop.height, 0, OY, W, CH);

    const at = (t) => xAt(t, W);
    const { midi_high: high, midi_low: low } = S.state.spec, rh = CH / (high - low + 1);
    for (const lane of S.state.lanes) {
      if (!lane.visible) continue;
      ctx.fillStyle = lane.color;
      for (const n of lane.notes) {
        const x = at(n.start);
        ctx.fillRect(x, OY + (high - n.pitch) * rh, Math.max(1, at(n.end) - x), Math.max(1, rh));
      }
    }

    const win = frame();
    if (win) {
      const rx = at(win.t0), rw = Math.min(W - rx, at(win.t1) - rx);
      const ry = OY + win.y0 * CH, rhWin = Math.min(H - ry, (win.y1 - win.y0) * CH);
      ctx.fillStyle = wash(PAINT.text); ctx.fillRect(rx, ry, rw, rhWin);
      ctx.strokeStyle = PAINT.text; ctx.lineWidth = 1.5;
      ctx.strokeRect(rx + 0.75, ry + 0.75, Math.max(1, rw - 1.5), Math.max(1, rhWin - 1.5));
      ctx.lineWidth = 1;
    }

    drawMinimapMarkers(at, ctx);   // tempo/meter flags in the headroom
    for (const rail of overviewMarkerRails()) rail.drawMinimap?.(at, ctx);

    // Playhead: a full-height line and, in the headroom, the pin you drag.
    const ph = at(getTime());
    ctx.strokeStyle = PAINT.accent;
    ctx.beginPath(); ctx.moveTo(ph, OY); ctx.lineTo(ph, H); ctx.stroke();
    ctx.fillStyle = seeking ? PAINT.text : PAINT.accent;
    ctx.beginPath(); ctx.moveTo(ph - 5, 1); ctx.lineTo(ph + 5, 1); ctx.lineTo(ph, OY - 1); ctx.closePath(); ctx.fill();
  }

  const timeAtX = (clientX) => {
    const r = map.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width) * span() - getLead();   // the playhead may stand in the silence
  };

  // Window listeners, as before: a drag keeps going outside the canvas.
  function track(e, move, up) {
    const x0 = e.clientX;
    let moved = false;
    const onMove = (ev) => { moved ||= Math.abs(ev.clientX - x0) > 3; move(timeAtX(ev.clientX), moved); };
    const onUp = (ev) => {
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      up(timeAtX(ev.clientX), moved);
    };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  }

  function scrub(e) {
    seeking = true; onDrag(true, false);
    seek(timeAtX(e.clientX), "scrub");
    track(e, (t) => seek(t, "scrub"), (t) => { seeking = false; onDrag(false, false); seek(t, "end"); draw(); });
  }

  ruler.addEventListener("mousedown", (e) => {
    if (!S.state || e.button !== 0) return;
    e.preventDefault(); ruler.focus();
    scrub(e);
  });
  ruler.addEventListener("keydown", (e) => {
    if (!S.state || e.ctrlKey || e.metaKey || e.altKey) return;
    const delta = e.shiftKey ? 1 : .1, now = getTime(), end = getDuration(), start = -getLead();
    const target = e.key === "ArrowLeft" ? now - delta : e.key === "ArrowRight" ? now + delta
      : e.key === "Home" ? 0 : e.key === "End" ? end : null;
    if (target === null) return;
    e.preventDefault(); e.stopPropagation();
    seek(Math.max(start, Math.min(end, target)), "jump");
  });
  map.addEventListener("mousedown", (e) => {
    if (!S.state || e.button !== 0) return;
    e.preventDefault();   // no text or drag selection
    const head = e.clientY - map.getBoundingClientRect().top < MM_HEAD;
    const body = head ? null : bodyDown?.(timeAtX(e.clientX));
    if (!body) { scrub(e); return; }
    onDrag(false, true);
    track(e, body.move, (t, moved) => { onDrag(false, false); body.up(t, moved); });
  });
  map.addEventListener("mousemove", (e) => {
    if (e.buttons) return;
    const head = e.clientY - map.getBoundingClientRect().top < MM_HEAD;
    map.style.cursor = head ? "ew-resize" : bodyCursor(timeAtX(e.clientX));
  });

  // Size both canvases to their boxes; the minimap is `height` CSS px tall.
  function fit(height) {
    const dp = dpr();
    map.style.height = height + "px";   // CSS box == drawn size, so the pin isn't squished
    const w = Math.max(1, Math.round(map.clientWidth * dp)), h = Math.round(height * dp);
    if (map.width !== w) map.width = w;
    if (map.height !== h) map.height = h;
    const rh = Math.round(ruler.clientHeight * dp);
    if (ruler.width !== w) ruler.width = w;
    if (ruler.height !== rh) ruler.height = rh;
  }

  return { draw, fit };
}
