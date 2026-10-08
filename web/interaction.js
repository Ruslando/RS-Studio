// Pointer interaction: hit testing, the mousedown/move/up gesture state machine
// (select / move / marquee / trace / frame), edge auto-scroll while dragging, and
// the sidebar drag-to-resize / collapse.

import { SNAP_SEMI, SNAP_T, bendAt, bendCurve, clampSemi, snapTo } from "./bend.js";
import { AUTOSCROLL_MAX, AUTOSCROLL_ZONE, BEND_HANDLE_R, EDGE_PX, MIN_DUR, MIN_REGION, ZOOM_STEP } from "./constants.js";
import { openDetectPanel, updateDetectStatus } from "./detect.js";
import { bendHandles, regionEdgeAt } from "./note-render.js";
import { scroll, stage } from "./dom.js";
import { draw } from "./repaint.js";
import { addBendPoint, commit, openCanvasMenu, openNoteMenu, openRefMenu, removeBendPoint, setBendCurve, sliceNoteCuts, snapshotEdit } from "./edit.js";
import { pitchAt, timeAt, xOf, yOf, zoomAtClientY, zoomBothTo } from "./geometry.js";
import { minDur, snap, snapNote } from "./grid.js";
import { markerMouseDown } from "./markers.js";
import { markerRails, railsBottom } from "./marker-rails.js";
import { activeLane, canEditLane, editLanes, laneOf, refreshCounts, renderLanes, setLaneNotePitch, targetLane } from "./lanes.js";
import { auditionNote, previewNotes, seekPlayback } from "./playback.js";
import { toast } from "./notify.js";
import { moveRefOccurrence, notesInBox, refBadgeAt, refBoxEdgeAt, resizeRefBox } from "./references.js";
import { lineXAtRow } from "./slice.js";
import { beginNoteGesture, finishNoteGesture, updateNoteGesture } from "./note-motion.js";
import { nid } from "./ids.js";
import { S, setSelection } from "./store.js";
import { acceptMatch, addTracePoint, clearMatches, matchAt, notesFromTrace } from "./tracing.js";
import { clamp } from "./util.js";

let sliceHeld = false;

function noteAt(lane, t, pitch) {
  if (!lane) return null;
  for (let i = lane.notes.length - 1; i >= 0; i--) {
    const n = lane.notes[i];
    if (t < n.start || t > n.end) continue;
    if (n.pitch === pitch) return n;

    // A bent note is drawn along its audible pitch, which can sit several rows
    // above its fretted/base pitch. Treat that ribbon as part of the note too,
    // so an unselected bend can be picked from anywhere along its visible curve.
    const curve = bendCurve(n);
    if (!curve) continue;
    const duration = Math.max(1e-6, n.end - n.start);
    const audiblePitch = n.pitch + bendAt(curve, (t - n.start) / duration);
    if (Math.abs(pitch - audiblePitch) <= 0.5) return n;
  }
  return null;
}

export function pickNote(t, pitch) {
  const order = [activeLane(), ...S.state.lanes.filter((l) => l !== activeLane())];
  for (const lane of order) {
    // Locked or hidden lanes are display-only — never hit-test them, so their
    // notes can't be grabbed, moved, or selected.
    if (!lane || !lane.visible || lane.locked) continue;
    const n = noteAt(lane, t, pitch);
    if (n) return { lane, note: n };
  }
  return null;
}

export function edgeOf(note, x) {
  if (Math.abs(x - xOf(note.start)) <= EDGE_PX) return "l";
  if (Math.abs(x - xOf(note.end)) <= EDGE_PX) return "r";
  return null;
}

// A bend control point under the cursor, on a selected + editable note. Only the
// selection draws handles, so that's the only place they can be grabbed.
function bendHandleAt(x, y) {
  const grab = BEND_HANDLE_R + 3;
  for (const n of S.selection) {
    if (!n.bend || !canEditLane(laneOf(n))) continue;
    for (const h of bendHandles(n)) {
      if (Math.abs(x - h.x) <= grab && Math.abs(y - h.y) <= grab) return h;
    }
  }
  return null;
}

// The selected note whose bend curve passes within `grab` px of (x, y) — what
// double-click adds a control point to.
function bendCurveAt(x, y, grab = 6) {
  for (const n of S.selection) {
    const pts = bendCurve(n);
    if (!pts || !canEditLane(laneOf(n))) continue;
    const x0 = xOf(n.start), w = Math.max(2, xOf(n.end) - x0);
    if (x < x0 - grab || x > x0 + w + grab) continue;
    const t = clamp((x - x0) / w, 0, 1);
    const cy = yOf(n.pitch) + S.state.rowH / 2 - bendAt(pts, t) * S.state.rowH;
    if (Math.abs(y - cy) <= grab) return { note: n, t };
  }
  return null;
}


// Overlapping same-pitch notes are kept (and flagged as stacks), not merged, so
// changing the selection just updates it — nothing to reconcile on deselect.
// ---- mouse interaction ----
// World-space coords (absolute song px) from client coords — so the auto-scroll
// loop can recompute a drag from a stationary cursor as the viewport pans.
function clientToCanvas(cx, cy) {
  // The canvas is sticky (its rect stays at the viewport's top-left and no longer
  // moves with scroll), so add scrollLeft/scrollTop to map back into world px —
  // what every caller (timeAt, pitchAt, hit-testing, trace points) expects.
  const r = stage.getBoundingClientRect();
  return [cx - r.left + scroll.scrollLeft, cy - r.top + scroll.scrollTop];
}

export function localXY(e) {
  return clientToCanvas(e.clientX, e.clientY);
}

// Apply the active drag at a canvas-space position. Shared by the mousemove
// handler and the edge auto-scroll loop (which feeds a recomputed position as
// the viewport pans under a stationary cursor).
function updateDrag(x, y) {
  if (S.drag.mode === "scrub") {
    seekPlayback(timeAt(x)); return;
  }
  if (S.drag.mode === "tracePending") {
    if (Math.hypot(x - S.drag.x0, y - S.drag.y0) < 4) return;
    const { x0, y0 } = S.drag;
    S.drag.mode = "trace";
    S.drag.points = [];
    addTracePoint(S.drag.points, x0, y0);
    addTracePoint(S.drag.points, x, y);
    draw(); return;
  }
  if (S.drag.mode === "trace") { addTracePoint(S.drag.points, x, y); draw(); return; }
  if (S.drag.mode === "slice") {
    S.drag.x1 = xOf(snap(timeAt(x))); S.drag.y1 = y;
    draw(); return;
  }
  if (S.drag.mode === "refBox") { resizeRefBox(S.drag, x, y); return; }
  if (S.drag.mode === "refDrag") { moveRefOccurrence(S.drag, x); return; }
  if (S.drag.mode === "bendPoint") {
    // Drag one control point of the curve. Snapping lands on Guitar Pro's own
    // bend grid (12 columns x quarter-tones), which is all .gp5 can store; Alt
    // frees it, which float-time targets keep exactly and .gp5 rounds.
    const n = S.drag.note, rowH = S.state.rowH, pts = bendCurve(n).map((p) => [...p]);
    const i = S.drag.i, dur = Math.max(1e-6, n.end - n.start);
    let t = (timeAt(x) - n.start) / dur;
    let semi = (yOf(n.pitch) + rowH / 2 - y) / rowH;
    if (!S.drag.free) { t = snapTo(t, SNAP_T); semi = snapTo(semi, SNAP_SEMI); }
    // The end points pin the curve to the note's edges — only their pitch moves.
    // Middle points stay between their neighbors so the drag can't reorder them
    // out from under the cursor.
    if (i === 0) t = 0;
    else if (i === pts.length - 1) t = 1;
    else t = clamp(t, pts[i - 1][0], pts[i + 1][0]);
    pts[i] = [t, clampSemi(semi)];
    setBendCurve(n, pts);
    draw(); return;
  }
  if (S.drag.mode === "marquee") { S.marquee.x1 = x; S.marquee.y1 = y; draw(); return; }
  if (S.drag.mode === "region") { S.detectRegion.t1 = Math.max(0, timeAt(x)); draw(); return; }
  if (S.drag.mode === "regionEdge") {
    const t = clamp(timeAt(x), 0, S.state.duration);
    if (S.drag.edge === "l") S.detectRegion.t0 = Math.min(t, S.detectRegion.t1 - MIN_REGION);
    else S.detectRegion.t1 = Math.max(t, S.detectRegion.t0 + MIN_REGION);
    updateDetectStatus(); draw(); return;
  }
  if (S.drag.mode === "resize") {
    // Drag one edge; every selected note's matching edge shifts by the same
    // delta (so a multi-note selection resizes together). Each note is clamped
    // so it can't invert past its own opposite edge.
    const o = S.drag.orig.get(S.drag.note);
    if (S.drag.edge === "r") {
      const dt = Math.max(o.start + minDur(), snap(timeAt(x))) - o.end;
      for (const n of S.drag.notes) {
        const oo = S.drag.orig.get(n);
        n.end = Math.max(oo.start + minDur(), oo.end + dt);
      }
    } else {
      const dt = Math.min(o.end - minDur(), Math.max(0, snap(timeAt(x)))) - o.start;
      for (const n of S.drag.notes) {
        const oo = S.drag.orig.get(n);
        n.start = Math.min(oo.end - minDur(), Math.max(0, oo.start + dt));
      }
    }
    updateNoteGesture(S.state, laneOf(S.drag.note), S.drag.notes);
    draw(); return;
  }
  if (S.drag.mode === "move") {
    S.drag.moved = true;
    const dt = timeAt(x) - timeAt(S.drag.startX);
    const dRow = Math.floor(y / S.state.rowH) - Math.floor(S.drag.startY / S.state.rowH);
    for (const n of S.drag.notes) {
      const o = S.drag.orig.get(n);
      const len = o.end - o.start;
      const s = Math.max(0, o.start + dt);          // keep the note out of negative time
      const q = snapNote(s, s + len);               // both edges land on the grid (Snap on)
      n.start = q.start;
      n.end = q.end;
      setLaneNotePitch(S.drag.lane, n,
        Math.max(S.state.spec.midi_low, Math.min(S.state.spec.midi_high, o.pitch - dRow)));
    }
    // Audible feedback: each time the drag crosses to a new pitch row, play the
    // moved notes so you can hear where you're landing. Pure horizontal nudges
    // (dRow unchanged) stay silent.
    if (dRow !== S.drag.lastRow) { S.drag.lastRow = dRow; previewNotes(S.drag.notes, S.drag.lane); }
    updateNoteGesture(S.state, S.drag.lane, S.drag.notes);
    draw();
  }
}

// ---- edge auto-scroll: pan the timeline whenever a DRAG nears a viewport edge ----
// Only while a drag is in progress, so it follows a note draw / marquee / trace
// past the edge — plain hovering no longer pans the frame (and so reaching for
// the vertical scrollbar on the right doesn't drag the timeline along). The right
// edge is measured from the content width, excluding the scrollbar gutter.
function updateAutoScroll(clientX) {
  if (!S.state || !S.drag) { stopAutoScroll(); return; }
  const r = scroll.getBoundingClientRect();
  const left = clientX - r.left, right = r.left + scroll.clientWidth - clientX;
  let vel = 0;
  if (left >= 0 && left < AUTOSCROLL_ZONE) vel = -AUTOSCROLL_MAX * (1 - left / AUTOSCROLL_ZONE);
  else if (right >= 0 && right < AUTOSCROLL_ZONE) vel = AUTOSCROLL_MAX * (1 - right / AUTOSCROLL_ZONE);
  S.autoScrollVel = vel;
  if (vel) startAutoScroll(); else stopAutoScroll();
}

function startAutoScroll() {
  if (S.autoScrollRaf) return; // already looping
  const step = () => {
    S.autoScrollRaf = 0;
    if (!S.autoScrollVel) return;
    const max = scroll.scrollWidth - scroll.clientWidth;
    const next = Math.max(0, Math.min(max, scroll.scrollLeft + S.autoScrollVel));
    if (next !== scroll.scrollLeft) {
      scroll.scrollLeft = next;
      // Cursor is stationary but the canvas moved under it — refresh from it:
      // continue an active drag, or just keep the hover cursor line aligned.
      const [x, y] = clientToCanvas(S.lastPointerX, S.lastPointerY);
      if (S.drag) updateDrag(x, y);
      else { S.mouseX = x; S.mouseY = y; draw(); }
    }
    S.autoScrollRaf = requestAnimationFrame(step);
  };
  S.autoScrollRaf = requestAnimationFrame(step);
}

function stopAutoScroll() {
  if (S.autoScrollRaf) cancelAnimationFrame(S.autoScrollRaf);
  S.autoScrollRaf = 0;
  S.autoScrollVel = 0;
}

export function init_interaction() {
  // Like FL Studio's temporary tools, Slice exists only while its key is held.
  // It deliberately does not alter the active persistent Select/Trace/etc. mode.
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "s" ||
        /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
    sliceHeld = true;
    S.sliceHeld = true;
    if (!S.drag) stage.style.cursor = "crosshair";
  });
  window.addEventListener("keyup", (e) => {
    if (e.key.toLowerCase() !== "s") return;
    sliceHeld = false;
    S.sliceHeld = false;
    if (!S.drag) stage.style.cursor = "default";
    draw();
  });
  stage.addEventListener("mousedown", (e) => {
    if (!S.state || e.button !== 0 || e.ctrlKey || e.metaKey) return; // right-click handled by contextmenu
    // Bottom-up: the lowest rail gets first refusal, then tempo/meter flags.
    const rails = markerRails();
    for (let i = rails.length - 1; i >= 0; i--) if (rails[i].mouseDown?.(e)) return;
    if (markerMouseDown(e)) return;
    const [x, y] = localXY(e);
    const t = timeAt(x), pitch = pitchAt(y);
  
    // The active tool decides what a plain drag does; a held modifier always wins,
    // so Shift/Alt keep working as accelerators no matter which tool is set.
    const noMod = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const tool = noMod ? S.toolMode : null;
    const defaultTrace = noMod && S.toolMode === "trace";
    const wantTrace = tool === "trace";
    const wantMarquee = e.shiftKey || tool === "marquee";
    const wantFrame = e.altKey || tool === "frame";
    const wantSlice = sliceHeld && noMod;
    const plainSelect = noMod && (S.toolMode === "select" || defaultTrace);
    const noteHit = plainSelect ? pickNote(t, pitch) : null;
  
    // A selected note's bend curve is edited right on the spectrogram: drag a
    // control point onto what the audio actually shows. Checked before every
    // other gesture so a handle floating above its note stays grabbable — but
    // only in the Select tool with no Ctrl/Shift, so trace and marquee are never
    // blocked. Alt still reaches here (it means "place freely", not "frame").
    if (plainSelect) {
      const handle = bendHandleAt(x, y);
      if (handle) {
        S.drag = { mode: "bendPoint", note: handle.note, i: handle.i, free: e.altKey, prev: snapshotEdit() };
        return;
      }
    }

    // Similar-passage suggestions on screen: a plain click on one places it; any
    // other click dismisses them and falls through to normal editing.
    if (S.matches.length) {
      const mi = plainSelect ? matchAt(x, y) : -1;
      if (mi >= 0) { acceptMatch(mi); return; }
      clearMatches();
    }

    // Holding S enables FL-style line slicing: mousedown drops the pivot,
    // dragging draws the line (free vertical position, time x-coordinate
    // snapped), and releasing applies the cut. One continuous gesture.
    if (wantSlice) {
      const sx = xOf(snap(t));
      S.drag = { mode: "slice", x0: sx, y0: y, x1: sx, y1: y };
      draw();
      return;
    }
  
    // Click a reference's number badge to select everything inside that box; drag the
    // badge to relocate the whole occurrence (box + its notes) as a unit, leaving the
    // siblings untouched. The select happens up front, so a plain click just selects.
    if (plainSelect) {
      const badge = refBadgeAt(x, y);
      if (badge && canEditLane(badge.lane)) {
        const inside = notesInBox(badge.box, badge.lane.notes);
        S.state.lanes.forEach((l) => (l.active = l === badge.lane)); renderLanes();
        setSelection(new Set(inside));
        const group = badge.lane.refBoxes[badge.ref];
        S.drag = {
          mode: "refDrag", lane: badge.lane, ref: badge.ref, i: badge.i,
          a0: group.anchors[badge.i], grabT: timeAt(x),
          notes: inside.map((n) => ({ n, s: n.start, e: n.end })),
          prev: snapshotEdit(),
        };
        draw();
        return;
      }
      // Grab a reference box edge to resize its capture region (mirrors to siblings).
      const redge = refBoxEdgeAt(x, y);
      if (redge && canEditLane(redge.lane)) { S.drag = { mode: "refBox", ...redge, prev: snapshotEdit() }; draw(); return; }
    }
  
    // Grab a detect-frame handle to resize that edge (works in Select or Frame,
    // so an existing band can be adjusted by dragging its sides).
    if (!wantTrace && !wantMarquee) {
      const redge = regionEdgeAt(x);
      if (redge) { S.drag = { mode: "regionEdge", edge: redge }; draw(); return; }
    }
  
    // Frame (Alt-drag) = select a time frame (a vertical band across all pitches)
    // to scope detection; releasing opens the Detect popover. A click (no drag)
    // clears the frame.
    if (wantFrame) {
      S.drag = { mode: "region", x0: x };
      S.detectRegion = { t0: timeAt(x), t1: timeAt(x) };
      draw();
      return;
    }
  
    // The Trace tool draws a guide path through spectrogram heat, then
    // create snapped notes from the brightest nearby pitch rows.
    if (wantTrace && S.spectImg && !(defaultTrace && noteHit)) {
      if (defaultTrace) {
        S.drag = { mode: "tracePending", x0: x, y0: y };
        setSelection(new Set());
        return;
      }
      const points = [];
      addTracePoint(points, x, y);
      S.drag = { mode: "trace", points };
      setSelection(new Set());
      draw();
      return;
    }
  
    // Marquee (Shift-drag) = box selection.
    if (wantMarquee) {
      S.drag = { mode: "marquee", x0: x, y0: y };
      S.marquee = { x0: x, y0: y, x1: x, y1: y };
      return;
    }
  
    // Plain left-click: grab a note (select / move / resize) or move the cursor.
    const hit = noteHit || pickNote(t, pitch);
    if (hit) {
      // Editing is scoped to the active layer. Clicking a note in a *different*
      // visible layer just retargets focus to that layer (and selects the note) —
      // a second grab then edits it. This is what makes selecting a layer mean
      // something: you only ever edit one layer at a time.
      if (hit.lane !== activeLane()) {
        S.state.lanes.forEach((l) => (l.active = l === hit.lane));
        renderLanes();
        setSelection(new Set([hit.note]));
        auditionNote(hit.note, hit.lane);
        draw();
        return;
      }
      if (!S.selection.has(hit.note)) setSelection(new Set([hit.note]));
      // Click-to-hear: audition the clicked note's pitch (also unlocks audio on
      // this gesture so a follow-up vertical drag can play landing pitches).
      auditionNote(hit.note, hit.lane);
      const edge = edgeOf(hit.note, x);
      if (edge) {
        const notes = [...S.selection].filter((n) => hit.lane.notes.includes(n));
        S.drag = {
          mode: "resize", edge, note: hit.note, prev: snapshotEdit(), notes,
          orig: new Map(notes.map((n) => [n, { start: n.start, end: n.end }])),
        };
      } else {
        S.drag = {
          mode: "move", startX: x, startY: y, moved: false, prev: snapshotEdit(),
          lane: hit.lane, lastRow: 0,
          notes: [...S.selection].filter((n) => hit.lane.notes.includes(n)),
          orig: new Map([...S.selection].map((n) => [n, { start: n.start, end: n.end, pitch: n.pitch }])),
        };
      }
      beginNoteGesture(S.state, hit.lane, S.drag.notes, S.drag.mode);
      draw();
    } else {
      // empty space: move the time cursor, drag to scrub
      seekPlayback(t);
      setSelection(new Set());
      S.drag = { mode: "scrub" };
    }
  });
  // A double-click on empty space adds one grid cell; double-clicking a bend
  // curve still adds a bend point.
  stage.addEventListener("dblclick", (e) => {
    if (!S.state || e.ctrlKey || e.metaKey) return;
    const [x, y] = localXY(e);
    if (bendHandleAt(x, y)) return;              // already a point here
    const hit = bendCurveAt(x, y);
    if (hit) { e.preventDefault(); addBendPoint(hit.note, hit.t); }
    else if (S.toolMode === "trace" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
             y - scroll.scrollTop >= railsBottom() + 2 && !pickNote(timeAt(x), pitchAt(y))) {
      const lane = targetLane(), step = minDur();
      if (!canEditLane(lane) || !step) return;
      const start = Math.max(0, Math.min(snap(timeAt(x)), S.state.duration - step));
      const end = Math.min(S.state.duration, start + step);
      if (end - start < MIN_DUR) return;
      const note = { id: nid(), start, end, pitch: pitchAt(y), confidence: 1 };
      const prev = snapshotEdit();
      lane.notes.push(note);
      commit(prev);
      setSelection(new Set([note]));
      refreshCounts();
      draw();
    }
  });
  // Right-click opens the context menu for whatever is under the cursor — a
  // note, a reference box, a marker rail, or the empty canvas.
  stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!S.state) return;
    const [x, y] = localXY(e);
    // Right-click a bend control point removes it (the two end points pin the
    // curve to the note and stay) — otherwise fall through to the note menu.
    const handle = bendHandleAt(x, y);
    if (handle) { removeBendPoint(handle.note, handle.i); return; }
    // Right-click a reference badge opens its menu, acting on the occurrence it
    // identifies. A locked/hidden layer is view-only, so its references are inert.
    const badge = refBadgeAt(x, y);
    if (badge) {
      if (!canEditLane(badge.lane)) {
        return;
      }
      S.state.lanes.forEach((l) => (l.active = l === badge.lane)); renderLanes();
      setSelection(new Set(notesInBox(badge.box, badge.lane.notes)));   // selection feeds Detach
      draw();
      openRefMenu(e.clientX, e.clientY, {
        lane: badge.lane, group: badge.lane.refBoxes[badge.ref], ref: badge.ref, i: badge.i,
      });
      return;
    }
    const hit = pickNote(timeAt(x), pitchAt(y));
    if (hit) {
      if (!S.selection.has(hit.note)) setSelection(new Set([hit.note]));
      openNoteMenu(e.clientX, e.clientY);
    } else {
      // A selection's actions belong to the selection even when the pointer is
      // over empty space. Keep that selection intact for its context menu.
      if ([...S.selection].some((note) => laneOf(note))) {
        openNoteMenu(e.clientX, e.clientY);
        return;
      }
      // Empty spectrogram → Detect / Paste, but only into an editable target lane.
      // With the target layer locked/hidden (e.g. every layer blocked) there's
      // nowhere to add notes, so the menu stays closed.
      const lane = targetLane();
      if (!canEditLane(lane)) {
        return;
      }
      openCanvasMenu(e.clientX, e.clientY, timeAt(x));
    }
  });
  window.addEventListener("mousemove", (e) => {
    if (!S.drag || !S.state) return;
    S.lastPointerX = e.clientX; S.lastPointerY = e.clientY;
    const [x, y] = localXY(e);
    updateDrag(x, y);
  });
  stage.addEventListener("mousemove", (e) => {
    if (!S.state || S.drag || sliceHeld || !["select", "trace"].includes(S.toolMode)) return;
    const [x, y] = localXY(e);
    const hit = pickNote(timeAt(x), pitchAt(y));
    stage.style.cursor = hit
      ? (edgeOf(hit.note, x) ? "ew-resize" : "move")
      : (S.toolMode === "trace" ? "crosshair" : "default");
  });
  // Pointer motion over the spectrogram feeds auto-scroll (#stage events bubble
  // up to #scroll), so it works whether or not a drag is in progress.
  scroll.addEventListener("mousemove", (e) => {
    S.lastPointerX = e.clientX; S.lastPointerY = e.clientY;
    updateAutoScroll(e.clientX);
  });
  scroll.addEventListener("mouseleave", () => { if (!S.drag) stopAutoScroll(); });
  // Wheel over the spectrogram. Holding Ctrl/⌘ zooms (+Shift = pitch axis; trackpad
  // pinch also arrives as a ctrlKey wheel). Otherwise: a plain wheel pans the
  // timeline; Shift routes wheel motion to pitch scrolling when pitch-zoomed.
  // When NOT pitch-zoomed there's nothing to scroll vertically, so Shift has no
  // vertical effect and a plain vertical wheel still pans time.
  scroll.addEventListener("wheel", (e) => {
    if (!S.state) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const d = e.deltaY || e.deltaX;
      if (!d) return;
      const factor = d < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      // Ctrl/⌘ + scroll (and trackpad pinch) = unified zoom both axes; add Shift to
      // zoom the pitch axis alone.
      if (e.shiftKey) zoomAtClientY(e.clientY, factor);
      else zoomBothTo(S.zoomX * factor, e.clientX, e.clientY);
      return;
    }
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }                 // lines -> px
    else if (e.deltaMode === 2) { dx *= scroll.clientWidth; dy *= scroll.clientWidth; } // pages -> px
    const canScrollY = scroll.scrollHeight - scroll.clientHeight > 1;
    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    if (e.shiftKey) {
      if (canScrollY && delta) { scroll.scrollTop += delta; e.preventDefault(); }
      return;
    }
    if (canScrollY) {
      if (delta) { scroll.scrollLeft += delta; e.preventDefault(); }
      return;
    }
    if (!delta) return;
    scroll.scrollLeft += delta;
    e.preventDefault(); // don't let the page scroll vertically instead
  }, { passive: false });
  // A drag records undo only if it actually moved something — a plain click that
  // happened to start on a note must not push a no-op onto the stack. Comparing
  // two full-project snapshots as JSON is blunt and was written out four times;
  // it is affordable because it runs once per mouse RELEASE, not per mousemove.
  const commitIfChanged = (mirrorSource) => {
    if (!S.drag?.prev) return;
    if (JSON.stringify(snapshotEdit()) === JSON.stringify(S.drag.prev)) return;
    commit(S.drag.prev, mirrorSource);
  };
  window.addEventListener("mouseup", (e) => {
    if (!S.drag || !S.state) return;
    const [x, y] = localXY(e);
    try {
    if (S.drag.mode === "tracePending") {
      seekPlayback(timeAt(x));
    } else if (S.drag.mode === "trace") {
      const lane = targetLane();
      if (lane && lane.visible && !lane.locked) {
        addTracePoint(S.drag.points, x, y);
        const prev = snapshotEdit();
        const added = notesFromTrace(S.drag.points);
        if (added.length) {
          lane.notes.push(...added);
          commit(prev);
          setSelection(new Set(added));
          S.state.lanes.forEach((l) => (l.active = l === lane));
          renderLanes(); refreshCounts();
        }
      }
    } else if (S.drag.mode === "slice") {
      const line = S.drag;
      line.x1 = xOf(snap(timeAt(x))); line.y1 = y;
      // A stray click (no real drag) while holding S is a no-op, not a cut.
      if (Math.hypot(line.x1 - line.x0, line.y1 - line.y0) >= 4) {
        // Intersect each pitch row at its visual centre. This leaves the line's
        // vertical geometry free (no pitch raster), while each resulting x time is
        // independently snapped to the grid.
        const cuts = new Map();
        for (const lane of editLanes()) {
          if (!canEditLane(lane)) continue;
          for (const note of lane.notes) {
            const cy = yOf(note.pitch) + S.state.rowH / 2;
            const x = lineXAtRow(line, cy, S.state.rowH);
            if (x == null) continue;
            const at = snap(timeAt(x));
            if (at > note.start && at < note.end) cuts.set(note, at);
          }
        }
        const split = sliceNoteCuts(cuts);
        if (!split.length) toast("Slice did not cross any notes with a full grid cell on each side");
      }
    } else if (S.drag.mode === "marquee") {
      const lane = activeLane();
      // A hidden / locked lane is disabled — don't marquee-select into it.
      if (canEditLane(lane)) {
        const x0 = Math.min(S.marquee.x0, S.marquee.x1), x1 = Math.max(S.marquee.x0, S.marquee.x1);
        const p1 = pitchAt(Math.min(S.marquee.y0, S.marquee.y1));
        const p0 = pitchAt(Math.max(S.marquee.y0, S.marquee.y1));
        const next = new Set();   // a new marquee replaces the previous selection
        for (const n of lane.notes) {
          if (xOf(n.end) >= x0 && xOf(n.start) <= x1 && n.pitch >= p0 && n.pitch <= p1) next.add(n);
        }
        setSelection(next);
      }
    } else if (S.drag.mode === "region") {
      let { t0, t1 } = S.detectRegion;
      if (t1 < t0) [t0, t1] = [t1, t0];
      // A too-narrow band (e.g. an Alt-click) just clears the frame.
      if (t1 - t0 < MIN_REGION) { S.detectRegion = null; }
      else S.detectRegion = { t0, t1: Math.min(t1, S.state.duration) };
      updateDetectStatus();
      // A real Frame drag opens the Detect popover prescoped to the band, so the
      // detector can run on just that range. (A click that cleared it does not.)
      if (S.detectRegion) openDetectPanel(e.clientX, e.clientY);
    } else if (S.drag.mode === "move" || S.drag.mode === "resize") {
      // The moved/resized notes stay selected. Enforce full grid placement on the
      // final position so neither edge is left straddling a gridline (move already
      // snapped live; this is what pulls a resize's untouched edge on too). Then
      // record the change for undo (overlaps are kept and flagged as stacks, never
      // merged).
      for (const n of S.drag.notes) { const q = snapNote(n.start, n.end); n.start = q.start; n.end = q.end; }
      updateNoteGesture(S.state, S.drag.lane || laneOf(S.drag.note), S.drag.notes);
      commitIfChanged();
    } else if (S.drag.mode === "bendPoint") {
      commitIfChanged();
    } else if (S.drag.mode === "refBox") {
      // Box resized: mirror its new contents to the siblings (the dragged box is the
      // source), and record box + notes for undo — only if anything actually changed.
      commitIfChanged({ ref: S.drag.ref, i: S.drag.i });
    } else if (S.drag.mode === "refDrag") {
      // Occurrence relocated: box + its notes moved by one delta, so the box contents
      // relative to the anchor are unchanged → no mirror fires. Record for undo only
      // if it actually moved (a plain click already did the select on mousedown).
      commitIfChanged();
    }
    } catch (err) {
      console.error("drag release failed:", err);
      toast(`${S.drag.mode} failed: ${err.message}`, 2200, "error");
    }
    finishNoteGesture(S.state, S.drag);
    S.marquee = null; S.drag = null; stopAutoScroll();
    stage.style.cursor = sliceHeld || S.toolMode === "trace" ? "crosshair" : "default";
    draw();
  });
}
