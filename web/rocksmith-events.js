// What the Rocksmith export adds in front of the song, on a rail of its own:
// the COUNT phrase on the first beat and the count-in clicks in the measure
// before the song (B0 on beat 1, B1 on the rest; chart.py _count_in). Read-only:
// the export makes them, the live check (rocksmith-check.js) reports where.
// Its crowd events are on the crowd rail, where they can be moved (crowd-events.js).
import { paintLock, paintMarkerFlag } from "./canvas-components.js";
import { stageUi } from "./constants.js";
import { mmctx as minimapCtx, scroll, sctx } from "./dom.js";
import { xOf } from "./geometry.js";
import { inRailBand, railBand, registerMarkerRail } from "./marker-rails.js";
import { rocksmithCountIn } from "./rocksmith-check.js";
import { PAINT } from "./stage-paint.js";
import { RS_EVENT_NAMES, isCrowdEvent } from "./section-marker-core.js";
import { S } from "./store.js";

const RAIL_H = 22;
let rects = [];
const hitAt = (x, y) => (inRailBand("rocksmith", y - scroll.scrollTop)
  && rects.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) || null;

// Only what the view can show: before the shown silence there is no x.
export function rocksmithEventItems() { return items(); }

function items() {
  if (!S.state) return [];
  const found = rocksmithCountIn(S.state.editLanes?.find((lane) => lane.active));
  if (!found) return [];
  // The clicks are counted as a drummer counts in: B0 is 1, each B1 the next number.
  let beat = 0;
  const added = found.events.filter((item) => !isCrowdEvent(item.code)).map((item) => {
    if (item.code !== "B0" && item.code !== "B1") return item;
    beat = item.code === "B0" ? 1 : beat + 1;
    return { ...item, beat, name: `Count-in ${beat}` };
  });
  const all = [...(Number.isFinite(found.count) ? [{ t: found.count, code: "COUNT" }] : []), ...added];
  return all.filter((item) => item.t >= -S.leadView - 1e-6);
}

function drawRocksmithEvents() {
  rects = [];
  const list = items();
  if (!list.length) return;
  const top = scroll.scrollTop + railBand("rocksmith").y;
  const left = scroll.scrollLeft, right = left + scroll.clientWidth;
  sctx.save();
  sctx.font = stageUi(11, 600);
  sctx.textBaseline = "middle";
  list.forEach((item, i) => {
    const x = xOf(item.t);
    // Labelled by name, not by code; a click by its count, which fits any zoom.
    // A flag is no wider than the room to the next one, so the clicks of a fast
    // measure stay apart.
    const text = item.beat ? String(item.beat) : RS_EVENT_NAMES.get(item.code) || item.code;
    const room = i + 1 < list.length ? xOf(list[i + 1].t) - x - 2 : Infinity;
    // The export sets these, so each carries a lock: it cannot be moved.
    const width = Math.max(6, Math.min(room, Math.ceil(sctx.measureText(text).width) + 28));
    const rect = { item, x0: x, x1: x + width, y0: top + 2, y1: top + RAIL_H - 2 };
    rects.push(rect);
    if (rect.x0 > right || rect.x1 < left) return;
    const color = item.code === "COUNT" ? PAINT.phrase : PAINT.marker;
    paintMarkerFlag(sctx, rect, color);
    // The name comes first: where both do not fit, the lock gives way.
    const textW = sctx.measureText(text).width, locked = width >= textW + 22;
    if (locked) paintLock(sctx, x + 6, top + RAIL_H / 2 - 4.5, PAINT.label);
    if (width >= textW + 12) {
      sctx.fillStyle = PAINT.text;
      sctx.fillText(text, x + (locked ? 17 : 9), top + RAIL_H / 2);
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
    cursorAt: (x, y) => (hitAt(x, y) ? "default" : null),
    tipAt: (x, y) => {
      const hit = hitAt(x, y);
      return hit && { title: RS_EVENT_NAMES.get(hit.item.code) || hit.item.name || hit.item.code,
        body: "Set by the export. It can't be moved." };
    },
    drawMinimap: drawMinimapRocksmithEvents,
  });
}
