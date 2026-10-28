// What the Rocksmith export adds in front of the song, on a rail of its own:
// the COUNT phrase on the first beat and the count-in ticks in the measure
// before the song (B0 high, B1 low; chart.py _count_in). Read-only: the export
// makes them, the live check (rocksmith-check.js) reports where. They sit in
// the leading silence, so the rail shows once that is shown (lead-view.js).
import { paintMarkerFlag } from "./canvas-components.js";
import { stageUi } from "./constants.js";
import { mmctx as minimapCtx, scroll, sctx } from "./dom.js";
import { xOf } from "./geometry.js";
import { railBand, registerMarkerRail } from "./marker-rails.js";
import { rocksmithCountIn } from "./rocksmith-check.js";
import { PAINT } from "./stage-paint.js";
import { S } from "./store.js";

const RAIL_H = 22;

// Only what the view can show: before the shown silence there is no x.
export function rocksmithEventItems() { return items(); }

function items() {
  if (!S.state) return [];
  const found = rocksmithCountIn(S.state.editLanes?.find((lane) => lane.active));
  if (!found) return [];
  const all = [...(Number.isFinite(found.count) ? [{ t: found.count, code: "COUNT" }] : []), ...found.events];
  return all.filter((item) => item.t >= -S.leadView - 1e-6);
}

function drawRocksmithEvents() {
  const list = items();
  if (!list.length) return;
  const top = scroll.scrollTop + railBand("rocksmith").y;
  const left = scroll.scrollLeft, right = left + scroll.clientWidth;
  sctx.save();
  sctx.font = stageUi(11, 600);
  sctx.textBaseline = "middle";
  list.forEach((item, i) => {
    const x = xOf(item.t);
    // Labelled by code, as EOF and the SNG name them. A flag is no wider than
    // the room to the next one, so the ticks of a fast measure stay apart.
    const text = item.code;
    const room = i + 1 < list.length ? xOf(list[i + 1].t) - x - 2 : Infinity;
    const width = Math.max(6, Math.min(room, Math.ceil(sctx.measureText(text).width) + 18));
    const rect = { x0: x, x1: x + width, y0: top + 2, y1: top + RAIL_H - 2 };
    if (rect.x0 > right || rect.x1 < left) return;
    paintMarkerFlag(sctx, rect, item.code === "COUNT" ? PAINT.phrase : PAINT.marker);
    if (width >= sctx.measureText(text).width + 12) {
      sctx.fillStyle = PAINT.text;
      sctx.fillText(text, x + 9, top + RAIL_H / 2);
    }
  });
  sctx.restore();
}

function drawMinimapRocksmithEvents(at, mmctx = minimapCtx) {
  for (const item of items()) {
    mmctx.fillStyle = item.code === "COUNT" ? PAINT.phrase : PAINT.marker;
    mmctx.fillRect(at(item.t) - 1, item.code === "B1" ? 45 : 43, 3, item.code === "B1" ? 3 : 5);
  }
}

export function initRocksmithEvents() {
  registerMarkerRail({
    id: "rocksmith",
    height: RAIL_H,
    count: () => items().length,
    draw: drawRocksmithEvents,
    drawMinimap: drawMinimapRocksmithEvents,
  });
}
