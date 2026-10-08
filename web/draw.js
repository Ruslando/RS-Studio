import { paintNoteBar, paintNoteGlow } from "./canvas-components.js";
import { beginNoteMotionFrame, beginNotePlaybackFrame, noteMotion, noteMotionGhosts, notePlaybackGlow } from "./note-motion.js";
// Canvas rendering: the main spectrogram + notes draw loop, the overview minimap
// (whole-song strip with a viewport window), and the hover highlight / cursor line.

import { bendCurve, bendPeak } from "./bend.js";
import { BEND_HANDLE_R, MM_HEAD, RULER_W, STAGE_ANCHORED, STAGE_HEIGHT_MIN, stageMono, stageUi } from "./constants.js";
import { bendHandles, collectStacks, drawBends, drawDetectRegion, drawGrid, drawHarmonics, drawNoteFx, drawRuler, drawSlides, drawStackBadges, regionEdgeAt } from "./note-render.js";
import { editorEl, minimap, mmctx, overviewRuler, overviewRulerCtx, ruler, rulerRight, scroll, sctx, stage, viewer } from "./dom.js";
import { draw, drawNow, setPainter } from "./repaint.js";
import { hideNoteMenu } from "./edit.js";
import { drawFretboard } from "./fretboard.js";
import { drawMarkers, drawMinimapMarkers, markerCursorAt } from "./markers.js";
import { markerRails, overviewMarkerRails, railScale, railsBottom, railsHidden } from "./marker-rails.js";
import { contentH, layout, pitchAt, songWidth, timeAt, xOf, yOf } from "./geometry.js";
import { edgeOf, localXY, pickNote } from "./interaction.js";
import { activeLane } from "./lanes.js";
import { auditionNote, playbackTime, transportPlaying } from "./playback.js";
import { drawReferences, refBadgeAt, refBoxEdgeAt } from "./references.js";
import { shapeGroups } from "./shapes.js";
import { songBarStarts } from "./song-bars.js";
import { PAINT, UI_PAINT, WASH, halo, veil, wash } from "./stage-paint.js";
import { S } from "./store.js";
import { laneTuning } from "./tablature.js";
import { cancelHoverPreview, drawHeatThresholdOverlay, drawMatches, drawTracePath, drawTraceRange, matchAt, scheduleHoverMatchPreview, setPlaybackCursor } from "./tracing.js";
import { dpr, hexA, noteName } from "./util.js";
import { moveViewportTo } from "./viewport-motion.js";
import { addedArrangementNotes, omittedArrangementNotes, outOfFretboardRange } from "./voicing-core.js";

const overrideEffectCache = new WeakMap();
const overrideEffectJobs = new WeakMap();
const omittedArrangementCache = new WeakMap();

function overrideEffectKey(lane, tuning) {
  return `${S.voicingRevision}:${tuning.join(",")}:${songBarStarts().join(",")}`;
}

// Indirect override effects need two whole-lane voicing passes, and the recall
// review needs another. Keep that work out of the animation-frame paint path and
// reuse it until the edit revision or layer preferences change. Direct markers do
// not wait for this result.
//
// It used to skip the job entirely for a lane carrying no overrides, which is
// most lanes. The review has no such exemption — every automatic column is one
// the voicer may have answered out of its memory — so the only lane with nothing
// to say is one where every note is already pinned.
function overrideEffectsForLane(lane) {
  if (!lane.notes.length || lane.notes.every((note) => note.pos || note.arrangement)) {
    overrideEffectJobs.get(lane)?.worker.terminate();
    overrideEffectJobs.delete(lane);
    overrideEffectCache.delete(lane);
    return null;
  }
  const tuning = laneTuning(lane), key = overrideEffectKey(lane, tuning);
  const cached = overrideEffectCache.get(lane);
  if (cached?.key === key) return cached;
  const pending = overrideEffectJobs.get(lane);
  if (pending?.key === key) return null;
  pending?.worker.terminate();

  const sourceNotes = lane.notes;
  let worker;
  try {
    worker = new Worker(new URL("./voicing-worker.js", import.meta.url), { type: "module" });
    overrideEffectJobs.set(lane, { key, worker });
    worker.onmessage = (event) => {
      if (event.data.task !== "overrideEffects") return;
      worker.terminate();
      if (overrideEffectJobs.get(lane)?.worker !== worker) return;
      overrideEffectJobs.delete(lane);
      if (lane.notes !== sourceNotes || overrideEffectKey(lane, laneTuning(lane)) !== key) return;
      const effects = new Map(), review = new Map();
      (event.data.kinds || []).forEach((kind, index) => {
        if (kind && sourceNotes[index]) effects.set(sourceNotes[index], kind);
      });
      (event.data.review || []).forEach((gap, index) => {
        if (gap != null && sourceNotes[index]) review.set(sourceNotes[index], gap);
      });
      overrideEffectCache.set(lane, { key, effects, review });
      draw();
    };
    worker.onerror = () => {
      worker.terminate();
      if (overrideEffectJobs.get(lane)?.worker !== worker) return;
      overrideEffectJobs.delete(lane);
      if (overrideEffectKey(lane, laneTuning(lane)) === key)
        overrideEffectCache.set(lane, { key, effects: new Map(), review: new Map() });
    };
    worker.postMessage({
      task: "overrideEffects",
      notes: sourceNotes,
      tuning,
      bars: songBarStarts(),
      instrument: lane.instrument,
      holds: lane.handHolds,
    });
  } catch {
    worker?.terminate();
    overrideEffectJobs.delete(lane);
    overrideEffectCache.set(lane, { key, effects: new Map(), review: new Map() });
  }
  return null;
}

// A legacy `arrangement` both drops notes and adds them. Cross out what it drops,
// ghost what it adds — showing only the crosses made every swap read as a
// deletion. Applying now rewrites the notes instead, so nothing new lands here.
function arrangementMarksForLane(lane) {
  const cached = omittedArrangementCache.get(lane);
  if (cached?.revision === S.voicingRevision && cached.notes === lane.notes) return cached.marks;
  const arranged = lane.notes.some((note) => note.arrangement);
  const marks = {
    omitted: arranged ? omittedArrangementNotes(lane.notes) : new Set(),
    added: arranged ? addedArrangementNotes(lane.notes) : [],
  };
  omittedArrangementCache.set(lane, {
    revision: S.voicingRevision,
    notes: lane.notes,
    marks,
  });
  return marks;
}

// Draw after every note bar so an overlapping retained duplicate cannot cover
// the mark. The dark wash plus crossed diagonals remains legible on every lane
// color and makes it clear the annotation still exists but is not performed.
function drawOmittedNoteCrosses(items) {
  sctx.save();
  sctx.lineCap = "round";
  for (const { x, y, w, h, alpha } of items) {
    const inset = Math.min(2, w / 4, h / 4);
    sctx.globalAlpha = alpha;
    sctx.fillStyle = veil(PAINT.ground);
    sctx.fillRect(x, y, w, h);
    const cross = () => {
      sctx.beginPath();
      sctx.moveTo(x + inset, y + inset);
      sctx.lineTo(x + w - inset, y + h - inset);
      sctx.moveTo(x + inset, y + h - inset);
      sctx.lineTo(x + w - inset, y + inset);
      sctx.stroke();
    };
    sctx.lineWidth = 4;
    sctx.strokeStyle = halo();
    cross();
    sctx.lineWidth = 2;
    sctx.strokeStyle = PAINT.error;
    cross();
  }
  sctx.restore();
}

// A hatched amber overlay, deliberately unlike the dark crossed-out wash that
// marks a note the arrangement drops on purpose: this one is not a choice.
function drawOutOfRangeNotes(items) {
  sctx.save();
  for (const { x, y, w, h, alpha } of items) {
    sctx.globalAlpha = alpha;
    sctx.save();
    sctx.beginPath(); sctx.rect(x, y, w, h); sctx.clip();
    sctx.fillStyle = hexA(PAINT.warn, 0.22);
    sctx.fillRect(x, y, w, h);
    sctx.lineWidth = 1.5; sctx.strokeStyle = hexA(PAINT.warn, 0.85);
    sctx.beginPath();
    for (let o = -h; o < w; o += 5) { sctx.moveTo(x + o, y + h); sctx.lineTo(x + o + h, y); }
    sctx.stroke();
    sctx.restore();
    sctx.lineWidth = 1.5; sctx.strokeStyle = PAINT.warn;
    sctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
  }
  sctx.restore();
}

// Pitches with no backing note object: the ones a legacy `arrangement` plays.
// Dashed "ghost" bars, so a shape that trades one note for another reads as a
// trade rather than a deletion.
function drawGhostNotes(added) {
  if (!added?.length) return;
  const rowH = S.state.rowH;
  sctx.save();
  sctx.lineCap = "round";
  sctx.font = stageMono(STAGE_ANCHORED); sctx.textAlign = "left"; sctx.textBaseline = "middle";
  for (const { pitch, start, end, alpha } of added) {
    sctx.globalAlpha = alpha ?? 1;
    const x = xOf(start), w = Math.max(2, xOf(end) - x), y = yOf(pitch);
    sctx.fillStyle = hexA(PAINT.ok, 0.28);
    sctx.fillRect(x, y, w, rowH);
    sctx.setLineDash([4, 3]);
    sctx.lineWidth = 2; sctx.strokeStyle = PAINT.ok;
    sctx.strokeRect(x + 1, y + 1, w - 2, rowH - 2);
    sctx.setLineDash([]);
    const label = "+" + noteName(pitch);
    const tw = sctx.measureText(label).width;
    if (w >= tw + 6) {
      const ly = y + rowH / 2;
      sctx.lineWidth = 2.5; sctx.strokeStyle = halo();
      sctx.strokeText(label, x + 3, ly);
      sctx.lineWidth = 1; sctx.fillStyle = PAINT.ok;
      sctx.fillText(label, x + 3, ly);
    }
  }
  sctx.restore();
}

// Center-line of a bent note's audible pitch: a run through the curve's control
// points, eased between them so the bar reads as a bend rather than a staircase.
// Stroked with lineWidth = rowH this renders the note bar itself bending.
function traceBendPath(x, w, ym, pts, rowH) {
  const px = (t) => x + w * t, py = (v) => ym - v * rowH;
  sctx.moveTo(px(pts[0][0]), py(pts[0][1]));
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
    if (v0 === v1) { sctx.lineTo(px(t1), py(v1)); continue; }
    const xm = (px(t0) + px(t1)) / 2;
    sctx.bezierCurveTo(xm, py(v0), xm, py(v1), px(t1), py(v1));
  }
}

// Screen positions of a note's bend control points, in world px. Shared with
// interaction.js, which hit-tests these to drag / add / remove them.
// Handles for the selected notes only — the curve is otherwise just drawn, so an
// unselected lane full of bends stays readable.
function drawBendHandles() {
  for (const n of S.selection) {
    if (!n.bend) continue;
    const handles = bendHandles(n);
    if (!handles.length) continue;
    sctx.save();
    sctx.lineWidth = 1.5; sctx.strokeStyle = halo(); sctx.fillStyle = PAINT.accent;
    for (const h of handles) {
      sctx.beginPath(); sctx.arc(h.x, h.y, BEND_HANDLE_R, 0, Math.PI * 2);
      sctx.fill(); sctx.stroke();
    }
    sctx.restore();
  }
}

// A dashed purple envelope makes the otherwise independent note onsets read as
// one maintained fretting shape. The notes themselves remain fully visible and
// editable; this is relationship metadata, not a time/pitch selection box.
function drawShapes(vx0, vx1) {
  const active = activeLane();
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    // Measure each group ONCE, then sort on the measurement. This used to sort
    // with `Math.min(...a.map(n => n.start))` in the comparator — a map and a
    // spread per comparison, so O(n log n) allocations every frame, on a path
    // that runs on every mousemove over the stage. Two of the four bounds were
    // then recomputed a third time inside the loop body.
    const groups = [...shapeGroups(lane.notes).values()].map((notes) => {
      let t0 = Infinity, t1 = -Infinity, pLo = Infinity, pHi = -Infinity;
      for (const n of notes) {
        if (n.start < t0) t0 = n.start;
        if (n.end > t1) t1 = n.end;
        if (n.pitch < pLo) pLo = n.pitch;
        if (n.pitch > pHi) pHi = n.pitch;
      }
      return { notes, t0, t1, pLo, pHi };
    }).sort((a, b) => a.t0 - b.t0);
    groups.forEach(({ t0, t1, pLo, pHi }, index) => {
      const x0 = xOf(t0) - 4;
      const x1 = xOf(t1) + 4;
      if (x0 > vx1 || x1 < vx0) return;
      // yOf grows downward, so the highest pitch gives the smallest y.
      const y0 = yOf(pHi) - 5;
      const y1 = yOf(pLo) + S.state.rowH + 5;
      sctx.save();
      sctx.globalAlpha = lane === active ? 0.95 : 0.55;
      sctx.strokeStyle = PAINT.shape; sctx.fillStyle = wash(PAINT.shape);
      sctx.lineWidth = 1.5; sctx.setLineDash([6, 4]);
      sctx.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
      sctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, y1 - y0 - 1));
      sctx.setLineDash([]);
      const label = `Shape ${index + 1}`;
      // Drawn above the box, not inside it, so nothing clips it — free-floating 11.
      sctx.font = stageUi(11, 700); sctx.textAlign = "left"; sctx.textBaseline = "bottom";
      const labelX = Math.max(x0 + 3, vx0 + 3), labelY = y0 - 2;
      sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.strokeText(label, labelX, labelY);
      sctx.lineWidth = 1; sctx.fillStyle = PAINT.shape; sctx.fillText(label, labelX, labelY);
      sctx.restore();
    });
  }
}

// The frame itself. Registered with repaint.js at boot; everything else asks for
// a paint through draw()/drawNow() there and never imports this module.
function paintFrame() {
  beginNoteMotionFrame(S.state, S.drag);
  const playheadTime = playbackTime();
  beginNotePlaybackFrame(S.state, playheadTime, transportPlaying());
  // The fretboard is its own canvas below the stage, and it is painted here so
  // that every existing repaint trigger — the playback loop above all — moves the
  // hand too. Ahead of the guards below because the neck is drawn with or without
  // a project, and it has its own.
  drawFretboard();
  if (!S.state || !S.state.spec) return;   // spec is set by selectStem; nothing to paint before then
  if (editorEl.hidden || viewer.clientWidth <= RULER_W || viewer.clientHeight < 1) return;
  // layout() primes the fixed ruler width before measuring #scroll. This is a
  // last-resort recovery if stylesheet loading or a future CSS change ever lets
  // the ruler consume the row again.
  if (scroll.clientWidth < 1) layout();
  if (scroll.clientWidth < 1) return; // hidden/zero viewport must not clear or shrink the canvas
  // Project loading can reveal the app before its flex layout has reached the
  // final size. Keep both canvas axes tied to the live parent viewport: a stale
  // height compresses/clips the spectrogram just as badly as a stale width. The
  // mismatch branch is cheap and layout() only rewrites canvas backing stores
  // when their dimensions actually changed.
  const dp = dpr();
  const liveH = Math.max(STAGE_HEIGHT_MIN, viewer.clientHeight);
  if (stage.width !== Math.round(scroll.clientWidth * dp) ||
      stage.height !== Math.round(liveH * dp) || S.stageHeight !== liveH) layout();
  const vx0 = scroll.scrollLeft, vx1 = vx0 + scroll.clientWidth; // visible range (world px)
  const vy0 = scroll.scrollTop;                                  // vertical scroll (pitch-zoom)
  // Clear the small canvas in device space, then shift into world space so all
  // the drawing below stays in absolute song px (x = time * pxPerSec, y from the top
  // of the full pitch range), offset by the scroll position on both axes. The dp
  // scale maps those CSS-px coordinates onto the HiDPI backing store.
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, stage.width, stage.height);
  sctx.fillStyle = PAINT.ground;
  sctx.fillRect(0, 0, stage.width, stage.height);
  sctx.setTransform(dp, 0, 0, dp, -vx0 * dp, -vy0 * dp);
  if (S.spectImg) {
    // Draw only the visible time-slice of the spectrogram, not the whole image.
    const iw = S.spectImg.width;
    const t0 = Math.max(0, vx0 / S.pxPerSec), t1 = Math.min(S.state.duration, vx1 / S.pxPerSec);
    if (t1 > t0) {
      sctx.drawImage(S.spectImg,
        (t0 / S.state.duration) * iw, 0, ((t1 - t0) / S.state.duration) * iw, S.spectImg.height,
        t0 * S.pxPerSec, 0, (t1 - t0) * S.pxPerSec, contentH());
    }
  }
  drawRuler();   // depends on rowH + vertical scroll, so repaint alongside the stage
  drawHeatThresholdOverlay();

  sctx.strokeStyle = PAINT.gridSub;
  for (let p = S.state.spec.midi_low; p <= S.state.spec.midi_high; p++) {
    if (p % 12 !== 0) continue;
    const y = yOf(p) + S.state.rowH;
    sctx.beginPath(); sctx.moveTo(vx0, y); sctx.lineTo(vx1, y); sctx.stroke();
  }
  drawGrid();
  if (S.detectRegion) drawDetectRegion(vx0, vx1);
  if (S.drag && S.drag.mode === "trace") drawTraceRange(S.drag.points);
  else if ((S.toolMode === "trace" || S.heatPreview) && S.mouseX != null && S.mouseY != null) drawTraceRange([[S.mouseX, S.mouseY]]);

  // Overlap stacks (same pitch + overlapping time inside one edit lane) are no
  // longer merged — flag them with a hot color + a count badge instead.
  const stackCount = new Map();   // note -> how many notes share its overlap cluster (>=2)
  const stackBadges = [];         // one badge per cluster, drawn on top of the notes
  for (const lane of S.state.lanes) {
    if (lane.visible) collectStacks(lane, stackCount, stackBadges);
  }
  // Note-name labels show at every pitch-zoom level (the rows can be a touch
  // shorter than the font at the lowest zoom, but the text stays legible); each
  // note still has to be wide enough or it's skipped, so labels never overflow
  // their note horizontally. A pitch sorts, so mono — which is wider per glyph
  // than the sans this used to be, and that width is spent out of the same
  // budget as the skip test above: a few narrow notes lose their name. Worth it
  // for octave digits that line up down a column.
  sctx.font = stageMono(STAGE_ANCHORED); sctx.textAlign = "left"; sctx.textBaseline = "middle";
  const actLane = activeLane();
  const omittedCrosses = [];
  const outOfRange = [];
  const ghostNotes = [];
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    const voicingMarks = overrideEffectsForLane(lane);
    const { omitted: omittedNotes, added: addedNotes } = arrangementMarksForLane(lane);
    // Every lane has a tuning and the fretboard will voice against it, whether
    // or not the tab view happens to render this lane — so the range warning is
    // not conditional on tablatureEnabled.
    const tuning = laneTuning(lane);
    // Non-active and locked lanes are read-only reference — dim them so the one
    // layer you're actually editing stands out.
    const laneAlpha = (lane === actLane && !lane.locked) ? 1 : 0.55;
    for (const ghost of addedNotes) ghostNotes.push({ ...ghost, alpha: laneAlpha });
    // Adjacent written attacks otherwise fuse into one solid bar. Indexing their
    // shared edges makes sliced sustains (and other re-attacks) explicit without
    // turning the draw loop into a quadratic search on imported arrangements.
    const edgeKey = (pitch, time) => `${pitch}|${Number(time).toFixed(5)}`;
    const reattackEdges = new Set(lane.notes.map((note) => edgeKey(note.pitch, note.end)));
    sctx.globalAlpha = laneAlpha;
    for (const n of lane.notes) {
      const motion = noteMotion(lane, n);
      const x = xOf(motion.start), w = Math.max(2, xOf(motion.end) - x), y = yOf(n.pitch);
      if (x > vx1 || x + w < vx0) continue; // off-screen
      const rowH = S.state.rowH;
      const fill = stackCount.has(n) ? PAINT.error : lane.color;
      sctx.save();
      sctx.translate(x + w / 2, y + rowH / 2);
      sctx.scale(motion.scaleX, motion.scale);
      sctx.translate(-x - w / 2, -y - rowH / 2);
      // Bent notes draw as a ribbon following the audible pitch — the bar itself
      // traces the bend curve instead of staying a flat rect with a glyph on top,
      // so the drawn pitch always matches what's exported. A prebend's bar sits
      // flat but *above* the fretted row, which is what it actually sounds.
      const curve = bendCurve(n);
      const glow = notePlaybackGlow(lane, n);
      if (glow > 0) {
        sctx.beginPath();
        if (curve) traceBendPath(x, w, y + rowH / 2, curve, rowH);
        else sctx.roundRect(x, y, w, rowH, Math.min(2, w / 2, rowH / 2));
        paintNoteGlow(sctx, glow, curve ? rowH : 0);
      }
      // While a bend is selected its handles are on show and its ribbon is the
      // thing being edited. Let the spectrogram show through the ribbon so its
      // pitch trace remains visible for precise curve placement.
      sctx.globalAlpha = laneAlpha * motion.alpha * (curve && S.selection.has(n) ? 0.5 : 1);
      const drop = curve ? bendPeak(curve) * rowH : 0;
      if (curve) {
        sctx.lineCap = "butt"; sctx.lineJoin = "round";
        sctx.beginPath(); traceBendPath(x, w, y + rowH / 2, curve, rowH);
        if (S.selection.has(n)) {                // selected (solid white outline)
          sctx.lineWidth = rowH; sctx.strokeStyle = PAINT.accent; sctx.stroke();
          sctx.lineWidth = Math.max(1, rowH - 4); sctx.strokeStyle = fill; sctx.stroke();
        } else if (n === S.hoverNote) {
          sctx.lineWidth = rowH + 1.5; sctx.strokeStyle = PAINT.text; sctx.stroke();
          sctx.lineWidth = Math.max(1, rowH - 1.5); sctx.strokeStyle = fill; sctx.stroke();
          sctx.strokeStyle = hexA(PAINT.text, WASH); sctx.stroke();
        } else {
          sctx.lineWidth = rowH + 1; sctx.strokeStyle = veil(PAINT.ground); sctx.stroke();
          sctx.lineWidth = rowH; sctx.strokeStyle = hexA(fill, 0.6); sctx.stroke();
        }
        if (motion.emphasis > 0) {
          sctx.strokeStyle = hexA(PAINT.text, motion.emphasis * .35); sctx.stroke();
        }
        sctx.lineWidth = 1; sctx.lineCap = "round";
      } else {
        const inset = Math.min(2, rowH * .12) * (1 - motion.reveal);
        paintNoteBar(sctx, x, y + inset, w, rowH - 2 * inset, fill, S.selection.has(n), n === S.hoverNote, motion.emphasis);
      }
      if (motion.cut > 0) {
        sctx.save();
        sctx.strokeStyle = hexA(PAINT.text, motion.cut); sctx.lineWidth = 2;
        sctx.beginPath(); sctx.moveTo(x, y - 2 * motion.cut); sctx.lineTo(x, y + rowH + 2 * motion.cut); sctx.stroke();
        sctx.restore();
      }
      if (reattackEdges.has(edgeKey(n.pitch, n.start))) {
        sctx.save();
        sctx.globalAlpha = laneAlpha;
        sctx.strokeStyle = PAINT.text; sctx.lineWidth = 1.5;
        sctx.beginPath(); sctx.moveTo(x + 0.5, y + 2); sctx.lineTo(x + 0.5, y + rowH - 2); sctx.stroke();
        sctx.restore();
      }
      const overrideEffect = n.pos || n.arrangement
        ? "direct"
        : voicingMarks?.effects.get(n);
      if (overrideEffect) {                       // changed fingering: asterisk above the bar
        // red = directly overridden; orange = automatic choice changed by an override
        // (sits on the row the note's tail ends on, so it stays on a bent bar)
        // Drawn above-left, outside the bar, so it never competes with the
        // note's own fill color or the name label.
        const py = curve ? y - curve[curve.length - 1][1] * rowH : y;
        sctx.font = stageUi(11, 700); sctx.textAlign = "left"; sctx.textBaseline = "alphabetic";
        sctx.lineWidth = 2.5; sctx.strokeStyle = halo();
        sctx.strokeText("*", x, py - 1);           // dark halo for legibility over the spectrogram
        sctx.lineWidth = 1; sctx.fillStyle = overrideEffect === "direct" ? PAINT.error : PAINT.warn;
        sctx.fillText("*", x, py - 1);
        sctx.font = stageMono(STAGE_ANCHORED); sctx.textAlign = "left"; sctx.textBaseline = "middle";
      }
      if (voicingMarks?.review.has(n)) {   // memory reused where a better shape was on offer
        // The voicer hands every later occurrence of a note the grip its first
        // occurrence was given, without weighing the alternatives again. This is
        // where that memory has gone measurably stale: the comparison was run
        // anyway, and a different shape came out significantly cheaper here.
        //
        // Above-RIGHT, where the override asterisk is above-left, so the two can
        // never land on each other. Same warn tier: neither is an error, and both
        // say "the automatic answer here is not the plain automatic answer".
        const py = curve ? y - curve[curve.length - 1][1] * rowH : y;
        sctx.font = stageUi(11, 700); sctx.textAlign = "right"; sctx.textBaseline = "alphabetic";
        sctx.lineWidth = 2.5; sctx.strokeStyle = halo();
        sctx.strokeText("!", x + w, py - 1);
        sctx.lineWidth = 1; sctx.fillStyle = PAINT.warn;
        sctx.fillText("!", x + w, py - 1);
        sctx.font = stageMono(STAGE_ANCHORED); sctx.textAlign = "left"; sctx.textBaseline = "middle";
      }
      {
        const label = noteName(n.pitch);
        const tw = sctx.measureText(label).width;
        if (w >= tw + 6) {                       // only when the note can hold the text
          const ly = y + S.state.rowH / 2;
          sctx.lineWidth = 2.5; sctx.strokeStyle = halo();
          sctx.strokeText(label, x + 3, ly);     // dark halo for legibility on any color
          sctx.lineWidth = 1; sctx.fillStyle = PAINT.text;
          sctx.fillText(label, x + 3, ly);
        }
      }
      if (omittedNotes.has(n)) {
        const crossY = drop ? y - drop : y;
        omittedCrosses.push({ x, y: crossY, w, h: rowH + drop, alpha: laneAlpha });
      }
      if (outOfFretboardRange(n.pitch, tuning))
        outOfRange.push({ x, y: drop ? y - drop : y, w, h: rowH + drop, alpha: laneAlpha });
      sctx.restore();
    }
  }
  // Removed notes and brief drag trails are visual remnants only. They never
  // enter the selection, hit tests, minimap, playback or export.
  for (const { lane, note, alpha, shrink } of noteMotionGhosts()) {
    const x = xOf(note.start), y = yOf(note.pitch), w = Math.max(2, xOf(note.end) - x);
    if (x > vx1 || x + w < vx0) continue;
    const h = S.state.rowH, inset = Math.min(2, h * .12) * shrink;
    sctx.save(); sctx.globalAlpha = alpha;
    const curve = bendCurve(note);
    if (curve) {
      sctx.beginPath(); traceBendPath(x, w, y + h / 2, curve, h);
      sctx.lineWidth = Math.max(1, h - 2 * inset); sctx.strokeStyle = lane.color; sctx.stroke();
    } else paintNoteBar(sctx, x, y + inset, w, h - 2 * inset, lane.color);
    const label = noteName(note.pitch);
    if (w >= sctx.measureText(label).width + 6) {
      sctx.fillStyle = PAINT.text; sctx.fillText(label, x + 3, y + h / 2);
    }
    sctx.restore();
  }
  sctx.globalAlpha = 1;
  sctx.textBaseline = "alphabetic";
  drawShapes(vx0, vx1);
  drawStackBadges(stackBadges, vx0, vx1);
  drawSlides();
  drawBends();
  drawBendHandles();
  drawNoteFx();
  drawHarmonics();
  drawOmittedNoteCrosses(omittedCrosses);
  drawOutOfRangeNotes(outOfRange);
  drawGhostNotes(ghostNotes);
  drawReferences();
  drawMatches();

  if (S.drag && S.drag.mode === "trace") drawTracePath(S.drag.points);
  if (S.marquee) {
    const x = Math.min(S.marquee.x0, S.marquee.x1), y = Math.min(S.marquee.y0, S.marquee.y1);
    const w = Math.abs(S.marquee.x1 - S.marquee.x0), h = Math.abs(S.marquee.y1 - S.marquee.y0);
    sctx.fillStyle = wash(PAINT.accent);
    sctx.fillRect(x, y, w, h);
    sctx.strokeStyle = PAINT.accent;
    sctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
  if (S.drag?.mode === "slice") {
    const line = S.drag;
    sctx.save();
    sctx.strokeStyle = PAINT.warn; sctx.lineWidth = 2; sctx.setLineDash([5, 3]);
    sctx.beginPath(); sctx.moveTo(line.x0, line.y0); sctx.lineTo(line.x1, line.y1); sctx.stroke();
    sctx.setLineDash([]); sctx.fillStyle = PAINT.text;
    for (const [x, y] of [[line.x0, line.y0], [line.x1, line.y1]]) {
      sctx.beginPath(); sctx.arc(x, y, 3, 0, Math.PI * 2); sctx.fill();
    }
    sctx.restore();
  }

  if (S.mouseX != null) {
    // --hint, not --line: this tracks the cursor, so it is the quietest thing
    // that still has to be findable, which is what --hint is for. --line would
    // put it at the weight of a divider and lose it over a bright partial.
    sctx.strokeStyle = PAINT.hint;
    sctx.setLineDash([4, 4]);
    sctx.beginPath(); sctx.moveTo(S.mouseX, 0); sctx.lineTo(S.mouseX, contentH()); sctx.stroke();
    sctx.setLineDash([]);
  }
  const px = xOf(playheadTime);
  sctx.strokeStyle = PAINT.accent; sctx.lineWidth = 2;   // rule 7: the playhead is one of accent's four uses
  sctx.beginPath(); sctx.moveTo(px, 0); sctx.lineTo(px, contentH()); sctx.stroke();
  sctx.lineWidth = 1;
  sctx.save();
  const reveal = railScale();
  sctx.beginPath();
  sctx.rect(vx0, scroll.scrollTop, vx1 - vx0, railsBottom() * reveal);
  sctx.clip();
  drawMarkers();   // tempo/meter flags, pinned to the top of the viewport
  // Full-size flags stay within their overlay, including when vertically scrolled.
  if (markerRails().length) {
    sctx.save();
    sctx.beginPath();
    sctx.rect(vx0, scroll.scrollTop, vx1 - vx0, railsBottom());
    sctx.clip();
    for (const rail of markerRails()) rail.draw?.();  // sections, phrases, tones
    sctx.restore();
  }
  sctx.restore();
  drawHandHolds(vx0, vx1);
  drawMinimap();
}

// ---- where the hand was put by hand ----
// A hold says "the fretting hand stands on this fret from this beat". That is a fact
// about TIME and about the player, not about any one note — the voicer re-fingers a
// whole phrase around it — so it is a mark at an instant and never a glyph on a bar.
//
// Pinned under the rails at the top of the viewport, which is where this app already
// keeps everything anchored to time rather than to pitch, and 12 tall: findable at a
// glance, over no note at any scroll position, and gone the moment the lane has no
// holds (rule 24 — a mark that is always there says nothing).
//
// The layer's own hue, because a hand belongs to a layer exactly as its notes and its
// grip on the neck do (rule 15), and the fret in mono because a fret is a value
// (rule 6) — 11, not the note-anchored 9, which rule 6 grants only to text tied to a
// pitch row. Haloed like every other glyph on the stage, or it is unreadable over a
// bright partial.
const HOLD_MARK_H = 12;
function drawHandHolds(vx0, vx1) {
  const top = scroll.scrollTop + (railsHidden() ? 0 : railsBottom());
  sctx.font = stageMono(11);
  sctx.textAlign = "left";
  sctx.textBaseline = "top";
  for (const lane of S.state.lanes) {
    if (!lane.visible || !lane.handHolds?.length) continue;
    for (const hold of lane.handHolds) {
      const x = Math.round(xOf(Number(hold.t))) + 0.5;
      if (x < vx0 - 32 || x > vx1 + 32) continue;
      const label = String(Math.round(Number(hold.fret)));
      sctx.beginPath();
      sctx.moveTo(x, top); sctx.lineTo(x, top + HOLD_MARK_H);
      sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.stroke();
      sctx.lineWidth = 1; sctx.strokeStyle = lane.color; sctx.stroke();
      sctx.lineWidth = 2.5; sctx.strokeStyle = halo();
      sctx.strokeText(label, x + 3, top);
      sctx.lineWidth = 1; sctx.fillStyle = lane.color;
      sctx.fillText(label, x + 3, top);
    }
  }
  sctx.textBaseline = "alphabetic";
}

// ---- overview minimap: the whole song (spectrogram + notes) with a window ----
// showing the visible frame; click/drag it to jump the main viewport anywhere.
// The minimap's spectrogram backdrop is static (changes only on stem switch or
// resize), but downscaling the full ~10k-px-wide spectrogram is expensive. Cache
// that downscale into an offscreen canvas and rebuild only when its inputs
// change; per frame we just blit the cache (cheap) and redraw the live notes +
// playhead + viewport window on top. This removes the dominant per-frame cost.
export let mmBackdrop = document.createElement("canvas");

export let mmBackdropCtx = mmBackdrop.getContext("2d");

export let mmBackdropImg = null;   // spectImg the current backdrop was built from

function buildMinimapBackdrop(W, H) {
  mmBackdrop.width = W; mmBackdrop.height = H;
  mmBackdropCtx.fillStyle = PAINT.ground; mmBackdropCtx.fillRect(0, 0, W, H);
  if (S.spectImg) {
    mmBackdropCtx.drawImage(S.spectImg, 0, 0, S.spectImg.width, S.spectImg.height, 0, 0, W, H);
  }
  mmBackdropImg = S.spectImg;
}

function overviewTimeLabel(time, fractional = false) {
  time = Math.round(time * (fractional ? 10 : 1)) / (fractional ? 10 : 1);
  const minutes = Math.floor(time / 60);
  const seconds = time - minutes * 60;
  return `${minutes}:${seconds.toFixed(fractional ? 1 : 0).padStart(fractional ? 4 : 2, "0")}`;
}

function drawOverviewRuler(width, dp) {
  const PAINT = UI_PAINT;
  const ctx = overviewRulerCtx;
  const height = overviewRuler.height / dp;
  const duration = S.state.duration || 1;
  ctx.setTransform(dp, 0, 0, dp, 0, 0);
  ctx.fillStyle = PAINT.toolbar; ctx.fillRect(0, 0, width, height);
  // Labels remain readable as the panel width and song duration change.
  const desired = duration / Math.max(1, Math.floor(width / 80));
  const power = 10 ** Math.floor(Math.log10(desired));
  const step = [1, 2, 5, 10].map(value => value * power).find(value => value >= desired);
  ctx.font = stageMono(11); ctx.fillStyle = PAINT.label;
  ctx.textBaseline = "top"; ctx.strokeStyle = PAINT.line; ctx.lineWidth = 1;
  for (let i = 0; i * step / 5 <= duration; i++) {
    const time = i * step / 5;
    const x = time / duration * width;
    const major = i % 5 === 0;
    ctx.beginPath(); ctx.moveTo(x + .5, height); ctx.lineTo(x + .5, height - (major ? 4 : 2)); ctx.stroke();
    if (major) {
      const label = overviewTimeLabel(time, step < 1);
      const labelWidth = ctx.measureText(label).width;
      ctx.fillText(label, Math.max(2, Math.min(width - labelWidth - 2, x + 3)), 1);
    }
  }
  const time = playbackTime();
  const x = time / duration * width;
  ctx.strokeStyle = PAINT.accent;
  ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, height); ctx.stroke();
  if (S.mmSeeking) {
    const label = overviewTimeLabel(time, true);
    const labelWidth = ctx.measureText(label).width;
    const left = Math.max(0, Math.min(width - labelWidth - 8, x + 5));
    ctx.fillStyle = PAINT.chrome; ctx.fillRect(left, 0, labelWidth + 8, height - 3);
    ctx.fillStyle = PAINT.text; ctx.fillText(label, left + 4, 1);
  }
  overviewRuler.setAttribute("aria-valuemax", String(duration));
  overviewRuler.setAttribute("aria-valuenow", String(+time.toFixed(3)));
  overviewRuler.setAttribute("aria-valuetext", overviewTimeLabel(time, true));
}

function drawMinimap() {
  const dp = dpr();
  const W = minimap.width / dp, H = minimap.height / dp;   // CSS px; store is HiDPI
  if (W < 1 || H < 1) return;
  drawOverviewRuler(W, dp);
  mmctx.setTransform(dp, 0, 0, dp, 0, 0);
  const OY = MM_HEAD;           // content sits below the headroom strip
  const CH = H - OY;            // content (spectrogram) height
  // The cached backdrop covers just the content band, blitted below the headroom.
  // It's built at device resolution so the blit is 1:1 (no resample blur).
  if (mmBackdrop.width !== minimap.width || mmBackdrop.height !== Math.round(CH * dp) || mmBackdropImg !== S.spectImg) {
    buildMinimapBackdrop(minimap.width, Math.round(CH * dp));
  }
  // Headroom strip (the playhead "ruler" you drag the pin along).
  mmctx.fillStyle = UI_PAINT.toolbar; mmctx.fillRect(0, 0, W, OY);
  mmctx.strokeStyle = PAINT.line; mmctx.lineWidth = 1;
  mmctx.beginPath(); mmctx.moveTo(0, OY + 0.5); mmctx.lineTo(W, OY + 0.5); mmctx.stroke();
  // Static backdrop (bg + downscaled spectrogram), device-res → CSS-px dest box.
  mmctx.drawImage(mmBackdrop, 0, 0, mmBackdrop.width, mmBackdrop.height, 0, OY, W, CH);

  const sx = W / Math.max(1, S.state.duration * S.pxPerSec);                                 // song px -> minimap px
  const rows = S.state.spec.midi_high - S.state.spec.midi_low + 1;
  const rh = CH / rows;
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    mmctx.fillStyle = lane.color;
    for (const n of lane.notes) {
      const x = xOf(n.start) * sx;
      const w = Math.max(1, (xOf(n.end) - xOf(n.start)) * sx);
      const y = OY + (S.state.spec.midi_high - n.pitch) * rh;
      mmctx.fillRect(x, y, w, Math.max(1, rh));
    }
  }

  const rx = scroll.scrollLeft * sx;                          // visible-frame window
  const rw = Math.min(W - rx, scroll.clientWidth * sx);
  const sy = CH / contentH();                                 // content px -> minimap px (vertical)
  const ry = OY + scroll.scrollTop * sy;
  const rhWin = Math.min(H - ry, S.stageHeight * sy);          // == CH when not pitch-zoomed
  mmctx.fillStyle = wash(PAINT.text);
  mmctx.fillRect(rx, ry, rw, rhWin);
  mmctx.strokeStyle = PAINT.text; mmctx.lineWidth = 1.5;
  mmctx.strokeRect(rx + 0.75, ry + 0.75, Math.max(1, rw - 1.5), Math.max(1, rhWin - 1.5));
  mmctx.lineWidth = 1;

  drawMinimapMarkers(sx);   // tempo/meter flags in the headroom strip
  for (const rail of overviewMarkerRails()) rail.drawMinimap?.(sx);

  // Playhead: a full-height line plus a draggable pin head in the headroom strip.
  const ph = xOf(playbackTime()) * sx;
  mmctx.strokeStyle = PAINT.accent; mmctx.lineWidth = 1;
  mmctx.beginPath(); mmctx.moveTo(ph, OY); mmctx.lineTo(ph, H); mmctx.stroke();
  // Pin: downward triangle marker, the grab handle for scrubbing.
  mmctx.fillStyle = S.mmSeeking ? PAINT.text : PAINT.accent;
  mmctx.beginPath();
  mmctx.moveTo(ph - 5, 1); mmctx.lineTo(ph + 5, 1); mmctx.lineTo(ph, OY - 1); mmctx.closePath();
  mmctx.fill();
}

// Recenter the main viewport on the time under the minimap cursor.
function minimapScrollTo(clientX) {
  const r = minimap.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const max = scroll.scrollWidth - scroll.clientWidth;
  moveViewportTo(Math.max(0, Math.min(max, f * songWidth() - scroll.clientWidth / 2)));
}

// Move the playhead to the time under the cursor (scrub) — drives the headroom pin.
function minimapSeekTo(clientX) {
  const r = minimap.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  setPlaybackCursor(f * (S.state.duration || 0));
  moveViewportTo(f * songWidth() - scroll.clientWidth / 2);
  draw();
}

// The pitch ruler doubles as a click-to-preview keyboard: clicking a row plays
// that pitch through the active edit lane's voice (a synthetic 0.6s note), so you
// can hear what a row sounds like without placing a note. The ruler is fixed, so
// a click's world y is its screen offset plus the current vertical scroll.
function rulerPitchAt(clientY) {
  const r = ruler.getBoundingClientRect();
  return pitchAt(clientY - r.top + scroll.scrollTop);
}

export function init_draw() {
  setPainter(paintFrame);
  // A canvas draws with whatever is loaded the instant fillText runs, and unlike
  // the DOM it is never re-laid-out when a webfont arrives. Both families are
  // fetched with display=swap, so a stage painted during that swap keeps the
  // fallback metrics until something else happens to request a frame. One
  // repaint when the fonts settle costs nothing and removes the whole class of
  // "the first frame is in Segoe UI" bug.
  document.fonts?.ready.then(draw);
  overviewRuler.addEventListener("mousedown", (e) => {
    if (!S.state || e.button !== 0) return;
    e.preventDefault(); overviewRuler.focus();
    S.mmSeeking = true; minimapSeekTo(e.clientX);
  });
  overviewRuler.addEventListener("keydown", (e) => {
    if (!S.state) return;
    const delta = e.shiftKey ? 1 : .1;
    const time = playbackTime();
    const target = e.key === "ArrowLeft" ? time - delta : e.key === "ArrowRight" ? time + delta : e.key === "Home" ? 0 : e.key === "End" ? S.state.duration : null;
    if (target === null) return;
    e.preventDefault(); e.stopPropagation();
    const next = Math.max(0, Math.min(S.state.duration, target));
    setPlaybackCursor(next); moveViewportTo(next * S.pxPerSec - scroll.clientWidth / 2); draw();
  });
  minimap.addEventListener("mousedown", (e) => {
    if (!S.state) return;
    e.preventDefault();         // don't start a text/drag selection
    const r = minimap.getBoundingClientRect();
    if (e.clientY - r.top < MM_HEAD) { S.mmSeeking = true; minimapSeekTo(e.clientX); }   // headroom → scrub
    else { S.mmDragging = true; minimapScrollTo(e.clientX); }                            // body → navigate
  });
  window.addEventListener("mousemove", (e) => {
    if (S.mmSeeking) minimapSeekTo(e.clientX);
    else if (S.mmDragging) minimapScrollTo(e.clientX);
  });
  window.addEventListener("mouseup", () => {
    if (S.mmSeeking) { S.mmSeeking = false; draw(); }   // repaint the pin back to its idle colour
    S.mmDragging = false;
  });
  // Cursor hint: scrub cursor over the headroom pin strip, navigate cursor in the body.
  minimap.addEventListener("mousemove", (e) => {
    if (S.mmSeeking || S.mmDragging) return;
    const r = minimap.getBoundingClientRect();
    minimap.style.cursor = (e.clientY - r.top < MM_HEAD) ? "ew-resize" : "pointer";
  });
  // Re-size + repaint whenever the parent viewport changes. Watching #viewer is
  // important: layout() writes an explicit height to #scroll, so observing the
  // child could miss a later startup height once an early measurement had locked
  // that child to the wrong size. The parent is flex-sized and isn't mutated by
  // layout(), so this also avoids an observer loop.
  new ResizeObserver(() => {
    if (!S.state || editorEl.hidden || viewer.clientWidth <= RULER_W || viewer.clientHeight < 1) return;
    // Resizing a canvas clears it. Repaint synchronously in the observer callback
    // so the browser never presents that cleared backing store as a black frame.
    layout(); drawNow();
  }).observe(viewer);
  // ---- hover highlight + cursor line ----
  stage.addEventListener("mousemove", (e) => {
    S.pitchHoverClientY = e.clientY;
    if (S.drag || !S.state) return;
    const [x, y] = localXY(e);
    const t = timeAt(x), pitch = pitchAt(y);
    const hit = pickNote(t, pitch);
    const mi = S.matches.length && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? matchAt(x, y) : -1;
    const prevMatchHover = S.matchHover;
    S.matchHover = mi;
    if (mi !== prevMatchHover) {
      if (mi >= 0) scheduleHoverMatchPreview(mi);
      else cancelHoverPreview();
    }
    let cur, rbe;
    // Rails occupy disjoint y bands, so probe order only decides which reports
    // first; go bottom-up to match the mouseDown chain in interaction.js.
    let mkCur = null;
    for (let i = markerRails().length - 1; i >= 0 && !mkCur; i--)
      mkCur = markerRails()[i].cursorAt?.(x, y) || null;
    mkCur = mkCur || markerCursorAt(x, y);
    if (e.ctrlKey || e.metaKey) cur = "pointer";             // Ctrl + click = seek
    else if (mkCur) cur = mkCur;                             // over a timing or section flag
    else if (mi >= 0) cur = "pointer";                       // hovering a suggestion
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && refBadgeAt(x, y)) cur = "grab"; // reference badge (click = select, drag = move)
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (rbe = refBoxEdgeAt(x, y)))
      cur = (rbe.edge === "l" || rbe.edge === "r") ? "ew-resize" : "ns-resize";   // reference box edge
    else if (!e.ctrlKey && !e.metaKey && !e.shiftKey && regionEdgeAt(x)) cur = "ew-resize"; // frame handle
    else if (S.sliceHeld) cur = "crosshair";                 // hold S = temporary Slice line
    else if (e.altKey) cur = "col-resize";                   // Alt = detect-frame band
    else if (hit && hit.lane !== activeLane()) cur = "pointer";  // click switches the edit target to this layer
    else if (hit) cur = edgeOf(hit.note, x) ? "ew-resize" : "move";
    else cur = "default";                                    // empty = scrub
    stage.style.cursor = cur;
    S.mouseX = x;
    S.mouseY = y;
    S.hoverNote = hit ? hit.note : null;
    draw();
  });
  stage.addEventListener("mouseleave", () => {
    S.pitchHoverClientY = null;
    stage.style.cursor = "default";
    cancelHoverPreview();
    S.mouseX = null; S.mouseY = null; S.hoverNote = null; S.matchHover = -1; draw();
  });
  for (const scale of [ruler, rulerRight]) {
  scale.addEventListener("mousedown", (e) => {
    if (!S.state || !S.state.spec || e.button !== 0) return;
    e.preventDefault();
    const pitch = rulerPitchAt(e.clientY);
    auditionNote({ pitch, start: 0, end: 0.6 });
  });
  scale.addEventListener("mousemove", (e) => {
    if (!S.state || !S.state.spec) return;
    const pitch = rulerPitchAt(e.clientY);
    if (pitch !== S.rulerHover) { S.rulerHover = pitch; drawRuler(); }
  });
  scale.addEventListener("mouseleave", () => {
    if (S.rulerHover != null) { S.rulerHover = null; drawRuler(); }
  });
  }
  // draw() only paints the visible time-slice of the full-width canvas, so
  // panning the viewport reveals unpainted (dark) regions — repaint on scroll
  // (already one-per-frame via draw()'s coalescing).
  scroll.addEventListener("scroll", () => {
    hideNoteMenu();
    draw();
  }, { passive: true });
}
