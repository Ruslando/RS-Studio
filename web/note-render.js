import { paintTimeGridLine } from './timeline-paint.js';
// Everything the canvas paints that is not the spectrogram itself: the pitch
// ruler, the beat grid, the Alt-dragged detect frame, stacked-note badges, and
// the note-effect glyphs (slides, bends, harmonics, articulation tags).
//
// This was the back two-thirds of detect.js, whose banner promised note
// detection — 62% of that file had nothing to do with detecting anything, and
// it was the reason draw.js imported the detector. Splitting it removed two
// dependency cycles.
//
// Everything here draws in draw.js's world transform: coordinates are absolute
// song pixels (x = time * pxPerSec, y from the top of the pitch range), already
// offset by the scroll position. Nothing here reads the DOM beyond the two
// canvas contexts, and nothing mutates project state.

import { hammerDirections } from "./articulations.js";
import { paintNoteBar } from "./canvas-components.js";
import { graceBefore } from "./grace.js";
import { bendCurve, slideRibbon, slideTargets } from "./bend.js";
import { OVERLAP_EPS, REGION_GRAB, REGION_HANDLE_H, STAGE_ANCHORED, stageMono } from "./constants.js";
import { ruler, rulerRight, scroll, sctx } from "./dom.js";
import { laneFingering, laneFingeringKey } from "./tablature.js";
import { draw } from "./repaint.js";
import { edgeSlide, resolveNoteAppearance, sourceLabelPositions, spectrogramLabel, spectrogramLabelOptions } from "./spectrogram-labels.js";
import { paintNoteLabel, paintSlideLabel } from "./note-label-paint.js";
import { contentH, pitchAt, timeAt, xOf, yOf } from "./geometry.js";
import { gridAt, gridSegments, displayGridStep } from "./grid.js";
import { autoGridLabel, gridLineKind } from './auto-grid.js';
import { FX_GLYPHS, HARMONIC_TAG, noteMarks } from "./note-effects.js";
import { PAINT, WASH, halo, veil } from "./stage-paint.js";
import { S } from "./store.js";
import { dpr, fmtTime, grayHex, hexA, noteName } from "./util.js";

// ---- detect time frame (Alt-drag) ----
// Which edge of the frame (if any) a world-x sits on, for resize hit-testing.
export function regionEdgeAt(x) {
  if (!S.detectRegion) return null;
  const a = Math.min(S.detectRegion.t0, S.detectRegion.t1), b = Math.max(S.detectRegion.t0, S.detectRegion.t1);
  if (Math.abs(x - xOf(b)) <= REGION_GRAB) return "r";   // prefer the right edge on overlap (zero-width)
  if (Math.abs(x - xOf(a)) <= REGION_GRAB) return "l";
  return null;
}

function drawRegionHandle(x, y) {
  const w = 7;
  sctx.fillStyle = PAINT.accent;
  sctx.fillRect(x - w / 2, y, w, REGION_HANDLE_H);
  sctx.strokeStyle = PAINT.ground; sctx.lineWidth = 1;
  sctx.beginPath();
  sctx.moveTo(x - 1.5, y + 9); sctx.lineTo(x - 1.5, y + REGION_HANDLE_H - 9);
  sctx.moveTo(x + 1.5, y + 9); sctx.lineTo(x + 1.5, y + REGION_HANDLE_H - 9);
  sctx.stroke();
}

export function drawDetectRegion(vx0, vx1) {
  const a = Math.min(S.detectRegion.t0, S.detectRegion.t1), b = Math.max(S.detectRegion.t0, S.detectRegion.t1);
  const rx0 = xOf(a), rx1 = xOf(b);
  if (rx1 < vx0 || rx0 > vx1) return;                    // fully off-screen
  const ch = contentH(), vy0 = scroll.scrollTop;
  const active = S.drag && (S.drag.mode === "region" || S.drag.mode === "regionEdge");
  sctx.fillStyle = hexA(PAINT.accent, active ? WASH : WASH / 2);
  sctx.fillRect(rx0, 0, Math.max(1, rx1 - rx0), ch);
  sctx.strokeStyle = PAINT.accent; sctx.lineWidth = 1.5;
  sctx.beginPath();
  sctx.moveTo(rx0 + 0.5, 0); sctx.lineTo(rx0 + 0.5, ch);
  sctx.moveTo(rx1 - 0.5, 0); sctx.lineTo(rx1 - 0.5, ch);
  sctx.stroke();
  sctx.lineWidth = 1;
  const hy = vy0 + (S.stageHeight - REGION_HANDLE_H) / 2;   // centered in the visible band
  drawRegionHandle(rx0, hy);
  drawRegionHandle(rx1, hy);
  // Range + duration chip, pinned to stay visible while the band is scrolled.
  const label = `Loop · ${fmtTime(a)}–${fmtTime(b)} · ${(b - a).toFixed(1)}s`;
  // A time range and a duration, both compared against the ones either side of
  // them — mono. Free-floating chip, so 11.
  sctx.font = stageMono(); sctx.textBaseline = "top";
  const tw = sctx.measureText(label).width;
  let lx = Math.max(rx0 + 6, vx0 + 4);
  lx = Math.min(lx, Math.max(rx0 + 6, rx1 - tw - 6));
  sctx.fillStyle = veil(); sctx.fillRect(lx - 3, vy0 + 4, tw + 6, 16);
  sctx.fillStyle = PAINT.text; sctx.fillText(label, lx, vy0 + 6);
  sctx.textBaseline = "alphabetic";                      // restore shared default
}

export function drawGrid() {
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  const ch = contentH(), dur = S.state.duration;
  const status = document.getElementById('autoGridStatus');
  if (status) {
    const segment = gridAt(S.drag?.resizeTime ?? timeAt(S.mouseX ?? scroll.scrollLeft));
    status.textContent = S.drag?.mode === 'resize' && S.drag.freeResize
      ? 'Free · Alt' : autoGridLabel(segment, displayGridStep(segment));
  }
  // Each tempo/meter segment tiles its own bar/beat grid forward from its marker
  // (a bar line) until the next marker. A partial cell before the next marker is
  // just left short — that's the seam a tempo change lands on.
  const segs = gridSegments();
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si], step = displayGridStep(seg);
    if (!step) continue;
    const segEnd = si + 1 < segs.length ? segs[si + 1].t : dur + 1e-6;
    for (let i = Math.max(0, Math.floor((vx0 / S.pxPerSec - seg.t) / step)); ; i++) {
      const t = seg.t + i * step;
      if (t > segEnd + 1e-6 || t > dur + 1e-6) break;
      const x = xOf(t);
      if (x > vx1) break;
      if (x < vx0 - 2) continue;
      paintTimeGridLine(sctx, x, 0, ch, gridLineKind(t, seg));
    }
  }
  sctx.lineWidth = 1;
}

export function drawRuler() {
  if (!S.state || !S.state.spec) return;
  const vy0 = scroll.scrollTop;   // ruler is fixed; shift labels to match the scrolled stage
  const dp = dpr();
  const hover = S.rulerHover ?? (S.pitchHoverClientY != null ? pitchAt(S.pitchHoverClientY - ruler.getBoundingClientRect().top + vy0) : null);
  const hoverY = hover == null ? null : yOf(hover) + S.state.rowH / 2 - vy0;
  const labelH = 14;
  // A ruler is the definition of measured, and one label per pitch row is the
  // definition of note-anchored — mono at the stage's 9. 500 was never a weight
  // this app loads; 400 is.
  // When pitch-zoomed the rows are tall enough to label every semitone, not just C.
  const everyNote = S.state.rowH >= 14;
  for (const scale of [ruler, rulerRight]) {
    if (!scale.clientWidth) continue;
    const rctx = scale.getContext("2d"), width = scale.width / dp;
    rctx.setTransform(dp, 0, 0, dp, 0, 0);
    rctx.clearRect(0, 0, width, S.stageHeight);
    rctx.font = stageMono(STAGE_ANCHORED); rctx.textAlign = "center";
    rctx.textBaseline = "alphabetic";
    for (let p = S.state.spec.midi_low; p <= S.state.spec.midi_high; p++) {
      const isC = p % 12 === 0;
      if (!isC && !everyNote) continue;
      const y = yOf(p) + S.state.rowH - vy0;
      if (y < -2 || y > S.stageHeight + 2) continue;
      rctx.fillStyle = isC ? PAINT.label : PAINT.hint;
      // Hidden only where the hover box would cut through the text: half the box
      // plus half the glyph height. A full labelH also swallowed the row above.
      if (hoverY == null || Math.abs(y - 6 - hoverY) > labelH / 2 + 5) rctx.fillText(noteName(p), width / 2, y - 2);
      rctx.strokeStyle = PAINT.line;
      rctx.beginPath(); rctx.moveTo(0, y); rctx.lineTo(width, y); rctx.stroke();
    }
    // The active pitch is independent of label density, including tiny rows.
    if (hoverY != null && hoverY >= -S.state.rowH && hoverY <= S.stageHeight + S.state.rowH) {
      const cy = Math.max(labelH / 2, Math.min(S.stageHeight - labelH / 2, hoverY));
      rctx.fillStyle = PAINT.chrome; rctx.fillRect(0, cy - labelH / 2, width, labelH);
      rctx.fillStyle = PAINT.text; rctx.textBaseline = "middle";
      rctx.fillText(noteName(hover), width / 2, cy);
      scale.setAttribute("aria-label", `${scale === rulerRight ? "Right" : "Left"} pitch scale, ${noteName(hover)}`);
    } else scale.setAttribute("aria-label", `${scale === rulerRight ? "Right" : "Left"} pitch scale`);
    rctx.textAlign = "left"; rctx.textBaseline = "alphabetic";
  }
}

// Screen positions of a bend's control points — used to draw the handles and to
// hit-test a drag on one, which is why it lives with the renderer rather than
// with the mouse code that grabs them.
export function bendHandles(n) {
  const pts = bendCurve(n);
  if (!pts) return [];
  const x = xOf(n.start), w = Math.max(2, xOf(n.end) - x), rowH = S.state.rowH;
  const ym = yOf(n.pitch) + rowH / 2;
  return pts.map(([t, v], i) => ({ i, note: n, x: x + w * t, y: ym - v * rowH }));
}

// Bend points on the same millisecond, the resolution Rocksmith reads them at:
// one { x, y, count } per such moment, at its first point. The export keeps only
// that first one.
export function stackedBendPoints(n) {
  const pts = bendCurve(n);
  if (!pts || pts.length < 2) return [];
  const handles = bendHandles(n), ms = (t) => Math.round(t * (n.end - n.start) * 1000), out = [];
  for (let i = 0, j; i < pts.length; i = j) {
    for (j = i + 1; j < pts.length && ms(pts[j][0]) === ms(pts[i][0]); j++);
    if (j - i > 1) out.push({ x: handles[i].x, y: handles[i].y, count: j - i });
  }
  return out;
}

// Find overlapping same-pitch note clusters within one edit lane. Fills the
// shared `counts` map (note -> cluster size) for recoloring, and pushes one
// badge per cluster (anchored at its earliest note) for the numbered marker.
export function collectStacks(lane, counts, badges) {
  const byPitch = new Map();
  for (const n of lane.notes) {
    let a = byPitch.get(n.pitch);
    if (!a) byPitch.set(n.pitch, (a = []));
    a.push(n);
  }
  for (const arr of byPitch.values()) {
    if (arr.length < 2) continue;
    arr.sort((p, q) => p.start - q.start);
    let i = 0;
    while (i < arr.length) {
      let j = i + 1, maxEnd = arr[i].end;
      // Require more than a hair of overlap so abutting notes whose end/start
      // differ only by float rounding (~1e-14 s) aren't flagged as a stack.
      while (j < arr.length && arr[j].start < maxEnd - OVERLAP_EPS) { maxEnd = Math.max(maxEnd, arr[j].end); j++; }
      const size = j - i;
      if (size >= 2) {
        for (let k = i; k < j; k++) counts.set(arr[k], size);
        badges.push({ note: arr[i], count: size });   // arr is start-sorted → arr[i] is the anchor
      }
      i = j;
    }
  }
}

// Numbered badge on each overlap cluster: a dark disc with a white count and a
// --error ring, so a 2-/3-/…-deep stack is obvious at a glance.
export function drawStackBadges(badges, vx0, vx1) {
  if (!badges.length) return;
  sctx.save();
  // A count, inside a 15px disc pinned to a note: mono, and 9 for both reasons.
  sctx.font = stageMono(STAGE_ANCHORED, 600);
  sctx.textAlign = "center"; sctx.textBaseline = "middle";
  for (const { note, count } of badges) {
    const x = xOf(note.start), y = yOf(note.pitch);
    if (x > vx1 || x + 18 < vx0) continue;
    const cx = x + 9, cy = y + S.state.rowH / 2, r = 7.5;
    sctx.beginPath(); sctx.arc(cx, cy, r, 0, Math.PI * 2);
    sctx.fillStyle = veil(PAINT.ground); sctx.fill();
    sctx.lineWidth = 2; sctx.strokeStyle = PAINT.error; sctx.stroke();
    sctx.fillStyle = PAINT.text; sctx.fillText(String(count), cx, cy + 0.5);
  }
  sctx.restore();
  sctx.lineWidth = 1;
}

// ---- centered note names and effect labels ----
const SLIDE_TAG = { shift: "↗", legato: "⌒↗", inBelow: "↗", inAbove: "↘", outDown: "↘", outUp: "↗" };

// Labels stay horizontal, including at the individual bend control points.
// Fit labels to the note dimensions as either zoom axis changes.
function centeredLabel(text, x, width, pitch, availableWidth = width) {
  paintNoteLabel(sctx, text, x, width, yOf(pitch) + S.state.rowH / 2, S.state.rowH, availableWidth);
}

function bendPitchName(pitch) {
  const cents = Math.round(pitch * 100), whole = Math.floor(cents / 100);
  const offset = cents - whole * 100;
  return noteName(whole) + (offset ? ` +${offset}ct` : "");
}

const hammerTagCache = new WeakMap();
const slideTargetCache = new WeakMap();
// Paired by the strings the voicer chose (the same ones the labels show), so a
// slide's ribbon follows the string the finger actually runs along.
export function laneSlides(lane) {
  const positions = positionsForLabels(lane);
  const hit = slideTargetCache.get(lane);
  if (hit?.revision === S.voicingRevision && hit.notes === lane.notes && hit.positions === positions) return hit.targets;
  const targets = slideTargets(lane.notes, (n) => positions.get(n) || n.pos);
  slideTargetCache.set(lane, { revision: S.voicingRevision, notes: lane.notes, positions, targets });
  return targets;
}

function laneHammerTags(lane) {
  const hit = hammerTagCache.get(lane);
  if (hit?.revision === S.voicingRevision && hit.notes === lane.notes) return hit.tags;
  const tags = hammerDirections(lane.notes);
  hammerTagCache.set(lane, { revision: S.voicingRevision, notes: lane.notes, tags });
  return tags;
}

const labelPositions = new WeakMap();
function positionsForLabels(lane) {
  const key = laneFingeringKey(lane);
  let entry = labelPositions.get(lane);
  if (entry?.key !== key) {
    entry?.controller.abort();
    entry = { key, controller: new AbortController(), voiced: new Map() };
    labelPositions.set(lane, entry);
    laneFingering(lane, entry.controller.signal).then(({ notes, voiced }) => {
      if (labelPositions.get(lane) !== entry) return;
      entry.voiced = sourceLabelPositions(lane.notes, notes, voiced); draw();
    }).catch(() => {});
  }
  return entry.voiced;
}

export function drawNoteFx() {
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  const options = spectrogramLabelOptions();
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    const positions = options.positions !== 'off' ? positionsForLabels(lane) : null;
    const capo = options.fromNut ? Number(lane.capo) || 0 : 0;
    const hammerTags = laneHammerTags(lane);
    const slides = laneSlides(lane);
    // Labels of a layer that is not being edited fade with its notes (draw.js).
    sctx.save();
    if (!lane.active || lane.locked) sctx.globalAlpha = 0.5;
    for (const n of lane.notes) {
      const x = xOf(n.start), x1 = xOf(n.end);
      const onto = slides.get(n), ribbon = slideRibbon(n, onto);
      const grace = graceBefore(n, gridAt(n.start)?.bpm || 120);
      if ((grace ? xOf(grace.start) : x) > vx1 || Math.max(x1, ribbon ? xOf(ribbon.end) : x1) < vx0) continue;
      const { mode, effects } = resolveNoteAppearance(options, S.hoverNote === n);
      const tags = effects ? noteMarks(n).map((m) => m === FX_GLYPHS.hammer ? hammerTags.get(n) || m : m) : [];
      if (effects && n.slide && !ribbon && !edgeSlide(n.slide)) tags.push(SLIDE_TAG[n.slide] || "slide");
      if (effects && n.harmonic) tags.push(HARMONIC_TAG[n.harmonic] || "harm.");
      const label = spectrogramLabel(n, positions?.get(n), mode, tags, capo);
      const curve = bendCurve(n);
      if (ribbon && !curve) {
        centeredLabel(label, x, 0, n.pitch, x1 - x);
        const arrow = onto.pitch < n.pitch ? "\u2198" : "\u2197";
        if (effects) centeredLabel((n.slide === "legato" ? "\u2312" : "") + arrow,
          x, xOf(ribbon.end) - x, (n.pitch + onto.pitch) / 2);
        if (n.slide === "shift") {
          const ax = xOf(onto.start) + 1, ay = yOf(onto.pitch), h = S.state.rowH;
          sctx.save(); sctx.lineCap = "round";
          sctx.beginPath(); sctx.moveTo(ax, ay - 2); sctx.lineTo(ax, ay + h + 2);
          sctx.lineWidth = 4; sctx.strokeStyle = halo(); sctx.stroke();
          sctx.lineWidth = 2; sctx.strokeStyle = PAINT.text; sctx.stroke();
          sctx.restore();
        }
      } else if (curve) {
        if (mode === 'notes' || mode === 'both') for (const [t, semi] of curve)
          centeredLabel(bendPitchName(n.pitch + semi), x + (x1 - x) * t, 0, n.pitch + semi, (x1 - x) / curve.length);
        const baseLabel = spectrogramLabel(n, positions?.get(n), mode === 'both' ? 'positions' : mode === 'notes' ? 'none' : mode, tags, capo);
        if (baseLabel) centeredLabel(baseLabel, x, x1 - x, n.pitch);
      } else if (label) centeredLabel(label, x, x1 - x, n.pitch);
      if (effects) paintSlideLabel(sctx, n.slide, x, x1, yOf(n.pitch) + S.state.rowH / 2, S.state.rowH);
      if (grace) {
        const gx = xOf(grace.start), width = Math.max(2, x - gx), pitch = n.pitch + grace.offset;
        paintNoteBar(sctx, gx, yOf(pitch), width, S.state.rowH, !lane.active || lane.locked ? grayHex(lane.color) : lane.color,
          S.selection.has(n), S.hoverNote === n);
      }
    }
    sctx.restore();
  }
}
