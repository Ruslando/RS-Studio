import { PX_PER_SEC, STAGE_HEIGHT_DEFAULT } from "./constants.js";

// Shared mutable editor state. Centralized because the feature modules split out
// of the original app.js need to READ and REASSIGN these across module
// boundaries, and ES-module imports are read-only bindings — so cross-module
// mutable state must hang off a singleton object like this. Access is always
// `S.<name>`.
//
// The rule, stated accurately: a field belongs here if more than one module
// READS it. Most are also written from more than one place; a good number are
// written by exactly one owner and read all over (`S.matches` by tracing.js,
// `S.drag` by interaction.js, `S.state` by project.js), and those belong here
// too — a plain `let` in the owning module could not be read from outside.
//
// What does NOT belong here is state only its owner touches at all. That is the
// line worth defending, because this file teaches the convention: a contributor
// who reads "everything shared lives in S" and adds a private timer is following
// the comment, not breaking it. Timer handles are the usual temptation.
export const S = {
  stageHeight: STAGE_HEIGHT_DEFAULT,  // live viewport height; also the pitch-range height at 100% zoom
  // ---- zoom ----
  // Two independent zoom factors multiply the base scales: zoomX stretches the time
  // axis (px/s = PX_PER_SEC * zoomX), zoomY the pitch axis (rowH = baseRowH * zoomY).
  // Both default to 1, where the whole pitch range fits in the visible stage exactly and
  // nothing scrolls vertically — identical to the pre-zoom layout. Kept in module
  // scope (not persisted) so opening a project / switching stems starts at 100%.
  zoomX: 1,
  zoomY: 1,
  pxPerSec: PX_PER_SEC,  // = PX_PER_SEC * zoomX, kept in sync by setZoomX()
  state: null,
  spectImg: null,
  spectPixels: null,
  mouseX: null,  // canvas x of the hover cursor line (FL-style)
  mouseY: null,
  selection: new Set(),
  clipboard: [],
  clipboardRef: null,  // source reference group of the copied notes (for Paste as reference)
  clipboardSrc: [],  // the live source note objects copied (so they can become instance 1)
  drag: null,
  marquee: null,
  detectRegion: null,  // { t0, t1 } Alt-dragged time frame that scopes Detect (null = whole stem)
  hoverNote: null,
  rulerHover: null,  // pitch under the cursor on the pitch ruler (click to audition)
  pitchHoverClientY: null, // viewport coordinate; stays correct across pitch zoom/scroll
  matches: [],  // similar-passage suggestions: [{ score, dt, t0, t1, pTop, pBot, notes }]
  matchHover: -1,  // index of the suggestion under the cursor (-1 = none)
  matchFocus: -1,  // keyboard/button-focused suggestion (-1 = none)
  refBadges: [],  // clickable reference number badges: [{ x, y, w, h, notes }] (world px)
  refBoxRects: [],  // reference capture boxes for edge-resize: [{ ref, notes, x0, y0, x1, y1 }] (world px)
  hoverPreviewTimer: 0,  // delayed hover audition so pointer jitter doesn't restart audio
  lastPointerX: 0,
  lastPointerY: 0,  // client coords of the cursor during a drag
  autoScrollRaf: 0,  // rAF id for edge auto-scroll while dragging
  autoScrollVel: 0,  // px/frame; sign = direction, 0 = idle
  mmDragging: false,  // dragging within the overview minimap to navigate
  mmSeeking: false,  // dragging the playhead pin in the overview headroom to scrub
  // Active spectrogram tool. The toolbar defaults this to Select; modifier keys
  // (Ctrl/Shift/Alt) still force their gesture regardless.
  //   select  → click/move notes, drag = marquee   (default)
  //   trace   → drag draws notes along the spectrogram
  //   marquee → drag box-selects notes             (= Shift-drag)
  //   frame   → drag a time range → detect popover (= Alt-drag)
  toolMode: "select",
  sliceHeld: false,  // temporary FL-style Slice gesture while the S key is held
  heatPreview: false,
  heatPreviewTimer: 0,
  taps: [],
  undoStack: [],
  redoStack: [],
  // Bumped by every note edit/restore. The preview voicing cache uses this to
  // avoid re-running the full passage optimizer until musical data changes.
  voicingRevision: 0,
  metro: null,  // Tone synth for the metronome click
  // Playback clock anchor: song position ≈ anchorSong + (ctxNow - anchorCtx) *
  // playbackRate. Armed on play/seek/rate-change and servo-corrected while
  // playing by updateClock() in playback.js — see the clock notes there.
  anchorCtx: 0,
  anchorSong: 0,
  toneReady: false,
  mediaNode: null,  // backing <audio> routed into the Web Audio graph
  // The score-only transport: the same clock, without an <audio> element to read
  // a position from. A project with no stems has nothing to seek, so playback
  // runs off performance.now() against an anchor pair mirroring the two above —
  // scoreAnchorSong is the song position when the clock was armed,
  // scoreAnchorClock the wall time at that moment, and everything else derives.
  // Reset on project open/close (project.js) and armed on play/seek (playback.js).
  scorePlaying: false,
  scoreTime: 0,          // last known song position; where play resumes from
  scoreAnchorSong: 0,
  scoreAnchorClock: 0,
  uid: 1,
  // The offset the edit-lane notes are currently aligned to. Changing the offset
  // slides authored notes by the delta so notes snapped to the old grid stay on the
  // new one (see the offsetInput "change" handler). Re-baselined on project load and
  // rolled back through undo so it never drifts from the placed notes.
  appliedOffset: 0,
  appliedGrid: null,
  passagePreviewTimer: 0,
  passagePreviewActive: false,
};

// The one writer of S.selection that other modules need. A plain assignment, but
// exported so a module can change the selection without importing the mouse
// handler it happened to live in.
export function setSelection(next) {
  S.selection = next;
}
