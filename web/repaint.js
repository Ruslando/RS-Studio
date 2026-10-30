// "Repaint the canvas" — separated from the thing that actually paints it.
//
// Fifteen modules need to ask for a repaint after they change something. Only
// one of them, draw.js, has any business knowing how a frame is composed, and
// draw.js in turn imports every renderer to compose it. Those two facts together
// were the main reason the front end had a sixteen-module import knot: everybody
// pointed at draw.js and draw.js pointed back at everybody.
//
// So the request lives here, in a module that imports nothing, and draw.js
// installs the painter at boot. Nobody outside draw.js needs to import draw.js
// any more.
//
// draw() coalesces: any number of requests inside one frame produce a single
// paint on the next animation frame. Interaction handlers (wheel-zoom fires two
// per event, drags, hover) all funnel through it, so a wheel storm cannot
// saturate the main thread with back-to-back full repaints. drawNow() is for the
// two callers that must paint synchronously — the playback loop, which already
// runs once per frame, and the resize observer, which has to repaint before the
// browser can present a cleared backing store as a black frame.

import { withMemo } from "./paint-memo.js";

let queued = 0;
let painter = null;
// Something asked for a paint since the last one. A playback frame that nobody
// asked for only moves the playhead, so the side panels (which follow it only
// for their next/previous buttons) refresh four times a second instead of sixty.
let requested = true, panelsAt = 0;
const PANEL_MS = 250;
// A paint the playback loop runs: it paints the next frame anyway, so an
// animation asking for one from inside it would only paint the frame twice.
let loopPaint = false;

// draw.js calls this once, from init_draw().
export function setPainter(fn) {
  painter = fn;
}

export function draw() {
  if (loopPaint) return;
  requested = true;
  if (!queued) queued = requestAnimationFrame(() => drawNow());
}

// `playhead`: only the playback clock moved (the playback loop).
export function drawNow({ playhead = false } = {}) {
  if (queued) { cancelAnimationFrame(queued); queued = 0; }
  const now = performance.now();
  const panels = requested || !playhead || now - panelsAt >= PANEL_MS;
  if (panels) panelsAt = now;
  requested = false;
  loopPaint = playhead;
  try { withMemo(() => painter?.({ panels })); } finally { loopPaint = false; }
}

