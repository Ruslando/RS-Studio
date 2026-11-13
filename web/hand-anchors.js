// Hand anchors on the marker rail: a flag with the fret, where the player put
// the hand. Display only; hands are chosen in the fretboard's fret-number row.
// ponytail: no drag, popup or unreachable warning (the old rail had them); bring
// them back if anchors need editing from the timeline.
import { scroll, sctx, mmctx as minimapCtx } from './dom.js';
import { S } from './store.js';
import { stageMono } from './constants.js';
import { activeLane } from './lanes.js';
import { xOf } from './geometry.js';
import { registerMarkerRail, railBand } from './marker-rails.js';
import { paintMarkerFlag } from './canvas-components.js';
import { PAINT } from './stage-paint.js';

const RAIL = 'hand-anchor', HEIGHT = 20;
const shownLane = () => { const lane = S.state ? activeLane() : null; return lane?.visible ? lane : null; };

// Only where the hand moves: an anchor on the same fret as the one before it
// changes nothing to see.
const changes = holds => (holds || []).filter((hold, i, all) => !i || Math.round(hold.fret) !== Math.round(all[i - 1].fret));

function drawAnchors() {
  const lane = shownLane();
  if (!lane) return;
  const top = scroll.scrollTop + railBand(RAIL).y;
  sctx.save(); sctx.font = stageMono(11, 500); sctx.textAlign = 'left'; sctx.textBaseline = 'middle';
  for (const anchor of changes(lane.handHolds)) {
    const label = String(Math.round(anchor.fret)), x = xOf(anchor.t);
    const width = Math.ceil(sctx.measureText(label).width) + 14;
    if (x > scroll.scrollLeft + scroll.clientWidth || x + width < scroll.scrollLeft) continue;
    paintMarkerFlag(sctx, { x0: x, x1: x + width, y0: top + 2, y1: top + HEIGHT - 2 }, lane.color || PAINT.accent);
    sctx.fillStyle = PAINT.text; sctx.fillText(label, x + 7, top + HEIGHT / 2);
  }
  sctx.restore();
}

export function init_hand_anchors() {
  registerMarkerRail({
    id: RAIL, height: HEIGHT, count: () => shownLane()?.handHolds?.length || 0,
    draw: drawAnchors,
    drawMinimap: (at, mmctx = minimapCtx) => {
      const lane = shownLane();
      for (const anchor of changes(lane?.handHolds)) {
        mmctx.fillStyle = lane.color || PAINT.accent; mmctx.fillRect(at(anchor.t) - 1, 36, 3, 5);
      }
    },
  });
}
