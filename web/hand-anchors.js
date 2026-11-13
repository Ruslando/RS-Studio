// Hand anchors on the marker rail: a flag with the fret wherever the hand moves,
// chosen by hand or by the automatic fingering (the seats the fretboard and the
// Rocksmith export use). Display only; hands are chosen in the fretboard's fret-number row.
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
import { laneFingering, laneFingeringKey } from './lane-fingering.js';
import { draw } from './repaint.js';
import { seatChanges } from './hand-anchor-core.js';

const RAIL = 'hand-anchor', HEIGHT = 20;
const shownLane = () => { const lane = S.state ? activeLane() : null; return lane?.visible ? lane : null; };

// The fingering is voiced off the main thread; show the last answer until the next arrives.
const cache = new WeakMap();
function changesOf(lane) {
  if (!lane) return [];
  const key = `${laneFingeringKey(lane)}:f${S.fingerRevision || 0}`;
  let entry = cache.get(lane);
  if (entry?.key !== key) {
    entry?.controller.abort();
    entry = { key, controller: new AbortController(), changes: entry?.changes || [] };
    cache.set(lane, entry);
    laneFingering(lane, entry.controller.signal).then(({ notes, seats }) => {
      if (cache.get(lane) !== entry) return;
      entry.changes = seatChanges(notes, seats); draw();
    }).catch(() => {});
  }
  return entry.changes;
}

function drawAnchors() {
  const lane = shownLane();
  if (!lane) return;
  const top = scroll.scrollTop + railBand(RAIL).y;
  sctx.save(); sctx.font = stageMono(11, 500); sctx.textAlign = 'left'; sctx.textBaseline = 'middle';
  for (const anchor of changesOf(lane)) {
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
    id: RAIL, height: HEIGHT, count: () => changesOf(shownLane()).length,
    draw: drawAnchors,
    drawMinimap: (at, mmctx = minimapCtx) => {
      const lane = shownLane();
      for (const anchor of changesOf(lane)) {
        mmctx.fillStyle = lane.color || PAINT.accent; mmctx.fillRect(at(anchor.t) - 1, 36, 3, 5);
      }
    },
  });
}
