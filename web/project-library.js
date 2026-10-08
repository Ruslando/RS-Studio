// The project library UI: the welcome/launcher screen shown whenever no project
// is open, and the File ▸ Open project… picker. Both browse the same library and
// share one row builder, so they live together — the picker is the launcher's
// list shown inside the editor.
//
// This module knows nothing about opening a project. "No project is open" is a
// state `project.js` owns; this is only the screen it shows for it. Everything
// that would point back — create a project, load a .chart, open a job — arrives as
// a callback through `initProjectLibrary`, so the import edge runs one way:
// project.js → here. That is what lets the launcher come out of the 1,900-line
// project module without the two of them importing each other.

import { confirmAction } from "./dialog.js";
import { $, appbar, openProjBackdrop, openProjClose, openProjList, openProjMenuBtn, recentCountEl, recentListEl, recentNextBtn, recentPageEl, recentPaginationEl, recentPrevBtn, recentSearchEl, welcome, welcomeNewBtn, welcomeOpenBtn, welcomeRecent, welcomeVersion } from "./dom.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { toast } from "./notify.js";
import { projectCardInfo } from "./project-card.js";
import { refreshRocksmithReadiness } from "./setup.js";
import { isAudioFile, isGuitarProFile } from "./util.js";

// Set by initProjectLibrary. See the module banner: these are the only way out.
let onNewProject = () => {};
let onOpenProjectFile = () => {};
let onPickProject = () => {};

// ---- the launcher ----
export function showWelcome() {
  appbar.hidden = true;
  welcome.hidden = false;
  setDropping(false);
  loadVersion();
  loadRecents();
  refreshRocksmithReadiness();
}

export function hideWelcome() {
  setDropping(false);
  welcome.hidden = true;
  appbar.hidden = false;
}

function setDropping(on) {
  if (welcome) welcome.classList.toggle("is-dropping", !!on);
}

let versionLoaded = false;
async function loadVersion() {
  if (!welcomeVersion || versionLoaded) return;
  versionLoaded = true;
  try {
    const data = await (await fetch("/api/version")).json();
    if (data.version) {
      welcomeVersion.textContent = `v${data.version}`;
      welcomeVersion.hidden = false;
    }
  } catch {
    versionLoaded = false;
    welcomeVersion.hidden = true;
  }
}

const EMPTY_FOLDER_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`;
const PROJECT_ART_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 10v4M10 7v10M14 9v6M18 5v14"/></svg>`;
const TRASH_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>`;

let recentItems = [];
let recentPage = 0;

function recentPageSize() {
  // Cap the library at three cards, without sizing from its own content-driven
  // height. Reserve the launcher chrome and paging row on short windows.
  const css = getComputedStyle(document.documentElement);
  const row = parseFloat(css.getPropertyValue('--h-list')) * 2 + parseFloat(css.getPropertyValue('--s-sibling'));
  const chrome = parseFloat(css.getPropertyValue('--h-chrome')) * 2 + parseFloat(css.getPropertyValue('--s-section')) * 4;
  return Math.min(3, Math.max(1, Math.floor((window.innerHeight - chrome) / (row + parseFloat(css.getPropertyValue('--s-sibling'))))));
}

function recentMatches(items, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((project) => {
    const info = projectCardInfo(project);
    return [info.title, info.context, info.utility, project.name, project.filename]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
  });
}

function renderRecents() {
  if (!recentListEl) return;
  const matches = recentMatches(recentItems, recentSearchEl?.value || "");
  const pageSize = recentPageSize();
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  recentPage = Math.min(recentPage, pages - 1);
  recentListEl.innerHTML = "";

  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.innerHTML = recentItems.length
      ? "<span>No projects match your search</span>"
      : `${EMPTY_FOLDER_SVG}<span>No projects yet</span>`;
    recentListEl.append(empty);
  } else {
    const first = recentPage * pageSize;
    for (const project of matches.slice(first, first + pageSize))
      recentListEl.append(buildProjectRow(project, { onPick: onPickProject, onDeleted: loadRecents }));
  }

  if (recentCountEl) recentCountEl.textContent = matches.length === recentItems.length
    ? `${matches.length} project${matches.length === 1 ? "" : "s"}`
    : `${matches.length} of ${recentItems.length}`;
  if (recentPaginationEl) recentPaginationEl.hidden = pages <= 1;
  if (recentPageEl) recentPageEl.textContent = `Page ${recentPage + 1} of ${pages}`;
  if (recentPrevBtn) recentPrevBtn.disabled = recentPage === 0;
  if (recentNextBtn) recentNextBtn.disabled = recentPage === pages - 1;
}

async function loadRecents() {
  if (!recentListEl) return;
  try {
    // Server already sorts by saved_at desc, so the newest saves lead.
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error('Project library unavailable');
    recentItems = await response.json();
    recentPage = 0;
    renderRecents();
    welcomeRecent.hidden = false;
  } catch {
    welcomeRecent.hidden = false;
    recentListEl.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    const message = document.createElement('span');
    message.textContent = 'Could not load your projects.';
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.addEventListener('click', loadRecents);
    empty.append(message, retry);
    recentListEl.append(empty);
    if (recentPaginationEl) recentPaginationEl.hidden = true;
  }
}

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

// Compact "time since last save" for the recents list. Relative through weeks,
// then a fixed en-US date once the save is about a month old.
function savedAgo(iso) {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return plural(Math.max(1, Math.floor(s)), "second");
  const m = Math.floor(s / 60); if (m < 60) return plural(m, "minute");
  const h = Math.floor(m / 60); if (h < 24) return plural(h, "hour");
  const d = Math.floor(h / 24); if (d < 7) return plural(d, "day");
  const w = Math.floor(d / 7); if (d < 30) return plural(w, "week");
  const dt = new Date(iso);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

// One library-project row (welcome list + Open-project picker share it).
// onPick(job) opens it; onDeleted() re-renders the list after a delete.
export function buildProjectRow(p, { onPick, onDeleted }) {
  const info = projectCardInfo(p);
  const label = info.title;
  const row = document.createElement("div");
  row.className = "recent-item";
  row.dataset.job = p.job;

  const open = document.createElement("button");
  open.className = "ri-open";
  open.type = "button";
  open.setAttribute("aria-label", `Open ${label}`);

  const cover = document.createElement("span");
  cover.className = "ri-cover";
  if (info.coverUrl) {
    const image = document.createElement("img");
    image.src = info.coverUrl;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      cover.classList.add("placeholder");
      cover.innerHTML = PROJECT_ART_SVG;
    }, { once: true });
    cover.append(image);
  } else {
    cover.classList.add("placeholder");
    cover.innerHTML = PROJECT_ART_SVG;
  }

  const copy = document.createElement("span");
  copy.className = "ri-copy";
  const name = document.createElement("span");
  name.className = "ri-name";
  name.textContent = label;
  copy.append(name);
  if (info.context) {
    const context = document.createElement("span");
    context.className = "ri-context";
    context.textContent = info.context;
    copy.append(context);
  }
  if (info.utility) {
    const utility = document.createElement("span");
    utility.className = "ri-utility";
    utility.textContent = info.utility;
    copy.append(utility);
  }
  open.append(cover, copy);
  open.addEventListener("click", () => onPick(p.job));

  const side = document.createElement("div");
  side.className = "ri-side";
  const meta = document.createElement("span");
  meta.className = "ri-meta";
  const ago = savedAgo(p.saved_at);
  meta.textContent = ago ? `Edited ${ago}` : "";
  if (p.saved_at) meta.title = `Last edited ${new Date(p.saved_at).toLocaleString()}`;

  const del = document.createElement("button");
  del.type = 'button'; del.className = "icon-btn btn--compact ri-delete";
  del.setAttribute("aria-label", `Delete ${label}`);
  del.title = `Delete ${label}`;
  del.innerHTML = TRASH_SVG;
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    del.focus();
    const confirmed = await confirmAction({
      title: "Delete project",
      message: `“${label}” and its stems are deleted. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const r = await fetch(`/api/projects/${p.job}`, { method: "DELETE" });
      if (!r.ok) throw new Error("delete failed");
      onDeleted();
    } catch { toast("Couldn't delete project", 2200, "error"); }
  });

  const facts = document.createElement('span'); facts.className = 'ri-facts';
  const utility = copy.querySelector('.ri-utility');
  if (utility) facts.append(utility);
  if (meta.textContent) facts.append(meta);
  copy.append(facts);
  side.append(del);
  row.append(open, side);
  return row;
}

// ---- File ▸ Open project… ----
// Pick an existing library project from within the editor (the welcome list is
// otherwise the only way in). Reuses the same rows.
// Rule 17/21: this is a modal, so picking a row stages the choice and Open
// commits it — clicking a row used to open the project outright, which is what a
// window with no footer always ends up doing. The welcome screen keeps the
// direct pick: a launcher is not scrimmed and has nothing to stage.
let openProjPick = null;
async function openProjectPicker() {
  if (!openProjBackdrop) return;
  openProjList.innerHTML = "";
  selectOpenProj(null);
  openProjBackdrop.hidden = false;
  let items = [];
  try {
    items = await (await fetch("/api/projects")).json();
  } catch {
    openProjList.innerHTML = `<div class="recent-empty"><span>Couldn't load projects</span></div>`;
    return;
  }
  if (!items.length) {
    openProjList.innerHTML = `<div class="recent-empty">${EMPTY_FOLDER_SVG}<span>No projects yet</span></div>`;
    return;
  }
  for (const p of items) {
    const row = buildProjectRow(p, { onPick: () => selectOpenProj(p.job), onDeleted: openProjectPicker });
    row.addEventListener("dblclick", commitOpenProj);
    openProjList.append(row);
  }
}

function selectOpenProj(job) {
  openProjPick = job;
  openProjList.querySelectorAll(".recent-item").forEach((r) => r.classList.remove("selected"));
  if (job) openProjList.querySelector(`.recent-item[data-job="${CSS.escape(job)}"]`)?.classList.add("selected");
  $("openProjOpen").disabled = !job;
}

function commitOpenProj() {
  if (!openProjPick) return;
  const job = openProjPick;
  closeOpenProjPicker();
  onPickProject(job);
}

function closeOpenProjPicker() {
  if (openProjBackdrop) openProjBackdrop.hidden = true;
}

// ---- drag and drop onto the launcher ----
function isFileDrag(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const items = Array.from(dt.items || []);
  if (items.length) return items.some((item) => item.kind === "file");
  return Array.from(dt.types || []).includes("Files");
}

let dragDepth = 0;

/**
 * Wire the launcher and the Open-project picker.
 * @param {object} hooks
 * @param {(file?: File) => void} hooks.onNew   start a new project, optionally seeded with an audio file
 * @param {() => void} hooks.onOpenFile         open a .chart from disk
 * @param {(job: string) => void} hooks.onPick  open a library project by job id
 */
export function initProjectLibrary({ onNew, onOpenFile, onPick }) {
  onNewProject = onNew;
  onOpenProjectFile = onOpenFile;
  onPickProject = onPick;

  welcomeNewBtn.addEventListener("click", () => { hideWelcome(); onNewProject(); });
  welcomeOpenBtn.addEventListener("click", () => onOpenProjectFile());  // the caller hides the launcher on success
  recentSearchEl?.addEventListener("input", () => { recentPage = 0; renderRecents(); });
  recentPrevBtn?.addEventListener("click", () => { recentPage = Math.max(0, recentPage - 1); renderRecents(); });
  recentNextBtn?.addEventListener("click", () => { recentPage += 1; renderRecents(); });
  window.addEventListener("resize", () => { if (!welcome.hidden) renderRecents(); });

  openProjMenuBtn.addEventListener("click", openProjectPicker);
  openProjClose.addEventListener("click", closeOpenProjPicker);
  $("openProjCancel").addEventListener("click", closeOpenProjPicker);
  $("openProjOpen").addEventListener("click", commitOpenProj);
  openProjBackdrop.addEventListener("click", (e) => { if (e.target === openProjBackdrop) closeOpenProjPicker(); });
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (openProjBackdrop.hidden) return false;
    closeOpenProjPicker(); return true;
  });

  welcome.addEventListener("dragenter", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    setDropping(true);
  });
  welcome.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  welcome.addEventListener("dragleave", (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropping(false);
  });
  welcome.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDropping(false);
    const files = Array.from(e.dataTransfer.files || []);
    const gpFile = files.find(isGuitarProFile);
    if (gpFile) {
      // guitar-pro-import.js listens; going through the window keeps the GP
      // importer off this module's import list.
      window.dispatchEvent(new CustomEvent("cw-open-guitar-pro", { detail: gpFile }));
      return;
    }
    const file = files.find(isAudioFile);
    if (!file) {
      toast("Drop audio or a Guitar Pro file to start a project");
      return;
    }
    hideWelcome();
    onNewProject(file);
  });
}
