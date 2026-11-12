// One shared context-menu surface for note commands, diagnostics and artifacts.
// Entries carry their actions; this view never imports the command controller.
import { inTourCard } from "./dom.js";
import { icon } from "./icons.js";
import { placeFloating } from "./floating-position.js";
import { wireContextSubmenu } from "./context-submenu.js";

export let noteMenuEl = null;
let walkthroughMenuAction = null;
let menuOpenCount = 0;
export const walkthroughMenuOpenCount = () => menuOpenCount;

export function restrictContextMenuTo(action = null) {
  walkthroughMenuAction = action;
  hideNoteMenu();
}

export function hideNoteMenu({ scroll = false } = {}) {
  if (scroll && noteMenuEl?.dataset.origin === "artifact") return;
  if (noteMenuEl) noteMenuEl.hidden = true;
}

// Lazily create the shared context-menu element (reused by the note menu and the
// empty-canvas menu) and wire its outside-click dismissal once.
export function ensureCtxMenu() {
  if (!noteMenuEl) {
    noteMenuEl = document.createElement("div");
    noteMenuEl.className = "ctxmenu";
    document.body.appendChild(noteMenuEl);
    document.addEventListener("mousedown", (ev) => {
      if (inTourCard(ev.target)) return;
      if (noteMenuEl && !noteMenuEl.hidden && !noteMenuEl.contains(ev.target)) hideNoteMenu();
    });
    // ↑ ↓ walk the items of the menu (or submenu) holding focus; from outside it
    // they enter the root menu. → ← open and close submenus (context-submenu.js).
    // Capture, so the editor's own arrow keys never see these.
    window.addEventListener("keydown", (ev) => {
      if (noteMenuEl.hidden || !["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key)) return;
      const t = document.activeElement, inMenu = noteMenuEl.contains(t);
      if (t?.tagName === "INPUT" && (ev.key === "Home" || ev.key === "End")) return;
      if (t?.classList.contains("ctxmenu-search") && !noteMenuEl.querySelector(".ctxmenu-results").hidden) return;   // the search walks its results
      if (!inMenu && ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      const menu = inMenu ? t.closest(".ctxmenu") : noteMenuEl;
      const items = [...menu.querySelectorAll("button.ctxmenu-item")]
        .filter((b) => b.closest(".ctxmenu") === menu && !b.disabled && !b.closest("[hidden]"));
      if (!items.length) return;
      const i = items.indexOf(t), n = items.length;
      const next = ev.key === "Home" ? 0 : ev.key === "End" ? n - 1
        : ev.key === "ArrowDown" ? (i + 1) % n : i < 0 ? n - 1 : (i - 1 + n) % n;
      ev.preventDefault(); ev.stopPropagation();
      items[next].focus();
    }, true);
  }
  noteMenuEl.dataset.origin = "editor";
  return noteMenuEl;
}

export function placeCtxMenu(m, clientX, clientY) {
  m.hidden = false;
  // Open submenus to the left when the menu sits in the right half of the view.
  m.classList.toggle("ctxmenu-left", clientX > window.innerWidth / 2);
  placeFloating(m, clientX, clientY, 0);
}


export function recordMenuOpen() { menuOpenCount++; }

// An entry whose label starts with "✓ " is on: the row shows the label and the
// check as the menu's own mark on the right, not as a character in the text. A
// `note` (how Rocksmith takes the effect) follows the label in small grey type.
export function labelItem(button, label, note) {
  const on = label.startsWith("✓ ");
  button.textContent = on ? label.slice(2) : label;
  if (note) button.insertAdjacentHTML("beforeend", `<span class="ctxmenu-note">${note}</span>`);
  if (on) button.insertAdjacentHTML("beforeend", `<span class="chkmark">${icon("check", 14)}</span>`);
}

// Render menu entries into `parent`, recursing for hover submenus.
export function buildMenu(parent, entries) {
  for (const e of entries) {
    if (e.sep) {
      const d = document.createElement("div"); d.className = "ctxmenu-sep"; parent.append(d);
    } else if (e.header) {
      const d = document.createElement("div"); d.className = "ctxmenu-label"; d.textContent = e.label; parent.append(d);
    } else if (e.children) {
      const wrap = document.createElement("div"); wrap.className = "ctxmenu-sub";
      if (e.family) wrap.classList.add("ctxmenu-family");
      const row = document.createElement("button"); row.type = "button"; row.className = "ctxmenu-item ctxmenu-parent"; labelItem(row, e.label, e.note);
      if (e.tip) row.dataset.tip = e.tip;
      const child = document.createElement("div"); child.className = "ctxmenu ctxmenu-child";
      buildMenu(child, e.children);
      wrap.append(row, child); parent.append(wrap);
      wireContextSubmenu(wrap, row, child);
    } else {
      const b = document.createElement("button"); b.className = "ctxmenu-item"; b.disabled = !!e.disabled; labelItem(b, e.label, e.note);
      if (e.tip) b.dataset.tip = e.tip;
      b.onclick = () => { e.fn(); if (!e.keepOpen) hideNoteMenu(); };
      parent.append(b);
    }
  }
}

// A menu item is `label`, or the submenu row that leads to it.
export function menuItemLeadsTo(item, label) {
  if (!item) return false;
  const inside = item.classList.contains("ctxmenu-parent") ? [...item.nextElementSibling.querySelectorAll(".ctxmenu-item")] : [];
  return [item, ...inside].some((b) => b.textContent.replace(/^[✓✕]\s*/, "").startsWith(label));
}

export function markWalkthroughMenu(menu) {
  const action = walkthroughMenuAction;
  if (!action) return;
  for (const button of menu.querySelectorAll("button.ctxmenu-item")) {
    const wanted = action === "noteEffects"
      ? !!button.closest(".ctxmenu-family, .ctxmenu-results") || button.textContent.startsWith("✕ ")
      : menuItemLeadsTo(button, action);
    button.disabled = !wanted;
    button.classList.toggle("tour-menu-target", wanted);
  }
  for (const row of menu.querySelectorAll(".ctxmenu-family > .ctxmenu-parent"))
    row.classList.toggle("tour-menu-target", action === "noteEffects");
  const search = menu.querySelector(".ctxmenu-search");
  if (search) search.disabled = action !== "noteEffects";
}

export function openDiagnosticMenu(x, y, entries) {
  const menu = ensureCtxMenu(); menu.innerHTML = '';
  buildMenu(menu, entries); placeCtxMenu(menu, x, y);
}
