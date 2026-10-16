// Right-hand counterpart of the layer sidebar. Uses the same controls, splitter,
// collapse threshold, peek strip and saved geometry as the other editor panels.
import { panelControls, syncPanelControls } from "./canvas-controls.js";
import { $ } from "./dom.js";
import { snapPanels, splitter } from "./splitters.js";
import { clamp, rememberPref } from "./util.js";

const LS_W = "cw.artifactsW", LS_C = "cw.artifactsCollapsed";
const MIN = 220, MAX = 480, DEFAULT = 300, COLLAPSE_AT = 150;

export function initArtifactsPanel() {
  const panel = $("artifactsPanel"), content = $("artifactsContent");
  const maxWidth = () => Math.max(MIN, Math.min(MAX,
    $("mainArea").clientWidth - $("sidebar").getBoundingClientRect().width
      - $("sidebarResize").offsetWidth - $("artifactsResize").offsetWidth - 320));
  const setWidth = width => panel.style.setProperty("--artifacts-w", clamp(width, MIN, maxWidth()) + "px");
  // At boot the project shell is hidden and has no measured width yet.
  panel.style.setProperty("--artifacts-w",
    clamp(parseInt(localStorage.getItem(LS_W), 10) || DEFAULT, MIN, MAX) + "px");
  panel.toggleAttribute("data-collapsed", localStorage.getItem(LS_C) === "1");

  const sync = () => {
    const expanded = !panel.hasAttribute("data-collapsed");
    if (expanded) panel.classList.remove("is-peeking");
    content.inert = !expanded;
    syncPanelControls("artifacts", expanded, `${expanded ? "Hide" : "Show"} artifacts`);
  };
  const fold = (collapsed, snapping = false) => {
    if (panel.hasAttribute("data-collapsed") === collapsed) return;
    if (snapping) snapPanels();
    panel.toggleAttribute("data-collapsed", collapsed);
    sync();
  };
  const remember = () => rememberPref(LS_C, panel.hasAttribute("data-collapsed") ? "1" : "0");
  const toggle = () => { fold(!panel.hasAttribute("data-collapsed")); remember(); };
  sync();
  for (const button of panelControls("artifacts")) button.addEventListener("click", toggle);
  panel.addEventListener("mouseenter", () => {
    if (panel.hasAttribute("data-collapsed")) panel.classList.add("is-peeking");
  });
  panel.addEventListener("mouseleave", () => panel.classList.remove("is-peeking"));
  panel.addEventListener("click", event => {
    if (!panel.hasAttribute("data-collapsed") || event.target.closest('[data-panel-toggle="artifacts"]')) return;
    fold(false); remember();
  });
  splitter($("artifactsResize"), {
    axis: "x",
    start: () => panel.getBoundingClientRect().width,
    move: (dx, width) => {
      // Pulling the right panel's left edge left makes it wider.
      const raw = width - dx;
      if (raw < COLLAPSE_AT) { fold(true, true); return; }
      fold(false, true); setWidth(raw);
    },
    end: () => {
      remember();
      if (!panel.hasAttribute("data-collapsed"))
        rememberPref(LS_W, parseFloat(panel.style.getPropertyValue("--artifacts-w")));
    },
    toggle,
  });
  window.addEventListener("resize", () => {
    if ($("mainArea").clientWidth > 0) setWidth(parseFloat(panel.style.getPropertyValue("--artifacts-w")));
  });
}
