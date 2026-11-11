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
import { stackClusters, stackedBends } from "./note-issues.js";
import { paintNoteBar } from "./canvas-components.js";
import { graceBefore } from "./grace.js";
import { pitchCurve, whammyCurve } from "./whammy.js";
import { SLIDES_TO_NEXT, SLIDE_IN, SLIDE_OUT, bendAt, bendCurve, easedCurveAt, slideRibbon, slideStartOf, slideTargets, vibratoStartOf, vibratoEndOf } from "./bend.js";
import { REGION_GRAB, REGION_HANDLE_H, STAGE_ANCHORED, stageMono } from "./constants.js";
import { ruler, rulerRight, scroll, sctx } from "./dom.js";
import { laneFingering, laneFingeringKey } from "./tablature.js";
import { draw } from "./repaint.js";
import { edgeSlide, resolveNoteAppearance, sourceLabelPositions, spectrogramLabel, spectrogramLabelOptions } from "./spectrogram-labels.js";
import { paintNoteLabel, paintNoteLabelBeside, paintSlideLabel } from "./note-label-paint.js";
import { contentH, pitchAt, timeAt, xOf, yOf } from "./geometry.js";
import { gridAt, gridSegments, displayGridStep } from "./grid.js";
import { gridLineKind } from './auto-grid.js';
import { FX_GLYPHS, HARMONIC_TAG, noteMarks } from "./note-effects.js";
import { PAINT, WASH, halo, veil } from "./stage-paint.js";
import { S } from "./store.js";
import { rocksmithCountIn } from "./rocksmith-check.js";
import { hasFreeNoteLength } from './note-length.js';
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
  // Each tempo/meter segment tiles its own bar/beat grid forward from its marker
  // (a bar line) until the next marker. A partial cell before the next marker is
  // just left short — that's the seam a tempo change lands on.
  const segs = gridSegments();
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si], step = displayGridStep(seg);
    if (!step) continue;
    const segEnd = si + 1 < segs.length ? segs[si + 1].t : dur + 1e-6;
    // Into the leading silence, the first segment's grid runs back as the
    // export extends it (builder.py _grid_lead_in): from its COUNT phrase on,
    // the whole silence until the check says where that is.
    const lead = S.leadView || 0;
    const count = rocksmithCountIn(S.state.editLanes?.find((lane) => lane.active))?.count;
    const from = Math.max(-lead, Number.isFinite(count) ? count : -lead);
    const first = si === 0 ? Math.ceil((from - seg.t) / step - 1e-9) : 0;
    for (let i = Math.max(first, Math.floor((vx0 / S.pxPerSec - lead - seg.t) / step)); ; i++) {
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
// with the mouse code that grabs them. A whammy curve has its own (`kind`); each
// handle sits on the drawn line, which is bend and whammy together (pitchCurve).
export function bendHandles(n, kind = "bend") {
  const pts = kind === "whammy" ? whammyCurve(n) : bendCurve(n);
  if (!pts) return [];
  const other = kind === "whammy" ? bendCurve(n) : whammyCurve(n);
  const x = xOf(n.start), w = Math.max(2, xOf(n.end) - x), rowH = S.state.rowH;
  const ym = yOf(n.pitch) + rowH / 2;
  return pts.map(([t, v], i) => ({ i, kind, note: n, x: x + w * t, y: ym - (v + (other ? bendAt(other, t) : 0)) * rowH }));
}
export const curveHandles = (n) => [...bendHandles(n), ...bendHandles(n, "whammy")];

// Where a selected note's slide onto the next note leaves its fret or, for a
// slide into it, lands: the handle that drags that moment along
// the note. A bent note draws its bend instead of the slide ribbon, so it has no
// such handle. It sits just outside the note's row, on the side the slide does
// not go to, so it never covers the resize edge at the note's start or the
// ribbon. `bar` is the row edge its stem starts from.
export const SLIDE_HANDLE_GAP = 11;
export function slideStartHandle(n, lane) {
  const ribbon = !bendCurve(n) && lane ? noteRibbon(lane, n) : null;
  if (!ribbon) return null;
  const into = SLIDE_IN.has(n.slide);
  const t = n.start + (into ? ribbon.points[1][0] : slideStartOf(n)) * (n.end - n.start), rowH = S.state.rowH;
  const below = (into ? ribbon.points[0][1] : ribbon.points.at(-1)[1]) >= 0, bar = yOf(n.pitch) + (below ? rowH : 0);
  return { note: n, kind: "slide", x: xOf(t), bar, y: bar + (below ? SLIDE_HANDLE_GAP : -SLIDE_HANDLE_GAP) };
}

// The far end of a selected note's slide into or out of it: dragged up or down,
// it sets how many frets the slide spans.
export function slideFretsHandle(n, lane) {
  if (!(SLIDE_IN.has(n.slide) || SLIDE_OUT.has(n.slide)) || bendCurve(n) || !lane) return null;
  const ribbon = noteRibbon(lane, n);
  if (!ribbon) return null;
  const into = SLIDE_IN.has(n.slide), span = into ? ribbon.points[0][1] : ribbon.points.at(-1)[1];
  return { note: n, x: xOf(into ? n.start : n.end), y: yOf(n.pitch + span) + S.state.rowH / 2 };
}

// The drawn centre line of a note at time t, in stage px: its bend, or its slide
// ribbon, or its row. What the vibrato wave and handle sit on.
function noteCentreAt(n, lane, t, ribbonOverride = null) {
  const ribbon = ribbonOverride || (lane ? noteRibbon(lane, n) : null);
  const curve = pitchCurve(n) || ribbon?.points, end = !pitchCurve(n) && ribbon ? ribbon.end : n.end;
  const semi = curve ? easedCurveAt(curve, (t - n.start) / Math.max(1e-6, end - n.start)) : 0;
  return yOf(n.pitch) + S.state.rowH / 2 - semi * S.state.rowH;
}

// Where vibrato sets in: below the note where it is drawn at that moment, or
// above it when the slide's handle already sits below.
export function vibratoStartHandle(n, lane) {
  if (!n.fx?.vibrato || !lane) return null;
  const t = n.start + vibratoStartOf(n) * (n.end - n.start), rowH = S.state.rowH;
  const slide = slideStartHandle(n, lane), below = !(slide && slide.y > slide.bar);
  const bar = noteCentreAt(n, lane, t) + (below ? rowH / 2 : -rowH / 2);
  return { note: n, kind: "vibrato", x: xOf(t), bar, y: bar + (below ? SLIDE_HANDLE_GAP : -SLIDE_HANDLE_GAP) };
}

// Every effect-start handle of a note: where its slide leaves and its vibrato sets in.
export function vibratoEndHandle(n, lane) {
  const start = vibratoStartHandle(n, lane);
  if (!start) return null;
  const t = n.start + vibratoEndOf(n) * (n.end - n.start);
  const bar = noteCentreAt(n, lane, t) + start.bar - noteCentreAt(n, lane, n.start + vibratoStartOf(n) * (n.end - n.start));
  return { note: n, kind: "vibratoEnd", x: xOf(t), bar, y: bar + start.y - start.bar };
}
export const effectStartHandles = (n, lane) => [slideStartHandle(n, lane), vibratoStartHandle(n, lane), vibratoEndHandle(n, lane)].filter(Boolean);

// A vibrato drawn as a fine wave from where it sets in to the note's end,
// following the note's curve, under its label.
function paintVibratoWave(n, lane, ribbon = null) {
  const rowH = S.state.rowH, t0 = n.start + vibratoStartOf(n) * (n.end - n.start);
  const x0 = xOf(t0), x1 = xOf(n.start + vibratoEndOf(n) * (n.end - n.start));
  if (x1 - x0 < 6 || rowH < 7) return;
  const amp = Math.min(2, rowH * 0.12), lift = rowH * 0.3;
  sctx.save();
  sctx.beginPath();
  for (let x = x0; x <= x1; x += 1) {
    const y = noteCentreAt(n, lane, timeAt(x), ribbon) + lift - amp * Math.sin(((x - x0) / 8) * Math.PI * 2);
    if (x === x0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
  }
  sctx.lineJoin = "round";
  sctx.lineWidth = 3.5; sctx.strokeStyle = halo(); sctx.stroke();
  sctx.lineWidth = 1.5; sctx.strokeStyle = PAINT.text; sctx.stroke();
  sctx.restore();
}

// Bend points on the same millisecond, the resolution Rocksmith reads them at:
// one { x, y, count } per such moment, at its first point. The export keeps only
// that first one.
export function stackedBendPoints(n) {
  const handles = bendHandles(n);
  return stackedBends(n).map(({ index, count }) => ({ x: handles[index].x, y: handles[index].y, count }));
}

// Find overlapping same-pitch note clusters within one edit lane. Fills the
// shared `counts` map (note -> cluster size) for recoloring, and pushes one
// badge per cluster (anchored at its earliest note) for the numbered marker.
export function collectStacks(lane, counts, badges) {
  for (const cluster of stackClusters(lane.notes)) {
    for (const n of cluster) counts.set(n, cluster.length);
    badges.push({ note: cluster[0], count: cluster.length });   // start-sorted → the first is the anchor
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
  for (const { note, count, ignored } of badges) {
    const x = xOf(note.start), y = yOf(note.pitch);
    if (x > vx1 || x + 18 < vx0) continue;
    sctx.save(); if (ignored) sctx.globalAlpha *= .35;
    const cx = x + 9, cy = y + S.state.rowH / 2, r = 7.5;
    sctx.beginPath(); sctx.arc(cx, cy, r, 0, Math.PI * 2);
    sctx.fillStyle = veil(PAINT.ground); sctx.fill();
    sctx.lineWidth = 2; sctx.strokeStyle = PAINT.warn; sctx.stroke();
    sctx.fillStyle = PAINT.text; sctx.fillText(String(count), cx, cy + 0.5);
    sctx.restore();
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
// The fret a note is played on, as the labels show it: what limits how far a
// slide into or out of it reaches (bend.js slideReach).
export const slideFretOf = (lane, n) => positionsForLabels(lane).get(n)?.fret ?? n.pos?.fret;

// A note's slide ribbon as the stage draws it, or null.
export function noteRibbon(lane, n) {
  if (!n.slide) return null;
  if (SLIDES_TO_NEXT.has(n.slide)) return slideRibbon(n, laneSlides(lane).get(n));
  return slideRibbon(n, null, { fret: slideFretOf(lane, n), eighth: 30 / (gridAt(n.start)?.bpm || 120) });
}

// Notes a legato slide lands on: not picked again, so drawn as its ribbon goes on.
export const legatoTargets = (lane) =>
  new Set([...laneSlides(lane)].filter(([source]) => source.slide === "legato").map(([, target]) => target));

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
    // Keep showing the last labels until the new ones arrive (a drag defers them).
    entry = { key, controller: new AbortController(), voiced: entry?.voiced || new Map() };
    labelPositions.set(lane, entry);
    laneFingering(lane, entry.controller.signal).then(({ notes, voiced }) => {
      if (labelPositions.get(lane) !== entry) return;
      entry.voiced = sourceLabelPositions(lane.notes, notes, voiced); draw();
    }).catch(() => {});
  }
  return entry.voiced;
}

export function drawNoteFx(hiddenNote = null, preview = null) {
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  const options = spectrogramLabelOptions();
  const segments = gridSegments();
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    const positions = options.positions !== 'off' ? positionsForLabels(lane) : null;
    const capo = options.fromNut ? Number(lane.capo) || 0 : 0;
    const hammerTags = laneHammerTags(lane);
    const slides = laneSlides(lane);
    // Notes reached by a legato slide are not picked again: their names stand beside them.
    const slurred = legatoTargets(lane);
    // Labels of a layer that is not being edited fade with its notes (draw.js).
    sctx.save();
    if (!lane.active || lane.locked) sctx.globalAlpha = 0.5;
    const hasPreview = preview?.lane === lane;
    for (let ni = 0; ni < lane.notes.length + (hasPreview ? 1 : 0); ni++) {
      const isPreview = ni === lane.notes.length, n = isPreview ? preview.note : lane.notes[ni];
      if (!isPreview && n === hiddenNote) continue;
      const source = isPreview ? preview.source : n;
      const x = xOf(n.start), x1 = xOf(n.end);
      const sourceRibbon = noteRibbon(lane, source), sourceOnto = slides.get(source);
      const ratio = isPreview && source.end > source.start ? (n.end - n.start) / (source.end - source.start) : 1;
      const ribbon = sourceRibbon && isPreview ? { ...sourceRibbon, end: n.start + (sourceRibbon.end - source.start) * ratio } : sourceRibbon;
      const onto = sourceOnto && isPreview ? { ...sourceOnto, start: n.start + (sourceOnto.start - source.start) * ratio } : sourceOnto;
      const grace = graceBefore(n, gridAt(n.start)?.bpm || 120);
      if ((grace ? xOf(grace.start) : x) > vx1 || Math.max(x1, ribbon ? xOf(ribbon.end) : x1) < vx0) continue;
      if (isPreview) {
        sctx.save(); sctx.globalAlpha *= preview.alpha;
      }
      if (hasFreeNoteLength(n, segments)) {
        // A small hollow diamond distinguishes a free-length tail from effects
        // and diagnostics, even when note labels are hidden.
        const cy = yOf(n.pitch) + S.state.rowH / 2, r = Math.min(3, S.state.rowH / 3);
        sctx.save(); sctx.strokeStyle = PAINT.text; sctx.lineWidth = 1;
        sctx.beginPath(); sctx.moveTo(x1, cy - r); sctx.lineTo(x1 + r, cy);
        sctx.lineTo(x1, cy + r); sctx.lineTo(x1 - r, cy); sctx.closePath(); sctx.stroke(); sctx.restore();
      }
      const { mode, effects } = resolveNoteAppearance(options, !isPreview && S.hoverNote === n);
      const tags = effects ? noteMarks(n).map((m) => m === FX_GLYPHS.hammer ? hammerTags.get(source) || m : m) : [];
      if (effects && n.slide && !ribbon && !edgeSlide(n.slide)) tags.push(SLIDE_TAG[n.slide] || "slide");
      if (effects && n.slideIn && !ribbon) tags.push(SLIDE_TAG[n.slideIn] || "slide");
      if (effects && n.harmonic) tags.push(HARMONIC_TAG[n.harmonic] || "harm.");
      const curve = bendCurve(n);
      // A selected note being shaped shows its handles, not its names (they would cover them).
      const shaping = !isPreview && S.selection.has(n) && !!(ribbon || pitchCurve(n));
      const label = shaping ? "" : spectrogramLabel(n, positions?.get(source), mode, tags, capo);
      if (ribbon && !curve) {
        // The sliding part: after a late start, or before a slide-in lands (bend.js).
        const into = SLIDE_IN.has(n.slide), w = xOf(ribbon.end) - x;
        // The landing note of a slide-in is not picked again, so its name stands beside it.
        if (into) paintNoteLabelBeside(sctx, label, x1, "right", yOf(n.pitch) + S.state.rowH / 2, S.state.rowH, x1 - x);
        else if (edgeSlide(n.slide)) paintNoteLabelBeside(sctx, label, x, "left", yOf(n.pitch) + S.state.rowH / 2, S.state.rowH, x1 - x);
        else centeredLabel(label, x, 0, n.pitch, x1 - x);
        // A slide into or out of nowhere has no note at its far end, so name that pitch beside it.
        if (edgeSlide(n.slide) && !shaping) {
          const [t, semi] = into ? ribbon.points[0] : ribbon.points.at(-1), pos = positions?.get(source);
          const far = spectrogramLabel({ pitch: n.pitch + semi }, pos && { ...pos, fret: pos.fret + semi }, mode, [], capo);
          paintNoteLabelBeside(sctx, far, x + w * t, into ? "left" : "right", yOf(n.pitch + semi) + S.state.rowH / 2,
            S.state.rowH, xOf(ribbon.end) - x);
        }
        if (n.slide === "shift") {
          const ax = xOf(onto.start) + 1, ay = yOf(onto.pitch), h = S.state.rowH;
          sctx.save(); sctx.lineCap = "round";
          sctx.beginPath(); sctx.moveTo(ax, ay - 2); sctx.lineTo(ax, ay + h + 2);
          sctx.lineWidth = 4; sctx.strokeStyle = halo(); sctx.stroke();
          sctx.lineWidth = 2; sctx.strokeStyle = PAINT.text; sctx.stroke();
          sctx.restore();
        }
      } else if (curve) {
        if (!shaping && (mode === 'notes' || mode === 'both')) for (const [t, semi] of curve)
          centeredLabel(bendPitchName(n.pitch + semi), x + (x1 - x) * t, 0, n.pitch + semi, (x1 - x) / curve.length);
        const baseLabel = !shaping && spectrogramLabel(n, positions?.get(source), mode === 'both' ? 'positions' : mode === 'notes' ? 'none' : mode, tags, capo);
        if (baseLabel) centeredLabel(baseLabel, x, x1 - x, n.pitch);
      } else if (label && slurred.has(source)) paintNoteLabelBeside(sctx, label, x1, "right", yOf(n.pitch) + S.state.rowH / 2, S.state.rowH, x1 - x);
      else if (label) centeredLabel(label, x, x1 - x, n.pitch);
      if (effects && !ribbon) paintSlideLabel(sctx, n.slide, x, x1, yOf(n.pitch) + S.state.rowH / 2, S.state.rowH);
      if (effects && n.fx?.vibrato) paintVibratoWave(n, lane, isPreview ? ribbon : null);
      if (grace) {
        const gx = xOf(grace.start), width = Math.max(2, x - gx), pitch = n.pitch + grace.offset;
        paintNoteBar(sctx, gx, yOf(pitch), width, S.state.rowH, !lane.active || lane.locked ? grayHex(lane.color) : lane.color,
          !isPreview && S.selection.has(n), !isPreview && S.hoverNote === n);
      }
      if (isPreview) sctx.restore();
    }
    sctx.restore();
  }
}
