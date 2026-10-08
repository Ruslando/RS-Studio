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

import { BEND_TAG, bendCurve, bendPeak } from "./bend.js";
import { OVERLAP_EPS, REGION_GRAB, REGION_HANDLE_H, STAGE_ANCHORED, stageMono, stageUi } from "./constants.js";
import { ruler, rulerRight, scroll, sctx } from "./dom.js";
import { contentH, pitchAt, xOf, yOf } from "./geometry.js";
import { gridSegments, gridSubdiv, segStep } from "./grid.js";
import { FX_GLYPHS, HARMONIC_TAG, noteMarks } from "./note-effects.js";
import { PAINT, WASH, halo, veil } from "./stage-paint.js";
import { S } from "./store.js";
import { dpr, fmtTime, hexA, noteName } from "./util.js";

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
  const label = `${fmtTime(a)}–${fmtTime(b)} · ${(b - a).toFixed(1)}s`;
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
    const seg = segs[si], step = segStep(seg);
    if (!step) continue;
    const sub = Math.max(1, parseInt(seg.subdiv, 10) || gridSubdiv() || 1);
    const segEnd = si + 1 < segs.length ? segs[si + 1].t : dur + 1e-6;
    const barSteps = sub * (parseInt(seg.tsNum, 10) || 4);
    for (let i = Math.max(0, Math.floor((vx0 / S.pxPerSec - seg.t) / step)); ; i++) {
      const t = seg.t + i * step;
      if (t > segEnd + 1e-6 || t > dur + 1e-6) break;
      const x = xOf(t);
      if (x > vx1) break;
      if (x < vx0 - 2) continue;
      if (i % barSteps === 0) { sctx.strokeStyle = PAINT.gridBar; sctx.lineWidth = 2; }
      else if (i % sub === 0) { sctx.strokeStyle = PAINT.gridBeat; sctx.lineWidth = 1; }
      else { sctx.strokeStyle = PAINT.gridSub; sctx.lineWidth = 1; }
      sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, ch); sctx.stroke();
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
      if (hoverY == null || Math.abs(y - 6 - hoverY) > labelH) rctx.fillText(noteName(p), width / 2, y - 2);
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
  sctx.font = stageMono(STAGE_ANCHORED, 700);
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

// ---- note-effect glyphs (slides / bends / harmonics / fx tags) ----
// One shared look so the effects read as a family: soft-white strokes with round
// caps, filled arrowheads for direction, dark-haloed tags for text.
const FX_COLOR = PAINT.text;

// Every tag here sits on a note, so 9. Hanken, not mono, because these are
// notation abbreviations — H, P.H., pre·r, ½ — that read as words even when a
// couple of them contain a number. Bend amounts ride along rather than splitting
// the family in two: "one shared look" above is the point of this block.
const FX_FONT = stageUi(STAGE_ANCHORED, 600);

function fxStroke() {
  sctx.strokeStyle = FX_COLOR; sctx.fillStyle = FX_COLOR;
  sctx.lineWidth = 1.75; sctx.lineCap = "round"; sctx.lineJoin = "round";
}

// Filled arrowhead, tip at (x, y), pointing along `ang` (radians, 0 = right).
function fxArrow(x, y, ang, size = 4.5) {
  sctx.save();
  sctx.translate(x, y); sctx.rotate(ang);
  sctx.beginPath();
  sctx.moveTo(0.5, 0); sctx.lineTo(-size, size * 0.55); sctx.lineTo(-size, -size * 0.55);
  sctx.closePath(); sctx.fill();
  sctx.restore();
}

// Dark-haloed tag, legible over any spectrogram color. Leaves ctx state as found.
function fxLabel(text, x, y) {
  sctx.save();
  sctx.lineWidth = 3; sctx.lineJoin = "round"; sctx.strokeStyle = halo();
  sctx.strokeText(text, x, y);
  sctx.fillStyle = PAINT.text; sctx.fillText(text, x, y);
  sctx.restore();
}

// Draw a glide from each note marked with a slide toward its target — flat out
// of the source, diving into the destination, arrowhead on the landing end —
// matching how it exports to Guitar Pro. Dashed = legato (slurred).
// A slide is drawn from a note to whatever the next note in time is, so this
// needs the lane in time order. Cached per lane against S.voicingRevision, which
// every edit bumps: this runs once per frame, on a path that fires on every
// mousemove over the stage, and it was copying and sorting the whole lane each
// time.
const sortedLaneCache = new WeakMap();
function notesByTime(lane) {
  const hit = sortedLaneCache.get(lane);
  if (hit && hit.revision === S.voicingRevision) return hit.sorted;
  const sorted = [...lane.notes].sort((a, b) => a.start - b.start);
  sortedLaneCache.set(lane, { revision: S.voicingRevision, sorted });
  return sorted;
}

export function drawSlides() {
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  sctx.save(); fxStroke();
  for (const lane of S.state.lanes) {
    if (!lane.visible || !lane.notes.some((n) => n.slide)) continue;
    const sorted = notesByTime(lane);
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      if (!n.slide) continue;
      const x0 = xOf(n.start), x1 = xOf(n.end), ym = yOf(n.pitch) + S.state.rowH / 2, d = S.state.rowH * 0.8;
      let ax, ay, bx, by;
      if (n.slide === "shift" || n.slide === "legato") {       // connect to the next note
        const nxt = sorted[i + 1];
        ax = x1; ay = ym;
        bx = nxt ? xOf(nxt.start) : x1 + 14;
        by = nxt ? yOf(nxt.pitch) + S.state.rowH / 2 : ym;
      } else if (n.slide === "outUp") { ax = x1; ay = ym; bx = x1 + 14; by = ym - d; }
      else if (n.slide === "outDown") { ax = x1; ay = ym; bx = x1 + 14; by = ym + d; }
      else if (n.slide === "inBelow") { ax = x0 - 14; ay = ym + d; bx = x0; by = ym; }
      else if (n.slide === "inAbove") { ax = x0 - 14; ay = ym - d; bx = x0; by = ym; }
      else continue;
      if (Math.max(ax, bx) < vx0 || Math.min(ax, bx) > vx1) continue;
      // Control point holds the source pitch to mid-run, so the curve leaves
      // flat and dives into the target — reads as a glide, not a plain diagonal.
      const cx = (ax + bx) / 2, cy = ay;
      sctx.setLineDash(n.slide === "legato" ? [5, 4] : []);
      sctx.beginPath(); sctx.moveTo(ax, ay); sctx.quadraticCurveTo(cx, cy, bx, by); sctx.stroke();
      sctx.setLineDash([]);
      fxArrow(bx, by, Math.atan2(by - cy, bx - cx));
    }
  }
  sctx.restore();
}

// The bend itself is drawn by the note bar — draw.js runs the bar along the
// audible pitch curve. Here we only add the amount tag over the curve's peak,
// plus the prebend pre-arrow (the push that happens before the pick, so it has
// no on-note trajectory of its own to show).
export function drawBends() {
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  sctx.save(); fxStroke();
  sctx.font = FX_FONT; sctx.textAlign = "center"; sctx.textBaseline = "alphabetic";
  for (const lane of S.state.lanes) {
    if (!lane.visible || !lane.notes.some((n) => n.bend)) continue;
    for (const n of lane.notes) {
      const pts = bendCurve(n);
      if (!pts) continue;
      const x0 = xOf(n.start), x1 = xOf(n.end);
      if (x1 < vx0 || x0 > vx1) continue;
      const rowH = S.state.rowH, ymid = yOf(n.pitch) + rowH / 2;
      const peak = bendPeak(pts), at = pts.find((p) => p[1] === peak);
      if (pts[0][1] > 0) {   // pre-bent: arrow into the raised starting pitch
        const ax = x0 + 3, top = ymid - pts[0][1] * rowH - rowH * 0.9;
        sctx.beginPath(); sctx.moveTo(ax, ymid - 1); sctx.lineTo(ax, top + 4); sctx.stroke();
        fxArrow(ax, top, -Math.PI / 2);
      }
      fxLabel(BEND_TAG[n.bend] || "", x0 + (x1 - x0) * at[0], ymid - peak * rowH - rowH / 2 - 3);
    }
  }
  sctx.restore();
}

// Small tag below each note marked with a harmonic (◇ = natural, P.H. = pinch).
// Sits under the note to stay clear of the fx tags / bend arc above it.
export function drawHarmonics() {
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  sctx.save();
  sctx.font = FX_FONT; sctx.textBaseline = "alphabetic";
  for (const lane of S.state.lanes) {
    if (!lane.visible || !lane.notes.some((n) => n.harmonic)) continue;
    for (const n of lane.notes) {
      if (!n.harmonic) continue;
      const x = xOf(n.start);
      if (x > vx1 || xOf(n.end) < vx0) continue;
      fxLabel(HARMONIC_TAG[n.harmonic] || "", x + 1, yOf(n.pitch) + S.state.rowH + 9);
    }
  }
  sctx.restore();
}

// Vibrato is a pitch effect, so it draws as a pitch shape like bends/slides do:
// a small sine wave spanning the note, just above the bar.
function drawVibratoWave(x0, x1, y) {
  sctx.save(); fxStroke(); sctx.lineWidth = 1.5;
  sctx.beginPath();
  sctx.moveTo(x0, y);
  for (let x = x0 + 2; x <= x1; x += 2) sctx.lineTo(x, y + Math.sin(((x - x0) / 8) * Math.PI * 2) * 2);
  sctx.stroke(); sctx.restore();
}

// Tiny tags above each note carrying short-form effects (the fx toggles plus
// grace/trill/tremolo-pick/slap/stroke/whammy — see noteMarks). Slide, bend,
// harmonic and vibrato draw their own shapes.
export function drawNoteFx() {
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth;
  sctx.save();
  sctx.font = FX_FONT; sctx.textBaseline = "alphabetic";
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    for (const n of lane.notes) {
      const vib = !!(n.fx && n.fx.vibrato);
      const marks = vib ? noteMarks(n).filter((m) => m !== FX_GLYPHS.vibrato) : noteMarks(n);
      if (!marks.length && !vib) continue;
      const x = xOf(n.start), x1 = xOf(n.end);
      if (x > vx1 || x1 < vx0) continue;
      let ty = yOf(n.pitch) - 2;
      if (vib) {
        // Limitation: wave sits on the home row even when the bar bends away
        drawVibratoWave(x + 1, Math.max(x + 9, x1 - 1), yOf(n.pitch) - 5);
        ty -= 8;                           // remaining tags stack above the wave
      }
      if (marks.length) fxLabel(marks.join(" "), x + 1, ty);
    }
  }
  sctx.restore();
}
