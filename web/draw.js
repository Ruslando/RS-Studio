import { paintIntensity } from './spectrogram-intensity.js';
import { paintNoteRow } from './timeline-paint.js';
import { createOverview } from './overview.js';
import { ISSUE_TEXT, laneIssues } from "./note-issues.js";
import { hideTooltip, showTooltip } from "./tooltip.js";
import { rocksmithIssueNotes, rocksmithShapeProblems } from "./rocksmith-check.js";
import { paintNoteBar, paintNoteGlow, paintNoteSelection, noteSelectionFill } from "./canvas-components.js";
import { renderArtifacts } from "./artifacts.js";
import { beginNoteMotionFrame, beginNotePlaybackFrame, noteMotion, noteMotionGhosts, notePlaybackGlow } from "./note-motion.js";
// Canvas rendering: the main spectrogram + notes draw loop, the overview minimap
// (whole-song strip with a viewport window), and the hover highlight / cursor line.

import { bendCurve, bendPeak } from "./bend.js";
import { BEND_HANDLE_R, RULER_W, STAGE_ANCHORED, STAGE_HEIGHT_MIN, stageMono, stageUi } from "./constants.js";
import { bendHandles, effectStartHandles, collectStacks, stackedBendPoints, drawDetectRegion, drawGrid, drawNoteFx, drawRuler, drawStackBadges, noteRibbon, slideFretsHandle, regionEdgeAt } from "./note-render.js";
import { editorEl, minimap, overviewRuler, ruler, rulerRight, scroll, sctx, stage, viewer } from "./dom.js";
import { draw, drawNow, setPainter } from "./repaint.js";
import { hideNoteMenu } from "./edit.js";
import { drawFretboard, fretboardEditTargets } from "./fretboard.js";
import { drawMarkers, markerCursorAt } from "./markers.js";
import { commentCursorAt, drawComments } from "./comments.js";
import { syncProjectStartHandle } from "./project-position.js";
import { markerRails, railScale, railsBottom } from "./marker-rails.js";
import { contentH, layout, pitchAt, pitchAtExact, stageRoom, timeAt, xOf, yOf } from "./geometry.js";
import { edgeOf, hoveredStageNote, localXY, pickNote } from "./interaction.js";
import { activeLane, canEditLane, laneOf } from "./lanes.js";
import { auditionNote, playbackTime, transportPlaying } from "./playback.js";
import { drawReferences, refBadgeAt, refBoxEdgeAt, refEdgeCursor, refLockAt } from "./references.js";
import { motifGroups, motifName } from "./motifs.js";
import { shapeGroups, shapeLabel, shapeLabelAt } from "./shapes.js";
import { laneChords } from "./chord-names.js";
import { PAINT, WASH, halo, veil, wash } from "./stage-paint.js";
import { S } from "./store.js";
import { laneFretCount, laneFretTuning } from "./tablature.js";
import { cancelHoverPreview, drawHeatThresholdOverlay, drawMatches, drawTracePath, drawTraceRange, matchAt, scheduleHoverMatchPreview, setPlaybackCursor } from "./tracing.js";
import { dpr, grayHex, hexA } from "./util.js";
import { moveViewportTo, followViewportTo } from "./viewport-motion.js";
import { addedArrangementNotes, omittedArrangementNotes, outOfFretboardRange } from "./voicing-core.js";
import { songBarStarts } from "./song-bars.js";
import { noteName } from "./util.js";
import { resolveNoteAppearance, spectrogramLabel, spectrogramLabelOptions } from "./spectrogram-labels.js";

const omittedArrangementCache = new WeakMap();
const staleCache = new WeakMap(), staleJobs = new WeakMap();
const STALE_DELAY = 700;   // ms after edits settle, like the Rocksmith check

// Kept positions the engine would place elsewhere today (staleKept): one whole-lane
// pass in a worker, started once edits settle, reused until the next edit.
function staleForLane(lane) {
  const key = `${S.voicingRevision}:${songBarStarts().join(",")}`;
  const cached = staleCache.get(lane);
  if (cached?.key === key && cached.notes === lane.notes) return cached.stale;
  const job = staleJobs.get(lane);
  if (job?.key === key) return cached?.stale ?? null;
  if (job) { clearTimeout(job.timer); job.worker?.terminate(); }
  const notes = lane.notes, entry = { key };
  entry.timer = setTimeout(() => {
    try {
      const worker = entry.worker = new Worker(new URL("./voicing-worker.js", import.meta.url), { type: "module" });
      const done = (stale) => {
        worker.terminate();
        if (staleJobs.get(lane) !== entry) return;
        staleJobs.delete(lane);
        staleCache.set(lane, { key, notes, stale });
        draw();
      };
      worker.onmessage = (event) => {
        if (event.data.task !== "stale") return;
        done(new Map((event.data.stale || []).flatMap((p, i) => (p && notes[i] ? [[notes[i], p]] : []))));
      };
      worker.onerror = () => done(new Map());
      worker.postMessage({ task: "stale", notes, tuning: laneFretTuning(lane), bars: songBarStarts(),
        instrument: lane.instrument, capo: lane.capo, holds: lane.handHolds });
    } catch { staleJobs.delete(lane); }
  }, STALE_DELAY);
  staleJobs.set(lane, entry);
  return cached?.stale ?? null;   // the last answer until the new one is in
}
let warningMarks = [];   // last frame's warning marks: { x0, x1, y0, y1, tip }
const BEND_STACK_TIP = { title: ISSUE_TEXT.bendStack[0], body: ISSUE_TEXT.bendStack[1], tone: "warning" };

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

// A hatched red overlay, deliberately unlike the dark crossed-out wash that
// marks a note the arrangement drops on purpose: this one is not a choice, and
// it is an error (note-issues.js).
function drawOutOfRangeNotes(items) {
  sctx.save();
  for (const { x, y, w, h, alpha } of items) {
    sctx.globalAlpha = alpha;
    sctx.save();
    sctx.beginPath(); sctx.rect(x, y, w, h); sctx.clip();
    sctx.fillStyle = hexA(PAINT.error, 0.22);
    sctx.fillRect(x, y, w, h);
    sctx.lineWidth = 1.5; sctx.strokeStyle = hexA(PAINT.error, 0.85);
    sctx.beginPath();
    for (let o = -h; o < w; o += 5) { sctx.moveTo(x + o, y + h); sctx.lineTo(x + o + h, y); }
    sctx.stroke();
    sctx.restore();
    sctx.lineWidth = 1.5; sctx.strokeStyle = PAINT.error;
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
  const labels = resolveNoteAppearance(spectrogramLabelOptions());
  for (const { pitch, start, end, alpha, pos, capo } of added) {
    sctx.globalAlpha = alpha ?? 1;
    const x = xOf(start), w = Math.max(2, xOf(end) - x), y = yOf(pitch);
    sctx.fillStyle = hexA(PAINT.ok, 0.28);
    sctx.fillRect(x, y, w, rowH);
    sctx.setLineDash([4, 3]);
    sctx.lineWidth = 2; sctx.strokeStyle = PAINT.ok;
    sctx.strokeRect(x + 1, y + 1, w - 2, rowH - 2);
    sctx.setLineDash([]);
    const text = spectrogramLabel({ pitch }, pos, labels.mode, [], labels.fromNut ? capo || 0 : 0);
    const label = text ? "+" + text : "";
    const tw = sctx.measureText(label).width;
    if (label && w >= tw + 6) {
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
    // Where a slide leaves or vibrato sets in only moves in time: a stem from
    // the note to an upright grip beside it (note-render.js).
    for (const slide of effectStartHandles(n, laneOf(n))) {
      sctx.save();
      sctx.beginPath(); sctx.moveTo(slide.x, slide.bar); sctx.lineTo(slide.x, slide.y);
      sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.stroke();
      sctx.lineWidth = 1.5; sctx.strokeStyle = PAINT.accent; sctx.stroke();
      sctx.lineWidth = 1.5; sctx.strokeStyle = halo(); sctx.fillStyle = PAINT.accent;
      sctx.beginPath(); sctx.roundRect(slide.x - 4, slide.y - 7, 8, 14, 4);
      sctx.fill(); sctx.stroke();
      sctx.restore();
    }
    // How far a slide into or out of the note reaches: a dot at its far end.
    const far = slideFretsHandle(n, laneOf(n));
    if (far) {
      sctx.save();
      sctx.lineWidth = 1.5; sctx.strokeStyle = halo(); sctx.fillStyle = PAINT.accent;
      sctx.beginPath(); sctx.arc(far.x, far.y, BEND_HANDLE_R, 0, Math.PI * 2);
      sctx.fill(); sctx.stroke();
      sctx.restore();
    }
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

// Outline the marked notes themselves. Unmarked notes between motif members
// must not look as though they belong to the motif's bounding rectangle.
function drawMotifs(vx0, vx1) {
  S.motifLabels = [];
  const active = activeLane();
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    // Measure each group ONCE, then sort on the measurement. This used to sort
    // with `Math.min(...a.map(n => n.start))` in the comparator — a map and a
    // spread per comparison, so O(n log n) allocations every frame, on a path
    // that runs on every mousemove over the stage. Two of the four bounds were
    // then recomputed a third time inside the loop body.
    const groups = [...motifGroups(lane.notes)].map(([id, notes]) => {
      let t0 = Infinity, t1 = -Infinity, pLo = Infinity, pHi = -Infinity;
      for (const n of notes) {
        if (n.start < t0) t0 = n.start;
        if (n.end > t1) t1 = n.end;
        if (n.pitch < pLo) pLo = n.pitch;
        if (n.pitch > pHi) pHi = n.pitch;
      }
      return { id, notes, t0, t1, pLo, pHi };
    }).sort((a, b) => a.t0 - b.t0);
    groups.forEach(({ id, t0, t1, pLo, pHi }) => {
      const x0 = xOf(t0) - 4;
      const x1 = xOf(t1) + 4;
      if (x0 > vx1 || x1 < vx0) return;
      // yOf grows downward, so the highest pitch gives the smallest y.
      const y0 = yOf(pHi) - 5;
      const y1 = yOf(pLo) + S.state.rowH + 5;
      sctx.save();
      sctx.globalAlpha = lane === active ? 0.95 : 0.55;
      sctx.strokeStyle = PAINT.motif; sctx.lineWidth = 1.5;
      sctx.setLineDash([6, 4]);
      sctx.strokeRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
      sctx.setLineDash([]);
      const label = motifName(lane.notes, id);
      // Drawn above the box, not inside it, so nothing clips it — free-floating 11.
      sctx.font = stageUi(11, 700); sctx.textAlign = "left"; sctx.textBaseline = "bottom";
      const labelX = Math.max(x0 + 3, vx0 + 3), labelY = y0 - 2;
      sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.strokeText(label, labelX, labelY);
      sctx.lineWidth = 1; sctx.fillStyle = PAINT.motif; sctx.fillText(label, labelX, labelY);
      S.motifLabels.push({ lane, id, x: labelX - 3, y: labelY - 13, w: sctx.measureText(label).width + 6, h: 14 });
      sctx.restore();
    });
  }
}

// Rocksmith grip frames (shapes.js): a solid box for a handshape, dashed for an
// arpeggio, as the game draws them, with the grip's name underneath so it does
// not collide with motif and chord labels above the notes. A shape the export has
// a problem with (rocksmith-check.js) is framed in the warning colour, and its
// label says when it goes out as plain notes; the problem itself is listed under
// Warnings. The labels are kept for clicks: select the shape, double-click renames.
function drawShapes(vx0, vx1) {
  S.shapeLabels = [];
  const active = activeLane();
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    const problems = rocksmithShapeProblems(lane);
    for (const [id, notes] of shapeGroups(lane.notes)) {
      const problem = problems.get(id);
      const color = problem ? PAINT.warn : PAINT.shape;
      let t0 = Infinity, t1 = -Infinity, pLo = Infinity, pHi = -Infinity;
      for (const n of notes) {
        t0 = Math.min(t0, n.start); t1 = Math.max(t1, n.end);
        pLo = Math.min(pLo, n.pitch); pHi = Math.max(pHi, n.pitch);
      }
      const x0 = xOf(t0) - 7, x1 = xOf(t1) + 7;
      if (x0 > vx1 || x1 < vx0) continue;
      const y0 = yOf(pHi) - 8, y1 = yOf(pLo) + S.state.rowH + 8;
      sctx.save();
      sctx.globalAlpha = lane === active ? 0.95 : 0.55;
      sctx.strokeStyle = color; sctx.lineWidth = 2;
      if (notes[0].shapeKind === "arpeggio") sctx.setLineDash([3, 3]);
      sctx.strokeRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
      sctx.setLineDash([]);
      const label = shapeLabel(notes) + (problem?.plain ? " · exported as plain notes" : problem ? " · check hand" : "");
      sctx.font = stageUi(11, 700); sctx.textAlign = "left"; sctx.textBaseline = "top";
      const labelX = Math.max(x0 + 3, vx0 + 3), labelY = y1 + 2;
      sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.strokeText(label, labelX, labelY);
      sctx.lineWidth = 1; sctx.fillStyle = color; sctx.fillText(label, labelX, labelY);
      S.shapeLabels.push({ lane, id, x: labelX - 3, y: labelY - 1, w: sctx.measureText(label).width + 6, h: 14 });
      sctx.restore();
    }
  }
}

// Each chord's name at its top left, in its layer's hue (rule 24), as chord
// charts write a name above the chord. Drawn after the warning marks and the
// motif and reference labels that sit in the same corner, and moved right past
// them. A name that would run into the one before it is left out, as a note label
// too wide for its note is.
const CHORD_NAME_PX = 11;
function drawChordNames(vx0, vx1) {
  S.chordLabels = [];
  const active = activeLane();
  const taken = [
    ...warningMarks.map((m) => ({ x: m.x0, y: m.y0, w: m.x1 - m.x0, h: m.y1 - m.y0 })),
    ...S.motifLabels, ...(S.shapeLabels || []), ...(S.refBadges || []),
  ];
  const hits = (r) => taken.find((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
  sctx.save();
  sctx.font = stageUi(CHORD_NAME_PX, 600); sctx.textAlign = "left"; sctx.textBaseline = "bottom";
  sctx.lineJoin = "round";
  for (const lane of S.state.lanes) {
    if (!lane.visible || !lane.notes?.length) continue;
    let lastRight = -Infinity;
    for (const chord of laneChords(lane)) {
      if (!chord.name) continue;
      const w = sctx.measureText(chord.name).width;
      let x = xOf(chord.t0);
      if (x > vx1) break;
      if (x + w < vx0) continue;
      // Clear of the selection's outline, which sits 3 px around the notes.
      const y = yOf(Math.max(...chord.notes.map((n) => n.pitch))) - 6;
      const box = { x: x - 2, y: y - CHORD_NAME_PX - 2, w: w + 4, h: CHORD_NAME_PX + 3 };
      for (let o = hits(box), n = 0; o && n < 4; o = hits(box), n++) box.x = o.x + o.w + 2;
      x = box.x + 2;
      if (x < lastRight + 6) continue;
      sctx.globalAlpha = lane === active ? 1 : 0.55;
      sctx.lineWidth = 3; sctx.strokeStyle = halo(); sctx.strokeText(chord.name, x, y);
      sctx.fillStyle = lane.color; sctx.fillText(chord.name, x, y);
      S.chordLabels.push({ lane, chord, ...box });
      taken.push(box);
      lastRight = x + w;
    }
  }
  sctx.restore();
}

// A reference or motif being dragged in from the artifact pane: its notes as
// ghosts where the drop would put them, framed as it will be (solid or dashed).
function drawDropPreview() {
  const preview = S.dropPreview;
  if (!preview) return;
  const h = S.state.rowH;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  sctx.save();
  for (const n of preview.notes) {
    const x = xOf(n.start), w = Math.max(1, xOf(n.end) - x), y = yOf(n.pitch);
    sctx.globalAlpha = preview.blocked ? 0.4 : 1;
    sctx.fillStyle = hexA(preview.color, WASH * 3); sctx.fillRect(x, y, w, h);
    sctx.strokeStyle = preview.color; sctx.lineWidth = 1; sctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x + w); y0 = Math.min(y0, y); y1 = Math.max(y1, y + h);
  }
  if (preview.box) {   // a reference: its own box shape, as the stage will draw it
    x0 = xOf(preview.box.t0); x1 = xOf(preview.box.t1); y0 = yOf(preview.box.pHi); y1 = yOf(preview.box.pLo) + h;
  }
  const motif = preview.kind === "motif", pad = motif ? 4 : 0;
  // Over another reference the drop is refused, and the frame says so.
  sctx.strokeStyle = preview.blocked ? PAINT.error : motif ? PAINT.motif : PAINT.ref; sctx.lineWidth = 2;
  sctx.globalAlpha = 1;
  if (motif) sctx.setLineDash([6, 4]);
  sctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
  sctx.restore();
}

// The frame itself. Registered with repaint.js at boot; everything else asks for
// a paint through draw()/drawNow() there and never imports this module.
function paintFrame({ panels = true } = {}) {
  if (panels) renderArtifacts();
  beginNoteMotionFrame(S.state, S.drag);
  const playheadTime = playbackTime();
  beginNotePlaybackFrame(S.state, playheadTime, transportPlaying());
  // The fretboard is its own canvas below the stage, and it is painted here so
  // that every existing repaint trigger — the playback loop above all — moves the
  // hand too. Ahead of the guards below because the neck is drawn with or without
  // a project, and it has its own.
  drawFretboard();
  if (!S.state || !S.state.spec) {
    overview?.draw();
    return;
  }
  if (editorEl.hidden || viewer.clientWidth <= RULER_W || viewer.clientHeight < 1) return;
  if (!S.drag) S.hoverNote = hoveredStageNote();
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
  const liveH = Math.max(STAGE_HEIGHT_MIN, stageRoom());
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
    const t0 = timeAt(vx0), t1 = Math.min(S.state.duration, timeAt(vx1));
    if (t1 > t0) {
      paintIntensity(sctx, S.spectImg,
        (t0 / S.state.duration) * iw, 0, ((t1 - t0) / S.state.duration) * iw, S.spectImg.height,
        xOf(t0), 0, (t1 - t0) * S.pxPerSec, contentH(), ...(S.state.viewIntensity || [0, 100]));
    }
  }
  drawLeadSilence(vy0);
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
  else if ((S.toolMode === "trace" || S.traceHeld || S.heatPreview) && S.mouseX != null && S.mouseY != null) drawTraceRange([[S.mouseX, S.mouseY]]);

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
  const editTargets = fretboardEditTargets();
  const omittedCrosses = [];
  const outOfRange = [];
  const staleMarks = [];
  const ghostNotes = [];
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    const { omitted: omittedNotes, added: addedNotes } = arrangementMarksForLane(lane);
    // Every lane has a tuning and the fretboard will voice against it, whether
    // or not the tab view happens to render this lane — so the range warning is
    // not conditional on tablatureEnabled.
    const tuning = laneFretTuning(lane);
    // Non-active and locked lanes are read-only reference: gray and half transparent,
    // notes and their labels (drawNoteFx), so the layer being edited stands out.
    const dimmed = lane !== actLane || lane.locked;
    const laneAlpha = dimmed ? 0.5 : 1, laneColor = dimmed ? grayHex(lane.color) : lane.color;
    for (const ghost of addedNotes) ghostNotes.push({ ...ghost, alpha: laneAlpha, capo: Number(lane.capo) || 0 });
    // Adjacent written attacks otherwise fuse into one solid bar. Indexing their
    // shared edges makes sliced sustains (and other re-attacks) explicit without
    // turning the draw loop into a quadratic search on imported arrangements.
    const edgeKey = (pitch, time) => `${pitch}|${Number(time).toFixed(5)}`;
    const reattackEdges = new Set(lane.notes.map((note) => edgeKey(note.pitch, note.end)));
    sctx.globalAlpha = laneAlpha;
    const stale = lane.notes.some((n) => n.auto && !n.pos) ? staleForLane(lane) : null;
    for (const n of lane.notes) {
      const motion = noteMotion(lane, n);
      const ribbon = noteRibbon(lane, n);
      const x = xOf(motion.start), w = Math.max(2, xOf(ribbon?.end ?? motion.end) - x), y = yOf(n.pitch);
      if (x > vx1 || x + w < vx0) continue; // off-screen
      const rowH = S.state.rowH;
      const fill = stackCount.has(n) ? PAINT.error : laneColor;
      sctx.save();
      sctx.translate(x + w / 2, y + rowH / 2);
      sctx.scale(motion.scaleX, motion.scale);
      sctx.translate(-x - w / 2, -y - rowH / 2);
      // Bent notes draw as a ribbon following the audible pitch — the bar itself
      // traces the bend curve instead of staying a flat rect with a glyph on top,
      // so the drawn pitch always matches what's exported. A prebend's bar sits
      // flat but *above* the fretted row, which is what it actually sounds.
      const curve = bendCurve(n) || ribbon?.points;
      const active = editTargets.has(n);
      const glow = notePlaybackGlow(lane, n);
      if (glow > 0) {
        sctx.beginPath();
        if (curve) traceBendPath(x, w, y + rowH / 2, curve, rowH);
        else sctx.roundRect(x, y, w, rowH, Math.min(2, w / 2, rowH / 2));
        paintNoteGlow(sctx, glow, curve ? rowH : 0);
      }
      // Selection uses an opaque, patterned body, including on curved notes.
      sctx.globalAlpha = S.selection.has(n) ? 1 : laneAlpha * motion.alpha;
      const drop = curve ? bendPeak(curve) * rowH : 0;
      // Dashed outer frames mark edit recipients, including distant occurrences
      // in a shared selection. Playback retains its separate soft glow.
      if (active && curve) {
        sctx.save();
        sctx.globalAlpha = 1;
        sctx.lineCap = "butt"; sctx.lineJoin = "round";
        sctx.beginPath(); traceBendPath(x, w, y + rowH / 2, curve, rowH);
        sctx.lineWidth = rowH + 7; sctx.strokeStyle = PAINT.ink; sctx.stroke();
        sctx.setLineDash([5, 3]);
        sctx.lineWidth = rowH + 4; sctx.strokeStyle = PAINT.accent; sctx.stroke();
        sctx.restore();
      }
      if (curve) {
        sctx.lineCap = "butt"; sctx.lineJoin = "round";
        sctx.beginPath(); traceBendPath(x, w, y + rowH / 2, curve, rowH);
        if (S.selection.has(n)) {
          const selectionHeight = Math.max(6, rowH);
          paintNoteSelection(sctx, selectionHeight);
          sctx.lineWidth = selectionHeight - 2; sctx.strokeStyle = noteSelectionFill(sctx); sctx.stroke();
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
      } else if (n.gripOnly) {
        // Shown in the grip, never played: a faint body with a dashed rim.
        sctx.save();
        sctx.globalAlpha *= 0.35;
        paintNoteRow(sctx, x, y, w, rowH, fill, S.selection.has(n), n === S.hoverNote, motion.emphasis, motion.reveal);
        sctx.restore();
        sctx.save();
        sctx.setLineDash([3, 2]); sctx.lineWidth = 1; sctx.strokeStyle = fill;
        sctx.beginPath(); sctx.roundRect(x + 0.5, y + 0.5, Math.max(1, w - 1), rowH - 1, 3); sctx.stroke();
        sctx.restore();
      } else {
        paintNoteRow(sctx, x, y, w, rowH, fill, S.selection.has(n), n === S.hoverNote, motion.emphasis, motion.reveal);
      }
      if (active && !curve) {
        sctx.save();
        sctx.globalAlpha = 1;
        sctx.beginPath(); sctx.roundRect(x - 3, y - 3, w + 6, rowH + 6, 4);
        sctx.lineWidth = 4; sctx.strokeStyle = PAINT.ink; sctx.stroke();
        sctx.setLineDash([5, 3]);
        sctx.lineWidth = 2; sctx.strokeStyle = PAINT.accent; sctx.stroke();
        sctx.restore();
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
      if (n.pos || n.arrangement) {  // Only explicitly stored overrides get a star.
        // The mark follows the end of a bent note's bar.
        // Drawn above-left, outside the bar, so it never competes with the
        // note's own fill color or the name label.
        const py = curve ? y - curve[curve.length - 1][1] * rowH : y;
        sctx.font = stageUi(11, 700); sctx.textAlign = "left"; sctx.textBaseline = "alphabetic";
        sctx.lineWidth = 2.5; sctx.strokeStyle = halo();
        sctx.strokeText("*", x, py - 1);           // dark halo for legibility over the spectrogram
        sctx.lineWidth = 1; sctx.fillStyle = PAINT.error;
        sctx.fillText("*", x, py - 1);
        sctx.font = stageMono(STAGE_ANCHORED); sctx.textAlign = "left"; sctx.textBaseline = "middle";
      }
      const other = stale?.get(n);
      if (other && !n.pos) {
        // The engine would place it elsewhere today. Above-right in the warn colour,
        // where the override's red star is above-left, so the two never meet.
        const py = curve ? y - curve[curve.length - 1][1] * rowH : y;
        sctx.font = stageUi(11, 700); sctx.textAlign = "right"; sctx.textBaseline = "alphabetic";
        sctx.lineWidth = 2.5; sctx.strokeStyle = halo();
        sctx.strokeText("*", x + w, py - 1);
        sctx.lineWidth = 1; sctx.fillStyle = PAINT.warn;
        sctx.fillText("*", x + w, py - 1);
        sctx.font = stageMono(STAGE_ANCHORED); sctx.textAlign = "left"; sctx.textBaseline = "middle";
        const open = noteName(laneFretTuning(lane)[other.string]).replace(/-?\d+$/, "");
        staleMarks.push({ x: x + w - 8, y: py - 12, tip: {
          title: "Automatic would place this elsewhere",
          body: `Placed by an earlier solve. Today the automatic choice is fret ${other.fret} on the ${open} string. Recalculate positions takes it.`,
          tone: "warning" } });
      }
      if (omittedNotes.has(n)) {
        const crossY = drop ? y - drop : y;
        omittedCrosses.push({ x, y: crossY, w, h: rowH + drop, alpha: laneAlpha });
      }
      if (outOfFretboardRange(n.pitch, tuning, laneFretCount(lane)))
        outOfRange.push({ x, y: drop ? y - drop : y, w, h: rowH + drop, alpha: laneAlpha });
      sctx.restore();
    }
  }
  // Removed notes and brief drag trails are visual remnants only. They never
  // enter the selection, hit tests, minimap, playback or export.
  const motionLabels = resolveNoteAppearance(spectrogramLabelOptions());
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
    const label = spectrogramLabel(note, note.pos, motionLabels.mode, [], motionLabels.fromNut ? Number(lane.capo) || 0 : 0);
    if (label && w >= sctx.measureText(label).width + 6) {
      sctx.fillStyle = PAINT.text; sctx.fillText(label, x + 3, y + h / 2);
    }
    sctx.restore();
  }
  sctx.globalAlpha = 1;
  sctx.textBaseline = "alphabetic";
  drawMotifs(vx0, vx1);
  drawShapes(vx0, vx1);
  drawDropPreview();
  drawStackBadges(stackBadges, vx0, vx1);
  drawBendHandles();
  drawNoteFx();
  drawOmittedNoteCrosses(omittedCrosses);
  drawOutOfRangeNotes(outOfRange);
  sctx.save();
  sctx.lineWidth = 1.5;
  sctx.font = stageUi(14); sctx.textAlign = "left"; sctx.textBaseline = "bottom";
  warningMarks = [];
  // tip: { title, body, tone } with tone "error" or "warning", which sets the colour.
  const frameWarning = (notes, tip) => {
    sctx.strokeStyle = sctx.fillStyle = tip.tone === "error" ? PAINT.error : PAINT.warn;
    const left = xOf(Math.min(...notes.map(n => n.start))) - 3;
    const right = xOf(Math.max(...notes.map(n => n.end))) + 3;
    if (left > vx1 || right < vx0) return;
    const top = Math.min(...notes.map(n => yOf(n.pitch))) - 4;
    const bottom = Math.max(...notes.map(n => yOf(n.pitch))) + S.state.rowH + 4;
    sctx.setLineDash([4, 3]); sctx.strokeRect(left, top, right - left, bottom - top);
    sctx.setLineDash([]);
    const markX = Math.max(left, vx0 + 4);
    sctx.fillText("⚠", markX, top - 2);
    warningMarks.push({ x0: markX - 3, x1: markX + 17, y0: top - 19, y1: top + 1, tip });
  };
  const frames = [];
  const hoverMark = (x, y, w, h, tip) => warningMarks.push({ x0: x, x1: x + w, y0: y, y1: y + h, tip });
  for (const m of staleMarks) hoverMark(m.x, m.y, 10, 12, m.tip);
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    // The editor's own problems (note-issues.js): a shape is framed; the others
    // have their own mark on the note already and explain it on hover.
    for (const issue of laneIssues(lane, laneFretTuning(lane), laneFretCount(lane), S.voicingRevision)) {
      const tip = { title: issue.title, body: issue.help, tone: issue.tone }, n = issue.notes[0];
      if (issue.kind === "shape") frames.push([issue.notes, tip]);
      else if (issue.kind === "outOfRange") hoverMark(xOf(n.start), yOf(n.pitch), Math.max(2, xOf(n.end) - xOf(n.start)), S.state.rowH, tip);
      else if (issue.kind === "stack") hoverMark(xOf(n.start), yOf(n.pitch) + S.state.rowH / 2 - 9, 18, 18, tip);
    }
    // What the Rocksmith export would report about these notes (rocksmith-check.js).
    for (const { notes, issue } of rocksmithIssueNotes(lane))
      frames.push([notes, { title: issue.title, body: issue.help, tone: issue.important ? "error" : "warning" }]);
  }
  // Errors last, so a frame that is both shows red.
  for (const [notes, tip] of frames.sort((a, b) => (a[1].tone === "error") - (b[1].tone === "error"))) frameWarning(notes, tip);
  // Bend points stacked on one moment: a count like an overlap stack's, in --warn
  // because the export resolves it, up and right of the point so its handle stays free.
  sctx.font = stageMono(STAGE_ANCHORED, 600); sctx.textAlign = "center"; sctx.textBaseline = "middle";
  for (const lane of S.state.lanes) {
    if (!lane.visible) continue;
    for (const note of lane.notes) {
      if (!note.bend || xOf(note.end) < vx0 || xOf(note.start) > vx1) continue;
      for (const { x, y, count } of stackedBendPoints(note)) {
        const cx = x + 10, cy = y - 10;
        sctx.beginPath(); sctx.arc(cx, cy, 7.5, 0, Math.PI * 2);
        sctx.fillStyle = veil(PAINT.ground); sctx.fill();
        sctx.lineWidth = 2; sctx.strokeStyle = PAINT.warn; sctx.stroke();
        sctx.fillStyle = PAINT.text; sctx.fillText(String(count), cx, cy + 0.5);
        warningMarks.push({ x0: cx - 9, x1: cx + 9, y0: cy - 9, y1: cy + 9, tip: BEND_STACK_TIP });
      }
    }
  }
  sctx.restore();
  drawGhostNotes(ghostNotes);
  drawReferences();
  drawChordNames(vx0, vx1);
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
  drawComments();
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
  syncProjectStartHandle();
  overview?.draw();
}

// The export's leading silence, before the song (S.leadView, lead-view.js):
// no audio there, only the grid the export runs back into it.
function drawLeadSilence(vy0) {
  const x = xOf(0);
  if (!S.leadView || x <= 0) return;
  sctx.fillStyle = veil(); sctx.fillRect(0, vy0, x, S.stageHeight);
  sctx.strokeStyle = PAINT.line; sctx.lineWidth = 1;
  sctx.beginPath(); sctx.moveTo(x - .5, vy0); sctx.lineTo(x - .5, vy0 + S.stageHeight); sctx.stroke();
  sctx.font = stageUi(11); sctx.fillStyle = PAINT.hint; sctx.textAlign = "left"; sctx.textBaseline = "bottom";
  sctx.fillText(`Leading silence ${+S.leadView.toFixed(2)} s`, 8, vy0 + S.stageHeight - 8, Math.max(0, x - 16));
  sctx.textBaseline = "alphabetic";
}

// ---- overview: the whole song with the visible frame as its window ----
// Its body drag recenters the main viewport; ruler and headroom scrub.
let overview = null;

function createEditorOverview() {
  const follow = (t) => followViewportTo(xOf(t) - scroll.clientWidth / 2);
  return createOverview({
    ruler: overviewRuler, map: minimap,
    time: { root: document.getElementById('overviewTime'), button: document.getElementById('overviewTimeLabel'),
      input: document.getElementById('overviewTimeInput') },
    getTime: playbackTime, getLead: () => S.leadView,
    seek: (t, phase) => {
      if (phase === "end") return;
      setPlaybackCursor(t);
      if (phase === "jump") moveViewportTo(xOf(t) - scroll.clientWidth / 2);
      else follow(t);
      draw();
    },
    frame: () => {
      const t0 = scroll.scrollLeft / S.pxPerSec - S.leadView, y0 = scroll.scrollTop / contentH();
      return { t0, t1: t0 + scroll.clientWidth / S.pxPerSec, y0, y1: y0 + S.stageHeight / contentH() };
    },
    bodyDown: (t) => {
      const go = (time) => {
        const max = scroll.scrollWidth - scroll.clientWidth;
        followViewportTo(Math.max(0, Math.min(max, xOf(time) - scroll.clientWidth / 2)));
      };
      go(t);
      return { move: go, up: () => {} };
    },
    onDrag: (seeking, dragging) => { S.mmSeeking = seeking; S.mmDragging = dragging; },
  });
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
  overview = createEditorOverview();
  setPainter(paintFrame);
  // A canvas draws with whatever is loaded the instant fillText runs, and unlike
  // the DOM it is never re-laid-out when a webfont arrives. Both families are
  // fetched with display=swap, so a stage painted during that swap keeps the
  // fallback metrics until something else happens to request a frame. One
  // repaint when the fonts settle costs nothing and removes the whole class of
  // "the first frame is in Segoe UI" bug.
  document.fonts?.ready.then(draw);
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
    S.lastPointerX = e.clientX; S.lastPointerY = e.clientY;
    if (S.drag || !S.state) return;
    const [x, y] = localXY(e);
    const t = timeAt(x), pitch = pitchAt(y);
    const hit = pickNote(t, pitch, pitchAtExact(y));
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
    mkCur = mkCur || markerCursorAt(x, y) || commentCursorAt(x, y);
    if (e.ctrlKey || e.metaKey) cur = "crosshair";           // Ctrl/Cmd-drag draws; click toggles selection
    else if (mkCur) cur = mkCur;                             // over a timing or section flag
    else if (!e.shiftKey && !S.sliceHeld && regionEdgeAt(x)) cur = "ew-resize";
    else if (mi >= 0) cur = "pointer";                       // hovering a suggestion
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && refLockAt(x, y)) cur = "pointer";   // pitch lock toggle
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && shapeLabelAt(S.shapeLabels, x, y)) cur = "pointer"; // shape name: click selects
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && refBadgeAt(x, y)) cur = "grab"; // reference badge (click = select, drag = move)
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (rbe = refBoxEdgeAt(x, y)))
      cur = refEdgeCursor(rbe.edge);                         // reference box edge or corner
    else if (S.sliceHeld) cur = "crosshair";                 // hold S = temporary Slice line
    else if (e.altKey) cur = "col-resize";                   // Alt = detect-frame band
    else if (hit && hit.lane !== activeLane()) cur = "pointer";  // click switches the edit target to this layer
    else if (hit) cur = edgeOf(hit.note, x) ? "ew-resize" : "move";
    else cur = "grab";                                       // empty = pan; a click still seeks
    stage.style.cursor = cur;
    // A warning mark explains itself in a tooltip at the pointer.
    // A warning mark explains itself; otherwise a rail flag may say what it is.
    const tips = warningMarks.filter(m => x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1).map(m => m.tip)
      .sort((a, b) => (b.tone === "error") - (a.tone === "error"));
    const railTip = !tips.length && markerRails().map(rail => rail.tipAt?.(x, y)).find(Boolean);
    showTooltip(railTip ? [railTip] : tips, e.clientX, e.clientY);
    S.refEdgeHover = rbe && canEditLane(rbe.lane) ? rbe : null;
    S.refLockHover = refLockAt(x, y);
    S.mouseX = x;
    S.mouseY = y;
    S.hoverNote = hit ? hit.note : null;
    draw();
  });
  stage.addEventListener("mouseleave", () => {
    S.pitchHoverClientY = null;
    stage.style.cursor = "default";
    hideTooltip();
    cancelHoverPreview();
    S.mouseX = null; S.mouseY = null; S.hoverNote = null; S.matchHover = -1; S.refEdgeHover = null; S.refLockHover = null; draw();
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
    hideNoteMenu({ scroll: true });
    draw();
  }, { passive: true });
}
