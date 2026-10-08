import { panelControls, syncPanelControls } from "./canvas-controls.js";
// The sidebar's own geometry: width resize and collapse, the per-section
// collapse chevrons, and the Stems/Layers drag separator. All three persist to
// localStorage and restore on load.
//
// It was an 80-line anonymous `{}` block wedged between the `mouseleave` and
// `wheel` handlers of interaction.js's 441-line init, sharing nothing with them
// but the file. Nothing about it is pointer interaction with the spectrogram,
// which is what that module is for.
//
// It imports two leaves and is imported by nobody, so it stays outside the
// module cycle — which is why it did not go to ui.js, the other obvious home.

import { $ } from "./dom.js";
import { clamp, rememberPref } from "./util.js";

const LS_C = "cw.sidebarCollapsed", LS_H = "cw.stemH", LS_W = "cw.sidebarW";
const SIDE_MIN = 220, SIDE_MAX = 480, SIDE_DEFAULT = 300, SIDE_COLLAPSE_AT = 150;
const STEM_MIN = 80, STEM_MAX = 520, STEM_DEFAULT = 272;

export function init_sidebar() {
  const shell = $("appshell");
  const sidebar = $("sidebar"), sideResize = $("sidebarResize");
  const stemsSec = $("stemsSection"), sep = $("sepDrag");

  if (sidebar) {
    const w = clamp(parseInt(localStorage.getItem(LS_W), 10) || SIDE_DEFAULT, SIDE_MIN, SIDE_MAX);
    sidebar.style.setProperty("--sidebar-w", w + "px");
  }
  if (stemsSec) {
    const h = clamp(parseInt(localStorage.getItem(LS_H), 10) || STEM_DEFAULT, STEM_MIN, STEM_MAX);
    stemsSec.style.height = h + "px";
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

  // The right edge resizes the whole sidebar, and collapses it when dragged
  // below the threshold.
  if (sideResize && sidebar) sideResize.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startW = sidebar.getBoundingClientRect().width;
    document.body.classList.add("col-resizing");
    const onMove = (ev) => {
      const max = Math.max(SIDE_MIN, Math.min(SIDE_MAX, window.innerWidth - 420));
      const rawW = startW + (ev.clientX - startX);
      if (rawW < SIDE_COLLAPSE_AT) {
        shell.classList.add("side-collapsed");
        syncSidebarToggle();
        return;
      }
      shell.classList.remove("side-collapsed");
      syncSidebarToggle();
      const w = clamp(rawW, SIDE_MIN, max);
      sidebar.style.setProperty("--sidebar-w", w + "px");
    };
    const onUp = () => {
      document.body.classList.remove("col-resizing");
      const collapsed = shell.classList.contains("side-collapsed");
      rememberPref(LS_C, collapsed ? "1" : "0");
      syncSidebarToggle();
      if (!collapsed) {
        const w = Math.round(sidebar.getBoundingClientRect().width);
        rememberPref(LS_W, clamp(w, SIDE_MIN, SIDE_MAX));
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // Clicking a section label collapses / expands just that section's item list.
  document.querySelectorAll(".side-label[data-sec]").forEach((label) => {
    label.addEventListener("click", () => {
      const sec = label.closest(".side-section");
      const open = !sec.classList.toggle("collapsed");
      label.setAttribute("aria-expanded", String(open));
    });
  });

  // Drag separator: stems height = clamp(80, startH + dy, 520); Layers fills the rest.
  // Tracking lives on the window so a fast drag never loses the pointer.
  if (sep && stemsSec) sep.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY, startH = stemsSec.offsetHeight;
    document.body.classList.add("row-resizing");
    const onMove = (ev) => {
      stemsSec.style.height = clamp(startH + (ev.clientY - startY), STEM_MIN, STEM_MAX) + "px";
    };
    const onUp = () => {
      document.body.classList.remove("row-resizing");
      rememberPref(LS_H, parseInt(stemsSec.style.height, 10) || STEM_DEFAULT);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}
