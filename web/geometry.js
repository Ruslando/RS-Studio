// World-pixel coordinate mapping (time/pitch <-> px across the whole song) and
// the two independent zoom axes. All drawing and mouse logic works in these world
// coordinates; draw() shifts by scrollLeft for the viewport.

import { MINIMAP_H, MM_HEAD, PX_PER_SEC, ZOOM_MAX_X, ZOOM_MAX_Y, ZOOM_MIN_X, ZOOM_MIN_Y, ZOOM_STEP } from "./constants.js";
import { $, minimap, overviewRuler, ruler, rulerRight, scroll, stage, stageSpacer, viewer, zoomResetBtn } from "./dom.js";
import { draw } from "./repaint.js";
import { S } from "./store.js";
import { clamp, dpr } from "./util.js";

// ---- coordinate mapping ----
// Drawing/mouse logic works in "world" pixels: x = time * PX_PER_SEC across the
// whole song. The stage canvas is only viewport-sized though, so draw() shifts
// world space by -scrollLeft and clientToCanvas adds scrollLeft back — keeping
// every other coordinate in world space exactly as before virtualization.
export const xOf = (t) => t * S.pxPerSec;

export const timeAt = (x) => x / S.pxPerSec;

export const songWidth = () => Math.max(1, Math.ceil(S.state.duration * S.pxPerSec)); // full-song px width

export const contentH = () => S.stageHeight * S.zoomY;   // full pitch-range height (== rowH * rowCount)

export const rowCount = () => S.state.spec.midi_high - S.state.spec.midi_low + 1;

export const rowOf = (pitch) => S.state.spec.midi_high - pitch;

export const yOf = (pitch) => rowOf(pitch) * S.state.rowH;

// The pitch axis: every visible row shares the stage height, scaled by the
// vertical zoom. Called whenever the stage resizes, a lane is added or removed,
// or zoomY changes — everything below is derived from S.state.rowH.
export function syncRowHeight() {
  if (S.state && S.state.spec) S.state.rowH = (S.stageHeight / rowCount()) * S.zoomY;
}

export function pitchAt(y) {
  const p = S.state.spec.midi_high - Math.floor(y / S.state.rowH);
  return Math.max(S.state.spec.midi_low, Math.min(S.state.spec.midi_high, p));
}

export function layout() {
  // A hidden spectrogram reports a zero-sized viewport while tablature is open.
  // Never turn that transient measurement into a 1px canvas that has to recover
  // on the next view switch.
  // Prime the ruler's fixed width before reading the remaining flex space. The
  // CSS declaration normally handles this; doing it here too prevents the
  // canvas's default 2:1 aspect ratio from consuming the row during startup.
  const scaleWidth = parseFloat(getComputedStyle($("appshell")).getPropertyValue("--w-pitch-scale"));
  ruler.style.width = scaleWidth + "px";
  rulerRight.style.width = scaleWidth + "px";
  const measuredW = scroll.clientWidth, availableH = viewer.clientHeight;
  if (measuredW < 1 || availableH < 1) return;
  const songW = songWidth();
  const viewW = measuredW;
  // Stage height = the real flex-computed height of #viewer (the [ruler · scroll]
  // body). Measuring the actual box — not arithmetic off window.innerHeight — keeps
  // the ruler's backing store equal to its CSS-stretched height (so pitch labels
  // line up with the spectrogram rows) and lets the spectrogram fill the viewport
  // at any zoom. No max cap: the canvas should always fill, however tall.
  const shell = $("appshell");
  S.stageHeight = Math.max(1, availableH);
  syncRowHeight();
  // Canvas is viewport-sized (small, GPU-friendly); the spacer carries the full
  // song width so the scrollbar range is unchanged. max(songW, viewW) avoids the
  // canvas overflowing the spacer (and adding phantom scroll) on short songs.
  // Backing stores are sized at devicePixelRatio (drawing stays in CSS px via a
  // scaled transform) so canvas lines/text render as crisp as the DOM around
  // them; the CSS box is pinned explicitly since these canvases have no CSS size.
  const dp = dpr();
  const stageW = Math.round(viewW * dp), stageH = Math.round(S.stageHeight * dp);
  // Assigning canvas width/height clears every pixel even when the value did not
  // change. Conditional writes avoid unnecessary black flashes during layout.
  if (stage.width !== stageW) stage.width = stageW;
  if (stage.height !== stageH) stage.height = stageH;
  stage.style.width = viewW + "px"; stage.style.height = S.stageHeight + "px";
  stageSpacer.style.width = Math.max(songW, viewW) + "px";
  // Spacer carries the full content height; when pitch-zoomed it exceeds the
  // visible stage height so the vertical scrollbar appears.
  // Only enable vertical overflow when actually zoomed, else the horizontal
  // scrollbar's height would force a spurious vertical bar at 100% pitch zoom.
  stageSpacer.style.height = Math.max(contentH(), S.stageHeight) + "px";
  scroll.style.height = S.stageHeight + "px";
  scroll.style.overflowY = S.zoomY > 1 ? "auto" : "hidden";
  const rulerW = Math.round(scaleWidth * dp), rulerH = Math.round(S.stageHeight * dp);
  for (const scale of [ruler, rulerRight]) {
    if (scale.width !== rulerW) scale.width = rulerW;
    if (scale.height !== rulerH) scale.height = rulerH;
    scale.style.height = S.stageHeight + "px";
  }
  const overviewHeight = parseFloat(getComputedStyle(shell).getPropertyValue("--h-overview-mini"));
  const mmH = overviewHeight > MM_HEAD ? overviewHeight : MINIMAP_H + MM_HEAD;
  minimap.style.height = mmH + "px";   // keep CSS box == drawn size so the pin isn't squished
  const minimapW = Math.max(1, Math.round(minimap.clientWidth * dp)), minimapH = Math.round(mmH * dp);
  if (minimap.width !== minimapW) minimap.width = minimapW;
  if (minimap.height !== minimapH) minimap.height = minimapH;
  const overviewRulerH = Math.round(overviewRuler.clientHeight * dp);
  if (overviewRuler.width !== minimapW) overviewRuler.width = minimapW;
  if (overviewRuler.height !== overviewRulerH) overviewRuler.height = overviewRulerH;
}

// ---- zoom ----
// Each axis anchors on a screen point: convert it to a world coordinate, change
// the scale, then re-scroll so that same world point stays under the cursor.
export const zoomSlider = $("zoomSlider"), zoomValEl = $("zoomVal");

export const zoomInBtn = $("zoomIn"), zoomOutBtn = $("zoomOut");

// Discrete zoom stops: powers of ZOOM_STEP anchored at 100%, clamped to the
// min/max — so dragging the slider lands on the same values the +/- buttons
// and wheel zoom produce, instead of an arbitrary continuous percentage.
export const ZOOM_LEVELS = (() => {
  const levels = [1];
  for (let z = ZOOM_STEP; z < ZOOM_MAX_X; z *= ZOOM_STEP) levels.push(z);
  levels.push(ZOOM_MAX_X);
  for (let z = 1 / ZOOM_STEP; z > ZOOM_MIN_X; z /= ZOOM_STEP) levels.unshift(z);
  levels.unshift(ZOOM_MIN_X);
  return levels;
})();

export const zoomXToSlider = (zx) => {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    const diff = Math.abs(ZOOM_LEVELS[i] - zx);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
};

export const sliderToZoomX = (v) => ZOOM_LEVELS[v];

export function updateZoomLabels() {
  // Unified control: % follows the time axis; pitch rides along (clamped).
  if (zoomValEl) zoomValEl.textContent = Math.round(S.zoomX * 100) + "%";
  if (zoomSlider && document.activeElement !== zoomSlider) zoomSlider.value = zoomXToSlider(S.zoomX);
  if (zoomInBtn)  zoomInBtn.disabled  = S.zoomX >= ZOOM_MAX_X - 1e-6;
  if (zoomOutBtn) zoomOutBtn.disabled = S.zoomX <= ZOOM_MIN_X + 1e-6;
}

function setZoomX(z) {
  S.zoomX = clamp(z, ZOOM_MIN_X, ZOOM_MAX_X);
  S.pxPerSec = PX_PER_SEC * S.zoomX;
  layout();              // spacer width follows songWidth()
  updateZoomLabels();
  draw();                // layout only resizes; the frame is what repaints
}

function setZoomY(z) {
  S.zoomY = clamp(z, ZOOM_MIN_Y, ZOOM_MAX_Y);
  syncRowHeight();
  layout();              // spacer height follows contentH()
  updateZoomLabels();
  draw();
}

function zoomAtClientX(clientX, factor) {
  const r = stage.getBoundingClientRect();
  const px = clamp(clientX - r.left, 0, scroll.clientWidth);
  const t = (scroll.scrollLeft + px) / S.pxPerSec;        // time under the cursor
  setZoomX(S.zoomX * factor);
  const maxX = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
  scroll.scrollLeft = clamp(t * S.pxPerSec - px, 0, maxX);
  draw();
}

export function zoomAtClientY(clientY, factor) {
  const r = stage.getBoundingClientRect();
  const py = clamp(clientY - r.top, 0, scroll.clientHeight);
  const frac = (scroll.scrollTop + py) / contentH();    // 0..1 within the pitch range
  setZoomY(S.zoomY * factor);
  const maxY = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  scroll.scrollTop = clamp(frac * contentH() - py, 0, maxY);
  draw();
}

export function zoomCenter(axis, factor) {
  const r = stage.getBoundingClientRect();
  if (axis === "y") zoomAtClientY(r.top + scroll.clientHeight / 2, factor);
  else zoomAtClientX(r.left + scroll.clientWidth / 2, factor);
}

export function resetZoom() {
  const r = stage.getBoundingClientRect();
  if (S.zoomX !== 1) zoomAtClientX(r.left + scroll.clientWidth / 2, 1 / S.zoomX);
  if (S.zoomY !== 1) zoomAtClientY(r.top, 1 / S.zoomY);     // anchor at top → scroll back to top
}

// Unified zoom: scale time + pitch together. Pitch is clamped to its own range,
// so below 100% only the time axis keeps shrinking (a "real" zoom).
export function zoomBothTo(targetX, clientX, clientY) {
  targetX = clamp(targetX, ZOOM_MIN_X, ZOOM_MAX_X);
  const targetY = clamp(targetX, ZOOM_MIN_Y, ZOOM_MAX_Y);
  if (Math.abs(targetX - S.zoomX) > 1e-6) zoomAtClientX(clientX, targetX / S.zoomX);
  if (Math.abs(targetY - S.zoomY) > 1e-6) zoomAtClientY(clientY, targetY / S.zoomY);
}

function zoomBothCenter(targetX) {
  const r = stage.getBoundingClientRect();
  zoomBothTo(targetX, r.left + scroll.clientWidth / 2, r.top + scroll.clientHeight / 2);
}

export function init_geometry() {
  zoomResetBtn.addEventListener("click", resetZoom);
  if (zoomInBtn)  zoomInBtn.addEventListener("click", () => zoomBothCenter(S.zoomX * ZOOM_STEP));
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => zoomBothCenter(S.zoomX / ZOOM_STEP));
  if (zoomSlider) {
    zoomSlider.max = ZOOM_LEVELS.length - 1;
    zoomSlider.addEventListener("input", () => zoomBothCenter(sliderToZoomX(+zoomSlider.value)));
  }
  updateZoomLabels();
}
