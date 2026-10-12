import { panelControls, syncPanelControls } from "./canvas-controls.js";
// The sidebar's own geometry: width resize and collapse, the per-section
// collapse chevrons, and the Audio/Notes divide. All three persist to
// localStorage and restore on load. The dragging itself is splitters.js.
//
// It was an 80-line anonymous `{}` block wedged between the `mouseleave` and
// `wheel` handlers of interaction.js's 441-line init, sharing nothing with them
// but the file. Nothing about it is pointer interaction with the spectrogram,
// which is what that module is for.
//
// It is imported by nobody, which is why it did not go to ui.js, the other
// obvious home.

import { $ } from "./dom.js";
import { snapPanels, splitter } from "./splitters.js";
import { clamp, rememberPref } from "./util.js";

const LS_C = "cw.sidebarCollapsed", LS_H = "cw.stemH", LS_W = "cw.sidebarW";
const SIDE_MIN = 220, SIDE_MAX = 480, SIDE_DEFAULT = 300, SIDE_COLLAPSE_AT = 150;
// The divide moves freely; all it keeps is room for the other section's header and
// a row, so neither list can be dragged over the other.
const STEM_MIN = 80, LAYERS_MIN = 96, STEM_DEFAULT = 272;

export function init_sidebar() {
  const shell = $("appshell");
  const sidebar = $("sidebar"), sideResize = $("sidebarResize");
  const stemsSec = $("stemsSection"), sep = $("sepDrag");

  if (sidebar) {
    const w = clamp(parseInt(localStorage.getItem(LS_W), 10) || SIDE_DEFAULT, SIDE_MIN, SIDE_MAX);
    sidebar.style.setProperty("--sidebar-w", w + "px");
  }
  if (stemsSec) {
    // No upper clamp here: the sidebar has no height yet. The stylesheet caps it.
    stemsSec.style.height = Math.max(STEM_MIN, parseInt(localStorage.getItem(LS_H), 10) || STEM_DEFAULT) + "px";
  }
  shell.classList.toggle("side-collapsed", localStorage.getItem(LS_C) === "1");

  const syncSidebarToggle = () => {
    const expanded = !shell.classList.contains("side-collapsed");
    if (expanded) sidebar.classList.remove("is-peeking");
    stemsSec.inert = !expanded;
    $("layersSection").inert = !expanded;
    syncPanelControls("sidebar", expanded, `${expanded ? "Hide" : "Show"} layer sidebar`);
  };
  syncSidebarToggle();
  sidebar.addEventListener("mouseenter", () => {
    if (shell.classList.contains("side-collapsed")) sidebar.classList.add("is-peeking");
  });
  sidebar.addEventListener("mouseleave", () => sidebar.classList.remove("is-peeking"));
  sidebar.addEventListener("click", (event) => {
    if (!shell.classList.contains("side-collapsed") || event.target.closest('[data-panel-toggle="sidebar"]')) return;
    shell.classList.remove("side-collapsed");
    rememberPref(LS_C, "0"); syncSidebarToggle();
  });
  for (const button of panelControls("sidebar")) button.addEventListener("click", () => {
    const collapsed = shell.classList.toggle("side-collapsed");
    rememberPref(LS_C, collapsed ? "1" : "0");
    syncSidebarToggle();
  });

  // The handle between the sidebar and the editor resizes the sidebar, collapses it
  // when dragged below the threshold and opens it again when dragged back out — both
  // with the chevron's own animation, which is what snapPanels is for.
  const setCollapsed = (on) => {
    if (shell.classList.contains("side-collapsed") === on) return;
    snapPanels();
    shell.classList.toggle("side-collapsed", on);
    syncSidebarToggle();
  };
  if (sidebar) splitter(sideResize, {
    axis: "x",
    start: () => sidebar.getBoundingClientRect().width,
    move: (dx, startW) => {
      const rawW = startW + dx;
      if (rawW < SIDE_COLLAPSE_AT) { setCollapsed(true); return; }
      setCollapsed(false);
      const max = Math.max(SIDE_MIN, Math.min(SIDE_MAX, window.innerWidth - 420));
      sidebar.style.setProperty("--sidebar-w", clamp(rawW, SIDE_MIN, max) + "px");
    },
    end: () => {
      const collapsed = shell.classList.contains("side-collapsed");
      rememberPref(LS_C, collapsed ? "1" : "0");
      if (!collapsed) rememberPref(LS_W, clamp(parseInt(sidebar.style.getPropertyValue("--sidebar-w"), 10) || SIDE_DEFAULT, SIDE_MIN, SIDE_MAX));
    },
    toggle: () => panelControls("sidebar")[0]?.click(),
  });

  // Clicking a section label collapses / expands just that section's item list.
  document.querySelectorAll(".side-label[data-sec]").forEach((label) => {
    label.addEventListener("click", () => {
      const sec = label.closest(".side-section");
      const open = !sec.classList.toggle("collapsed");
      label.setAttribute("aria-expanded", String(open));
    });
  });

  // The Audio/Notes divide. Audio takes the height it is dragged to and Notes fills
  // the rest, anywhere between the two minimums.
  if (stemsSec) splitter(sep, {
    axis: "y",
    start: () => stemsSec.offsetHeight,
    move: (dy, startH) => {
      const max = Math.max(STEM_MIN, sidebar.clientHeight - sep.offsetHeight - LAYERS_MIN);
      stemsSec.style.height = clamp(startH + dy, STEM_MIN, max) + "px";
    },
    end: () => rememberPref(LS_H, parseInt(stemsSec.style.height, 10) || STEM_DEFAULT),
  });
}
