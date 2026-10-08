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

let queued = 0;
let painter = null;

// draw.js calls this once, from init_draw().
export function setPainter(fn) {
  painter = fn;
}

export function draw() {
  if (!queued) queued = requestAnimationFrame(drawNow);
}

export function drawNow() {
  if (queued) { cancelAnimationFrame(queued); queued = 0; }
  painter?.();
}
