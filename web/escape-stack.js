// What Escape closes, and in what order.
//
// This used to be ten hardcoded checks in edit.js's keydown handler, which meant
// edit.js imported six DOM handles and three close functions from ui.js purely
// to run them — one of the import cycles the front end was knotted by. It also
// meant adding an overlay required guessing where in the chain it belonged.
//
// Now each overlay registers itself, with a DEPTH. Escape closes the deepest
// thing that is currently open, one layer per press. Depth is "how recently was
// this put in front of the user", so:
//
//   100  popovers and menus     — the note menu
//    80  floating panels        — the detect popover
//    60  modal dialogs          — settings, tuning manager, layer/stem settings
//    40  full-view switches     — leaving the tablature view
//    20  transient canvas state — a similar-passage search result set
//     0  the selection          — last, because clearing it is least reversible
//
// Ties break in registration order, which is main.js's init order. Modals that
// own their own keydown listener (the merge prompt, the marker popovers) are not
// here at all — they capture Escape before the global handler sees it.
//
// A handler returns true if it closed something. Returning false lets Escape
// fall through to the next layer, which is what "nothing was open" means.

const layers = [];

export const ESC_DEPTH = {
  popover: 100,
  panel: 80,
  modal: 60,
  view: 40,
  transient: 20,
  selection: 0,
};

/**
 * @param {number} depth   one of ESC_DEPTH
 * @param {() => boolean} close  closes if open; returns whether it did
 */
export function registerEscapeLayer(depth, close) {
  layers.push({ depth, close, order: layers.length });
  layers.sort((a, b) => b.depth - a.depth || a.order - b.order);
}

// Returns true if a layer handled the press, so the caller knows to stop.
export function closeTopmost() {
  for (const layer of layers) if (layer.close()) return true;
  return false;
}
