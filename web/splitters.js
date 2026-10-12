// The drag handles BETWEEN panels: one idiom for the sidebar's width, the fretboard's
// height, the overview's height and the sidebar's own Audio/Notes divide.
//
// A splitter is an element that occupies the gap between two panels (it IS the gap —
// the containers no longer set one), so the grab area is exactly the space between
// them and not a strip hung off one panel's edge. Its three dots follow the pointer
// along it (`--at`), because a grip that only shows half a panel away from where you
// are pointing reads as belonging to somewhere else.
//
// A drag that crosses a panel's collapse threshold changes state, and a state change
// animates like the chevron's does: snapPanels() lifts the "no transition while
// dragging" rule for one panel-motion's length.

import { $ } from "./dom.js";
import { layout } from "./geometry.js";
import { panelMotion } from "./panel-motion.js";
import { draw } from "./repaint.js";
import { S } from "./store.js";
import { clamp, rememberPref } from "./util.js";

// `start()` returns whatever `move(delta, ctx)` needs to measure from; delta is in
// px along the axis ("x": left-right, "y": up-down). `toggle` is a double-click.
export function splitter(el, { axis, start, move, end, toggle }) {
  if (!el) return;
  const x = axis === "x";
  const point = (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--at", (x ? e.clientY - r.top : e.clientX - r.left) + "px");
  };
  el.addEventListener("mousemove", point);
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = x ? e.clientX : e.clientY, ctx = start();
    const busy = x ? "col-resizing" : "row-resizing";
    document.body.classList.add(busy);
    el.classList.add("is-dragging");
    // Tracking lives on the window so a fast drag never loses the pointer.
    const onMove = (ev) => { point(ev); move((x ? ev.clientX : ev.clientY) - from, ctx); };
    const onUp = () => {
      document.body.classList.remove(busy);
      el.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      end?.(ctx);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  if (toggle) el.addEventListener("dblclick", toggle);
}

let snapping = 0;
export function snapPanels() {
  document.body.classList.add("panel-snapping");
  clearTimeout(snapping);
  snapping = setTimeout(() => document.body.classList.remove("panel-snapping"), panelMotion().duration);
}

// ---- the overview: time ruler + minimap, a panel of its own ----
// Dragged down it grows the minimap; dragged up past the threshold the minimap folds
// away and the time ruler alone is left, which is all a song you know needs.
const LS_H = "cw.overviewH", LS_C = "cw.overviewCollapsed";
const OV_MIN = 24, OV_MAX = 220, OV_COLLAPSE_AT = 14;

export function init_splitters() {
  const shell = $("appshell"), playbackPanel = $("playbackPanel");
  let height = clamp(parseInt(localStorage.getItem(LS_H), 10)
    || parseFloat(getComputedStyle(shell).getPropertyValue("--h-overview-mini")) || 32, OV_MIN, OV_MAX);
  let collapsed = localStorage.getItem(LS_C) === "1";
  const apply = () => {
    shell.style.setProperty("--h-overview-mini", height + "px");
    playbackPanel.toggleAttribute("data-collapsed", collapsed);
    // The minimap canvas is sized by layout(), which needs a project to measure.
    if (S.state) { layout(); draw(); }
  };
  const fold = (on) => {
    if (on === collapsed) return;
    collapsed = on; snapPanels(); apply();
  };
  apply();
  splitter($("timelineResize"), {
    axis: "y",
    start: () => (collapsed ? 0 : height),
    move: (dy, from) => {
      const raw = from + dy;
      if (raw < OV_COLLAPSE_AT) { fold(true); return; }
      height = clamp(Math.round(raw), OV_MIN, OV_MAX);
      if (collapsed) fold(false); else apply();
    },
    end: () => { rememberPref(LS_H, height); rememberPref(LS_C, collapsed ? "1" : "0"); },
    toggle: () => { fold(!collapsed); rememberPref(LS_C, collapsed ? "1" : "0"); },
  });
}
