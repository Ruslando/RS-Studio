// Spectrogram tracing (drawing notes along the CQT ridge) and the similar-passage
// search that finds, ranks, and previews repeated phrases from a selection.

import { MIN_DUR, SIMILAR_GLOBAL_THRESHOLD, stageMono, SIMILAR_HARMONIC_SPAN, SIMILAR_MAX_MATCHES, SIMILAR_PITCH_MARGIN, SIMILAR_THRESHOLD, TRACE_FALLBACK_STEP, TRACE_POINT_GAP } from "./constants.js";
import { audio, scroll, sctx, traceRangeSel, traceSnapInput, traceThresholdInput } from "./dom.js";
import { draw } from "./repaint.js";
import { commit, confirmPasteMode, copyEffects, snapshotEdit } from "./edit.js";
import { boxOfNote } from "./references.js";
import { contentH, pitchAt, songWidth, timeAt, xOf, yOf } from "./geometry.js";
import { gridOffset, gridStep } from "./grid.js";
import { nid } from "./ids.js";
import { laneOf, refreshCounts, renderLanes, targetLane } from "./lanes.js";
import { cancelPassagePreview, clearPreview, ensureTone, passagePreviewToken, rate, seekPlayback } from "./playback.js";
import { toast } from "./notify.js";
import { PAINT, WASH } from "./stage-paint.js";
import { S, setSelection } from "./store.js";
import { clamp, hexA } from "./util.js";

export let spectSampleCanvas = document.createElement("canvas");

export let spectSampleCtx = spectSampleCanvas.getContext("2d", { willReadFrequently: true });

export let heatMaskCanvas = document.createElement("canvas");

export let heatMaskCtx = heatMaskCanvas.getContext("2d");

export function prepareSpectSample() {
  if (!S.spectImg || !spectSampleCtx) return;
  spectSampleCanvas.width = S.spectImg.width;
  spectSampleCanvas.height = S.spectImg.height;
  spectSampleCtx.clearRect(0, 0, S.spectImg.width, S.spectImg.height);
  spectSampleCtx.drawImage(S.spectImg, 0, 0);
  try {
    S.spectPixels = spectSampleCtx.getImageData(0, 0, S.spectImg.width, S.spectImg.height).data;
  } catch {
    S.spectPixels = null;
  }
  rebuildHeatMask();
}

function traceStep() {
  return gridStep() || TRACE_FALLBACK_STEP;
}

function traceThresholdPercent() {
  return clamp(parseFloat(traceThresholdInput.value) || 0, 0, 100);
}

function traceThreshold() {
  return traceThresholdPercent() / 100 * 255;
}

function traceSearchRange() {
  return parseInt(traceRangeSel.value, 10) || 2;
}

// On (default): trace snaps each note to the brightest nearby spectrogram pitch.
// Off: notes land exactly on the drawn path (free draw), ignoring heat + Range.
function traceSnap() {
  return traceSnapInput ? traceSnapInput.checked : true;
}

// Range/Heat only steer the snap search, so dim them when free-drawing.
// Covers the hidden state inputs and their Settings-modal mirrors.
function updateTraceControls() {
  const off = !traceSnap();
  document.querySelectorAll(".trace-range-ctl, .trace-heat-ctl").forEach((el) => (el.disabled = off));
}

function updateTraceThresholdLabel() {
  const txt = `${Math.round(traceThresholdPercent())}%`;
  document.querySelectorAll(".trace-thresh-val").forEach((el) => (el.textContent = txt));
}

function setHeatPreview(on) {
  S.heatPreview = !!on;
  draw();
}

function showHeatPreviewBriefly() {
  if (S.heatPreviewTimer) clearTimeout(S.heatPreviewTimer);
  setHeatPreview(true);
  S.heatPreviewTimer = setTimeout(() => {
    S.heatPreviewTimer = 0;
    if (document.activeElement !== traceThresholdInput) setHeatPreview(false);
  }, 1400);
}

// The heat overlay's colour ramp: a green that gets brighter and more opaque
// with energy. Written out rather than pulled from the theme because it sits on
// the always-dark stage and has to stay legible over the magma spectrogram
// underneath — the themed accents do not.
function heatColorForEnergy(e) {
  const a = clamp((e - traceThreshold()) / Math.max(1, 255 - traceThreshold()), 0, 1);
  return [
    Math.round(90 + 120 * a),
    Math.round(230 + 25 * a),
    Math.round(190 + 45 * a),
    Math.round(70 + 120 * a),
  ];
}

// How bright one spectrogram pixel counts as. Used by BOTH the heat overlay
// (what you see) and the trace snap search (where a note actually lands) — they
// must agree, or the green preview shows a ridge the tracer won't snap to.
// Rec.601 luma blended with peak channel: the magma colormap runs dark-purple →
// pink → pale-yellow, so peak alone over-reads saturated mid-energy pink and
// luma alone under-reads it.
function pixelEnergy(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return Math.max(r, g, b) * 0.65 + lum * 0.35;
}

function rebuildHeatMask() {
  if (!S.spectPixels || !S.spectImg || !heatMaskCtx) return;
  heatMaskCanvas.width = S.spectImg.width;
  heatMaskCanvas.height = S.spectImg.height;
  const image = heatMaskCtx.createImageData(S.spectImg.width, S.spectImg.height);
  const threshold = traceThreshold();
  for (let y = 0; y < S.spectImg.height; y++) {
    for (let x = 0; x < S.spectImg.width; x++) {
      const src = (y * S.spectImg.width + x) * 4;
      const energy = pixelEnergy(S.spectPixels[src], S.spectPixels[src + 1], S.spectPixels[src + 2]);
      if (energy < threshold) continue;
      const dst = src;
      const c = heatColorForEnergy(energy);
      image.data[dst] = c[0];
      image.data[dst + 1] = c[1];
      image.data[dst + 2] = c[2];
      image.data[dst + 3] = c[3];
    }
  }
  heatMaskCtx.putImageData(image, 0, 0);
}

export function drawHeatThresholdOverlay() {
  if (!S.heatPreview || !S.state || !S.spectImg || !heatMaskCanvas.width) return;
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  const t0 = Math.max(0, vx0 / S.pxPerSec), t1 = Math.min(S.state.duration, vx1 / S.pxPerSec);
  if (t1 <= t0) return;
  sctx.save();
  sctx.globalCompositeOperation = "screen";
  sctx.drawImage(heatMaskCanvas,
    (t0 / S.state.duration) * heatMaskCanvas.width, 0,
    ((t1 - t0) / S.state.duration) * heatMaskCanvas.width, heatMaskCanvas.height,
    t0 * S.pxPerSec, 0, (t1 - t0) * S.pxPerSec, contentH());
  sctx.restore();
}

export function addTracePoint(points, x, y) {
  x = clamp(x, 0, songWidth());
  y = clamp(y, 0, contentH() - 1);
  const last = points[points.length - 1];
  if (last && Math.hypot(x - last[0], y - last[1]) < TRACE_POINT_GAP) return;
  points.push([x, y]);
}

function yOnTrace(points, x) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (!pts.length) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (x > b[0]) continue;
    const span = b[0] - a[0];
    if (Math.abs(span) < 0.001) return b[1];
    const u = (x - a[0]) / span;
    return a[1] + (b[1] - a[1]) * u;
  }
  return pts[pts.length - 1][1];
}

function spectEnergyAt(ix, iy) {
  if (!S.spectPixels || spectSampleCanvas.width <= 1 || spectSampleCanvas.height <= 1) return 0;
  // Pixel coordinates are half-open cells: y=10.5 is still row 10. Rounding
  // would push every semitone center into the row below, crediting that heat
  // to the pitch one semitone higher.
  ix = clamp(Math.floor(ix), 0, spectSampleCanvas.width - 1);
  iy = clamp(Math.floor(iy), 0, spectSampleCanvas.height - 1);
  const i = (iy * spectSampleCanvas.width + ix) * 4;
  return pixelEnergy(S.spectPixels[i], S.spectPixels[i + 1], S.spectPixels[i + 2]);
}

function imageXForTime(t) {
  if (!S.state || !S.spectImg || !S.state.duration) return 0;
  return clamp((t / S.state.duration) * S.spectImg.width, 0, S.spectImg.width - 1);
}

function imageYForPitch(p) {
  if (!S.state || !S.spectImg) return 0;
  const y = yOf(p) + S.state.rowH * 0.5;
  return clamp((y / contentH()) * S.spectImg.height, 0, S.spectImg.height - 1);
}

function pitchEnergy(t, pitch, step) {
  const ix = imageXForTime(t);
  const iy = imageYForPitch(pitch);
  const timeRadius = Math.max(1, Math.min(6, Math.round((step / Math.max(S.state.duration, step)) * S.spectImg.width * 0.25)));
  const rowRadius = Math.max(1, Math.round((S.spectImg.height / (S.state.spec.midi_high - S.state.spec.midi_low + 1)) * 0.25));
  let total = 0, count = 0;
  for (let dx = -timeRadius; dx <= timeRadius; dx += Math.max(1, Math.floor(timeRadius / 2))) {
    for (let dy = -rowRadius; dy <= rowRadius; dy += Math.max(1, Math.floor(rowRadius / 2))) {
      total += spectEnergyAt(ix + dx, iy + dy);
      count++;
    }
  }
  return count ? total / count : 0;
}

const HARMONIC_W = { octave: 0.18, twelfth: 0.10 };

function tracePitchAt(t, guidePitch, step) {
  const range = traceSearchRange();
  let best = null;
  for (let p = guidePitch - range; p <= guidePitch + range; p++) {
    if (p < S.state.spec.midi_low || p > S.state.spec.midi_high) continue;
    // A candidate scores on its own brightness plus a little of its first two
    // harmonics: +12 semitones is the octave (2nd harmonic), +19 is the octave
    // and a fifth (3rd). Both are present whenever p is the FUNDAMENTAL and
    // absent when p is itself somebody's overtone, so this is what stops the
    // tracer snapping an octave high on a bright harmonic. The weights are small
    // on purpose — evidence, not a second opinion; raising them makes a strong
    // overtone series outvote a quiet fundamental, which is the failure mode
    // they exist to prevent.
    const own = pitchEnergy(t, p, step);
    const h12 = p + 12 <= S.state.spec.midi_high ? pitchEnergy(t, p + 12, step) * HARMONIC_W.octave : 0;
    const h19 = p + 19 <= S.state.spec.midi_high ? pitchEnergy(t, p + 19, step) * HARMONIC_W.twelfth : 0;
    const score = own + h12 + h19;
    if (!best || score > best.score) best = { pitch: p, score, own };
  }
  return best;
}

export function notesFromTrace(points) {
  if (!S.state || !S.spectImg || points.length < 2) return [];
  const snap = traceSnap();
  const step = traceStep();
  const threshold = traceThreshold();
  const off = gridStep() ? gridOffset() : 0;
  const minX = Math.max(0, Math.min(...points.map((p) => p[0])));
  const maxX = Math.min(songWidth(), Math.max(...points.map((p) => p[0])));
  const minT = Math.max(0, timeAt(minX));
  const maxT = Math.min(S.state.duration, timeAt(maxX));
  if (maxT - minT < MIN_DUR) return [];

  const startIdx = Math.max(0, Math.floor((minT - off) / step));
  const notes = [];
  let cur = null;
  for (let i = startIdx; ; i++) {
    const t0 = Math.max(0, off + i * step);
    const t1 = Math.min(S.state.duration, t0 + step);
    if (t0 >= maxT - 1e-6) break;
    if (t1 <= minT + 1e-6) continue;
    const center = clamp((Math.max(t0, minT) + Math.min(t1, maxT)) * 0.5, 0, S.state.duration);
    const guideY = yOnTrace(points, xOf(center));
    const guidePitch = pitchAt(guideY);
    // Free draw: keep the drawn pitch and skip the heat gate so notes always land
    // exactly on the path. Snap: search nearby rows for the brightest pitch.
    const found = snap ? tracePitchAt(center, guidePitch, step)
                       : { pitch: guidePitch, own: 255, score: 255 };
    if (!found || found.own < threshold) {
      if (cur) { notes.push(cur); cur = null; }
      continue;
    }
    const start = Math.max(0, t0);
    const end = Math.min(S.state.duration, t1);
    if (end - start < MIN_DUR) continue;
    const conf = +(clamp(found.own / 255, 0, 1)).toFixed(3);
    if (cur && cur.pitch === found.pitch && Math.abs(cur.end - start) < 0.001) {
      cur.end = end;
      cur.confidence = Math.max(cur.confidence, conf);
    } else {
      if (cur) notes.push(cur);
      cur = { id: nid(), start, end, pitch: found.pitch, confidence: conf };
    }
  }
  if (cur) notes.push(cur);
  return notes;
}

export function drawTracePath(points) {
  if (!points || !points.length) return;
  sctx.save();
  // Tracing is a thing you are doing right now, not a suggestion — accent, the
  // same as the marquee and the playhead (rule 7's "checked/engaged" use).
  sctx.strokeStyle = PAINT.accent;
  sctx.lineWidth = 2;
  sctx.setLineDash([7, 4]);
  sctx.beginPath();
  sctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) sctx.lineTo(points[i][0], points[i][1]);
  sctx.stroke();
  sctx.setLineDash([]);
  sctx.fillStyle = hexA(PAINT.accent, 0.22);
  for (const p of points) {
    sctx.beginPath();
    sctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
    sctx.fill();
  }
  sctx.restore();
}

export function drawTraceRange(points) {
  if (!S.state || !points || !points.length) return;
  // Free draw has no search band — show just the row the path sits on (range 0).
  const range = traceSnap() ? traceSearchRange() : 0;
  const halfH = (range + 0.5) * S.state.rowH;
  sctx.save();
  sctx.fillStyle = hexA(PAINT.accent, WASH);
  sctx.strokeStyle = hexA(PAINT.accent, 0.45);
  sctx.lineWidth = 1;
  sctx.setLineDash([5, 4]);
  if (points.length === 1) {
    // Full-width pitch band across just the visible window (world px).
    const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
    const y = yOf(pitchAt(points[0][1]));
    sctx.fillRect(vx0, y - range * S.state.rowH, vx1 - vx0, (range * 2 + 1) * S.state.rowH);
    sctx.beginPath();
    sctx.moveTo(vx0, y - range * S.state.rowH);
    sctx.lineTo(vx1, y - range * S.state.rowH);
    sctx.moveTo(vx0, y + (range + 1) * S.state.rowH);
    sctx.lineTo(vx1, y + (range + 1) * S.state.rowH);
    sctx.stroke();
  } else {
    const top = [], bottom = [], ch = contentH();
    for (const p of points) {
      top.push([p[0], clamp(p[1] - halfH, 0, ch)]);
      bottom.push([p[0], clamp(p[1] + halfH, 0, ch)]);
    }
    sctx.beginPath();
    sctx.moveTo(top[0][0], top[0][1]);
    for (let i = 1; i < top.length; i++) sctx.lineTo(top[i][0], top[i][1]);
    for (let i = bottom.length - 1; i >= 0; i--) sctx.lineTo(bottom[i][0], bottom[i][1]);
    sctx.closePath();
    sctx.fill();
    sctx.beginPath();
    sctx.moveTo(top[0][0], top[0][1]);
    for (let i = 1; i < top.length; i++) sctx.lineTo(top[i][0], top[i][1]);
    sctx.moveTo(bottom[0][0], bottom[0][1]);
    for (let i = 1; i < bottom.length; i++) sctx.lineTo(bottom[i][0], bottom[i][1]);
    sctx.stroke();
  }
  sctx.setLineDash([]);
  sctx.restore();
}

// Rebuilding the heat mask scans the whole spectrogram (~10k×73 px), so coalesce
// rapid slider input to at most one rebuild per animation frame.
export let heatMaskRaf = 0;

function scheduleHeatMaskRebuild() {
  if (heatMaskRaf) return;
  heatMaskRaf = requestAnimationFrame(() => {
    heatMaskRaf = 0;
    rebuildHeatMask();
    if (S.heatPreview) draw();   // reflect the new threshold in the live preview
  });
}

// ---- similar-passage search ----
// Use the selected edit notes as a template: take the spectrogram patch under
// their pitch band + time span, slide it (pitch-locked) across the whole song,
// and surface the time-shifted copies that correlate best. Each hit shows as a
// dashed "ghost" of the selection with a confidence %, which you place on click.
let hoverPreviewGeneration = 0;
let hoverPlaybackToken = null;
let matchChoice = null;

export function clearMatches() {
  matchChoice?.abort();
  if (!S.matches.length && S.matchHover < 0 && S.matchFocus < 0) return;
  S.matches = [];
  S.matchHover = -1;
  S.matchFocus = -1;
  cancelHoverPreview();
  cancelPassagePreview({ pauseAudio: true });
  clearPreview();
}

export function cancelHoverPreview() {
  hoverPreviewGeneration++;
  if (S.hoverPreviewTimer) clearTimeout(S.hoverPreviewTimer);
  S.hoverPreviewTimer = 0;
  if (hoverPlaybackToken === passagePreviewToken) {
    cancelPassagePreview({ pauseAudio: true });
    clearPreview();
  }
  hoverPlaybackToken = null;
}

export function setPlaybackCursor(t) {
  seekPlayback(t);
}

function scrollMatchIntoView(m) {
  if (!S.state || !m) return;
  const max = Math.max(0, songWidth() - scroll.clientWidth);
  const center = xOf((m.t0 + m.t1) * 0.5);
  scroll.scrollLeft = clamp(center - scroll.clientWidth * 0.5, 0, max);
}

function focusMatch(i, opts = {}) {
  if (!S.matches.length) return;
  S.matchFocus = (i + S.matches.length) % S.matches.length;
  const m = S.matches[S.matchFocus];
  scrollMatchIntoView(m);
  setPlaybackCursor(m.t0);
  draw();
  if (opts.preview) previewSimilarMatch(S.matchFocus);
}

function firstMatchInDirection(dir) {
  if (!S.matches.length) return -1;
  if (S.matchFocus >= 0) return S.matchFocus + dir;
  const ref = timeAt(scroll.scrollLeft + scroll.clientWidth * 0.5);
  if (dir > 0) {
    const next = S.matches.findIndex((m) => m.t0 > ref + 1e-6);
    return next >= 0 ? next : 0;
  }
  for (let i = S.matches.length - 1; i >= 0; i--)
    if (S.matches[i].t1 < ref - 1e-6) return i;
  return S.matches.length - 1;
}

export function focusAdjacentMatch(dir, opts = { preview: true }) {
  const i = firstMatchInDirection(dir);
  if (i >= 0) focusMatch(i, opts);
}

export function previewFocusedMatch() {
  if (!S.matches.length) return;
  if (S.matchFocus < 0 && S.matchHover >= 0) focusMatch(S.matchHover, { preview: false });
  if (S.matchFocus < 0) focusAdjacentMatch(1, { preview: false });
  previewSimilarMatch(S.matchFocus);
}

export function scheduleHoverMatchPreview(i) {
  cancelHoverPreview();
  if (i < 0 || !S.matches[i]) return;
  S.matchFocus = i;
  const generation = hoverPreviewGeneration;
  S.hoverPreviewTimer = setTimeout(() => {
    S.hoverPreviewTimer = 0;
    if (S.matchHover === i) previewSimilarMatch(i, { silent: true, hoverGeneration: generation });
  }, 180);
}

async function previewSimilarMatch(i, opts = {}) {
  const m = S.matches[i];
  if (!m) return;
  const fromHover = opts.hoverGeneration !== undefined;
  if (!fromHover) cancelHoverPreview();
  await ensureTone();
  if (fromHover && (opts.hoverGeneration !== hoverPreviewGeneration || S.matchHover !== i || S.matches[i] !== m)) return;
  cancelPassagePreview();
  // cancelPassagePreview() already bumped the token, so this reads the fresh
  // generation. Incrementing here instead would throw: imported bindings are
  // read-only, and the whole function died on that line. Keep it a read.
  const token = passagePreviewToken;
  hoverPlaybackToken = fromHover ? token : null;
  const r = rate();
  S.passagePreviewActive = true;
  setPlaybackCursor(m.t0);
  try {
    await audio.play();
  } catch {
    if (token !== passagePreviewToken) return;
    S.passagePreviewActive = false;
    if (!opts.silent) toast("Audio preview unavailable");
    return;
  }
  if (token !== passagePreviewToken) return;
  const ms = Math.max(80, ((m.t1 - m.t0) / r) * 1000 + 80);
  S.passagePreviewTimer = setTimeout(() => {
    if (token !== passagePreviewToken) return;
    S.passagePreviewTimer = 0;
    S.passagePreviewActive = false;
    clearPreview();
    if (!audio.paused) audio.pause();
    setPlaybackCursor(m.t1);
    draw();
  }, ms);
}

// Score every candidate start column by normalized cross-correlation
// (brightness-invariant) and keep the non-overlapping peaks above threshold that
// aren't already transcribed. Two bands are scored per column: the note band
// (the selection's pitch range) and a wider band extending up over the overtones.
// A guitar's fundamental is often dark while its harmonics are bright, so the
// note band alone can be too sparse to correlate — the wide band carries the
// match in that case. Either band qualifying surfaces the passage; the stronger
// of the two sets the confidence.
function computeSimilarMatches(selNotes, fillLane = targetLane()) {
  if (!S.state || !S.spectImg || !S.spectPixels || !selNotes.length) return [];
  const iw = S.spectImg.width, ih = S.spectImg.height;
  const firstBox = boxOfNote(selNotes[0]);
  const sourceReference = firstBox && selNotes.every((note) => {
    const box = boxOfNote(note);
    return box && box.lane === firstBox.lane && box.ref === firstBox.ref && box.i === firstBox.i;
  }) ? { lane: firstBox.lane, ref: firstBox.ref, group: firstBox.group, anchor: firstBox.group.anchors[firstBox.i] } : null;
  const t0 = Math.min(...selNotes.map((n) => n.start));
  const t1 = Math.max(...selNotes.map((n) => n.end));
  if (t1 - t0 < MIN_DUR) return [];
  const loP = Math.min(...selNotes.map((n) => n.pitch));
  const hiP = Math.max(...selNotes.map((n) => n.pitch));
  const pTop = Math.min(S.state.spec.midi_high, hiP + SIMILAR_PITCH_MARGIN);
  const pBot = Math.max(S.state.spec.midi_low, loP - SIMILAR_PITCH_MARGIN);
  // Harmonic fallback band: extend the scored region up over the overtones (not
  // the displayed box, which stays the note band). pTopWide >= pTop always.
  const pTopWide = Math.min(S.state.spec.midi_high, hiP + SIMILAR_HARMONIC_SPAN);

  // Image-space patch: columns [c0,c1). Rows: higher pitch = lower index, so the
  // wide band's top row (rWideTop) sits at or above the note band's top (rTop).
  const c0 = Math.floor(imageXForTime(t0));
  const c1 = Math.max(c0 + 1, Math.ceil(imageXForTime(t1)));
  const patchW = c1 - c0;
  const rWideTop = clamp(Math.floor(imageYForPitch(pTopWide)), 0, ih - 1);
  const rTop = clamp(Math.floor(imageYForPitch(pTop)), 0, ih - 1);
  const rBot = clamp(Math.ceil(imageYForPitch(pBot)), 0, ih - 1);
  const Hwide = rBot - rWideTop + 1;
  if (patchW < 1 || Hwide < 1 || c0 + patchW > iw) return [];

  // Cache the wide band's per-pixel energy once; the note band is its lower rows.
  const band = new Float64Array(Hwide * iw);
  for (let ri = 0; ri < Hwide; ri++) {
    const off = ri * iw, row = rWideTop + ri;
    for (let col = 0; col < iw; col++) band[off + col] = spectEnergyAt(col, row);
  }
  const loOff = rTop - rWideTop;   // first note-band row within `band`

  // Mean-centred template over rows [r0, r0+H) of `band` + its norm. Returns null
  // for a flat (silent) patch — common for a dark guitar fundamental, which is
  // exactly when the wide band must carry the match instead.
  const buildTemplate = (r0, H) => {
    const n = H * patchW;
    const tmpl = new Float64Array(n);
    let tsum = 0;
    for (let ri = 0; ri < H; ri++)
      for (let ci = 0; ci < patchW; ci++) {
        const v = band[(r0 + ri) * iw + c0 + ci];
        tmpl[ri * patchW + ci] = v; tsum += v;
      }
    const tmean = tsum / n;
    let tnorm = 0;
    for (let i = 0; i < n; i++) { tmpl[i] -= tmean; tnorm += tmpl[i] * tmpl[i]; }
    tnorm = Math.sqrt(tnorm);
    return tnorm < 1e-6 ? null : { tmpl, tnorm, r0, H, n };
  };
  const noteTmpl = buildTemplate(loOff, rBot - rTop + 1);
  const wideTmpl = buildTemplate(0, Hwide);
  if (!noteTmpl && !wideTmpl) return [];

  // NCC of a template against the window starting at column cs. 0 for a null
  // template (flat selection patch) or a flat window.
  const scoreAt = (tpl, cs) => {
    if (!tpl) return 0;
    let dot = 0, wsum = 0, wsq = 0;
    for (let ri = 0; ri < tpl.H; ri++) {
      const base = (tpl.r0 + ri) * iw + cs, tb = ri * patchW;
      for (let ci = 0; ci < patchW; ci++) {
        const w = band[base + ci];
        dot += tpl.tmpl[tb + ci] * w; wsum += w; wsq += w * w;
      }
    }
    const wvar = wsq - (wsum * wsum) / tpl.n;
    const denom = tpl.tnorm * Math.sqrt(Math.max(wvar, 1e-9));
    return denom > 1e-9 ? dot / denom : 0;
  };

  // Score each candidate start column against both bands. Budget the stride off
  // the wider template so the one-shot search stays snappy (NCC peaks are broad).
  const lastCs = iw - patchW;
  const stride = Math.max(1, Math.ceil((Hwide * patchW * (lastCs + 1)) / 30e6));
  const scored = [];   // { cs, score }
  for (let cs = 0; cs <= lastCs; cs += stride) {
    const ns = scoreAt(noteTmpl, cs);
    const ws = scoreAt(wideTmpl, cs);
    if (ns >= SIMILAR_THRESHOLD || ws >= SIMILAR_GLOBAL_THRESHOLD)
      scored.push({ cs, score: Math.max(ns, ws) });
  }

  // Greedy non-maximum suppression: strongest peaks first, keep them apart.
  scored.sort((a, b) => b.score - a.score);
  const dtPerCol = S.state.duration / iw;
  const minSep = Math.max(stride, Math.floor(patchW * 0.6));
  const picked = [];
  const out = [];
  for (const { cs, score } of scored) {
    if (picked.some((p) => Math.abs(p - cs) < minSep)) continue;
    const dt = (cs - c0) * dtPerCol;
    const ghosts = selNotes.map((nn) => copyEffects(nn, { start: nn.start + dt, end: nn.end + dt, pitch: nn.pitch }));
    if (passageFilled(ghosts, fillLane)) continue;   // already transcribed in the target lane
    picked.push(cs);
    out.push({ score, dt, t0: t0 + dt, t1: t1 + dt, pTop, pBot, notes: ghosts, sourceReference });
    if (out.length >= SIMILAR_MAX_MATCHES) break;
  }
  out.sort((a, b) => a.t0 - b.t0);   // left-to-right along the timeline
  return out;
}

// A candidate is "already transcribed" only when it collides with the edit lane
// it would be pasted into. Other edit lanes may be hidden references/alternates.
function passageFilled(ghosts, lane) {
  if (!lane) return false;
  for (const m of lane.notes)
    for (const g of ghosts)
      if (m.pitch === g.pitch && m.start < g.end && g.start < m.end) return true;
  return false;
}

export function runFindSimilar() {
  if (!S.state) return;
  const selNotes = [...S.selection].filter((n) => laneOf(n));
  if (!selNotes.length) { toast("Select notes in a note layer first"); return; }
  if (!S.spectPixels) { toast("Spectrogram not ready yet"); return; }
  const lane = targetLane();
  if (!lane) { toast("Add an edit lane first"); return; }
  ensureTone(); // unlock audio from the Find Similar gesture so hover previews can play
  clearMatches();
  S.matches = computeSimilarMatches(selNotes, lane);
  if (!S.matches.length) { toast("No similar passages found"); draw(); return; }
  draw();
}

// Drop the ghost notes of one (or all) suggestions into the target edit lane,
// reusing the paste path so they float + merge on deselect like a normal paste.
function placeGhosts(matches, mode) {
  const source = matches[0]?.sourceReference;
  const lane = mode === "reference" ? source?.lane : targetLane();
  if (!lane) return null;
  if (!lane.visible || lane.locked) {
    toast(`Layer “${lane.name}” is ${lane.locked ? "locked" : "hidden"} — ${lane.locked ? "unlock" : "show"} it to edit`);
    return null;
  }
  if (mode === "reference" && lane.refBoxes?.[source.ref] !== source.group) return null;
  const prev = snapshotEdit();
  const added = [];
  for (const match of matches) {
    for (const g of match.notes) {
      const nn = copyEffects(g, { id: nid(), start: g.start, end: g.end, pitch: g.pitch });
      lane.notes.push(nn); added.push(nn);
    }
    if (mode === "reference") source.group.anchors.push(source.anchor + match.dt);
  }
  if (!added.length) return null;
  commit(prev);
  S.state.lanes.forEach((l) => (l.active = l === lane));
  return { lane, added };
}

async function chooseMatchMode(matches) {
  if (matchChoice) return null;
  if (!matches[0]?.sourceReference) return "copy";
  const controller = new AbortController();
  matchChoice = controller;
  try { return await confirmPasteMode({ signal: controller.signal }); }
  finally { if (matchChoice === controller) matchChoice = null; }
}

export async function acceptMatch(i) {
  const m = S.matches[i];
  if (!m) return;
  cancelHoverPreview();
  cancelPassagePreview({ pauseAudio: true });
  clearPreview();
  const state = S.state;
  const mode = await chooseMatchMode([m]);
  if (!mode || S.state !== state || S.matches[i] !== m) return;
  const res = placeGhosts([m], mode);
  if (!res) return;
  S.matches.splice(i, 1);
  S.matchHover = -1;
  if (!S.matches.length) S.matchFocus = -1;
  else if (S.matchFocus === i) S.matchFocus = Math.min(i, S.matches.length - 1);
  else if (S.matchFocus > i) S.matchFocus--;
  if (res) {
    setSelection(new Set(res.added));   // float them like a paste
    renderLanes(); refreshCounts();
  }
  draw();
}

export async function acceptAllMatches() {
  if (!S.matches.length) return;
  cancelHoverPreview();
  cancelPassagePreview({ pauseAudio: true });
  clearPreview();
  const matches = S.matches.slice(), state = S.state;
  const mode = await chooseMatchMode(matches);
  if (!mode || S.state !== state || matches.some((match, i) => S.matches[i] !== match)) return;
  const res = placeGhosts(matches, mode);
  if (!res) return;
  clearMatches();
  if (res) {
    setSelection(new Set(res.added));
    renderLanes(); refreshCounts();
  }
  draw();
}

export function matchAt(x, y) {
  for (let i = 0; i < S.matches.length; i++) {
    const m = S.matches[i];
    const bx0 = xOf(m.t0), bx1 = xOf(m.t1);
    const byTop = yOf(m.pTop), byBot = yOf(m.pBot) + S.state.rowH;
    if (x >= bx0 - 3 && x <= bx1 + 3 && y >= byTop - 3 && y <= byBot + 3) return i;
  }
  return -1;
}

// Paint the suggestions on top of the committed notes: dashed pink ghosts inside
// a box, opacity rising with confidence, a % label, and a brighter hovered box.
export function drawMatches() {
  if (!S.matches.length) return;
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  const vy0 = scroll.scrollTop;
  sctx.font = stageMono();   // a confidence %, ranked against every other match
  for (let i = 0; i < S.matches.length; i++) {
    const m = S.matches[i];
    const bx = xOf(m.t0), bw = xOf(m.t1) - bx;
    if (bx > vx1 || bx + bw < vx0) continue;   // off-screen
    const byTop = yOf(m.pTop), byBot = yOf(m.pBot) + S.state.rowH;
    const hovered = i === S.matchHover;
    const focused = i === S.matchFocus;
    const active = hovered || focused;
    const a = 0.25 + 0.55 * clamp((m.score - SIMILAR_THRESHOLD) / (1 - SIMILAR_THRESHOLD), 0, 1);
    for (const g of m.notes) {
      const gx = xOf(g.start), gw = Math.max(2, xOf(g.end) - gx);
      sctx.fillStyle = hexA(PAINT.trace, a);   // one hue for suggestions, distinct from the edit lanes
      sctx.fillRect(gx, yOf(g.pitch), gw, S.state.rowH);
    }
    sctx.save();
    sctx.setLineDash([5, 3]);
    sctx.lineWidth = active ? 2 : 1;
    // Hovered is the same hue at full strength; a second, paler pink was one more
    // colour doing what an alpha already does.
    sctx.strokeStyle = active ? PAINT.trace : hexA(PAINT.trace, 0.7);
    sctx.strokeRect(bx + 0.5, byTop + 0.5, bw - 1, byBot - byTop - 1);
    sctx.restore();
    const pct = `${Math.round(m.score * 100)}%`;
    const tw = sctx.measureText(pct).width;
    const ly = clamp(byTop, vy0, vy0 + S.stageHeight - 13);
    sctx.fillStyle = active ? PAINT.trace : hexA(PAINT.trace, 0.85);
    sctx.fillRect(bx, ly, tw + 6, 13);
    sctx.fillStyle = PAINT.ground;
    sctx.fillText(pct, bx + 3, ly + 10);
  }
  sctx.setLineDash([]); sctx.lineWidth = 1;
}

export function init_tracing() {
  updateTraceThresholdLabel();
  if (traceThresholdInput) {
    traceThresholdInput.addEventListener("input", () => {
      updateTraceThresholdLabel();
      scheduleHeatMaskRebuild();
      showHeatPreviewBriefly();
    });
    traceThresholdInput.addEventListener("focus", () => setHeatPreview(true));
    traceThresholdInput.addEventListener("blur", () => setHeatPreview(false));
    traceThresholdInput.addEventListener("mouseenter", () => setHeatPreview(true));
    traceThresholdInput.addEventListener("mouseleave", () => {
      if (document.activeElement !== traceThresholdInput) setHeatPreview(false);
    });
  }
  if (traceRangeSel) traceRangeSel.addEventListener("input", () => draw());
  updateTraceControls();
  if (traceSnapInput) traceSnapInput.addEventListener("change", () => { updateTraceControls(); draw(); });
}
