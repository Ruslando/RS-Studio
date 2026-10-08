// The New Project modal: name the project, drop in the full song, then build up
// its stems — each separated or uploaded (and previewable) independently — before
// Create finalizes the lot.
//
// The modal owns the *draft*, and that is the whole reason it can stand alone.
// A draft is a real project on the server that exists before you press Create:
// `draftJob` is its id once anything has actually touched the server (null
// before, so opening the modal and cancelling costs nothing). Its lifetime is
// exactly the modal's — Cancel deletes it, Create promotes it and must not — and
// nothing outside these walls can see or use one. So unlike the stem panel, the
// state here really is the screen's.
//
// What the modal does not own is what happens *after* Create: turning the
// finalize response into an open project is project.js's job and arrives as
// `onCreated`. Same for falling back to the launcher when a cancel leaves nothing
// open — `onClosed`. Same rule as project-library.js and stem-settings.js: the
// import edge runs one way, project.js → here.

import { $, addStemBtn, fileInput, form, goBtn, modalBackdrop, newProjBtn, npCancelBtn, npClear, npDrop, npDropSub, npDropTitle, npNameInput, stemBulkBrowseBtn, stemBulkInput, stemsAddEl, stemsListEl, warnEl } from "./dom.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { UPLOAD_ARROW_ICON } from "./icons.js";
import { applyCoverChange, clearProjectCover, metadataPayload, normalizeMetadata, uploadDroppedProjectCover, uploadProjectCover } from "./metadata.js";
import { toast } from "./notify.js";
import { operationRequest, uploadRequest } from "./operation-progress.js";
import { DEFAULT_PART_ORDER, backendLabel, separators } from "./separators.js";
import { previewIcon, syncScrub, wireScrub } from "./stem-preview.js";
import { isAudioFile } from "./util.js";

// The card's own close button; the upload arrow is shared, so it is in icons.js.
const REMOVE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

// Set by initNewProject. See the module banner: these are the only way out.
let onProjectCreated = () => {};
let onModalClosed = () => {};
let canLeaveOpenProject = async () => true;

const npStatusEl = $("npStatus");

function setNpStatus(msg, busy) {
  npStatusEl.textContent = "";
  npStatusEl.classList.toggle("busy", !!busy);
  if (busy) npStatusEl.append(Object.assign(document.createElement("span"), { className: "spinner" }));
  if (msg) npStatusEl.append(document.createTextNode(msg));
  npStatusEl.hidden = !msg && !busy;
  goBtn.disabled = !!busy;
}

let draftJob = null;
let draftJobPromise = null;

async function ensureDraftJob() {
  if (draftJob) return draftJob;
  if (!draftJobPromise) {
    draftJobPromise = fetch("/api/projects/new", { method: "POST" })
      .then((r) => r.json()).then((d) => { draftJob = d.job; return draftJob; });
  }
  return draftJobPromise;
}

function cleanupOrphanStem(stemId) {
  // A card was removed while its separate/upload request was still in flight —
  // the server finished the work after the fact, so drop the now-unwanted stem.
  if (draftJob) fetch(`/api/projects/${draftJob}/stems/${stemId}`, { method: "DELETE" }).catch(() => {});
}

let stemSeq = 0;
const NP_SUB_DEFAULT = npDropSub.textContent;
const npSongTitleInput = $("npSongTitle"), npArtistInput = $("npArtist");
const npAlbumInput = $("npAlbum"), npYearInput = $("npYear");
const npCoverDrop = $("npCoverDrop"), npCoverThumb = $("npCoverThumb");
const npCoverTitle = $("npCoverTitle"), npCoverSub = $("npCoverSub");
const npCoverClear = $("npCoverClear"), npCoverInput = $("npCoverInput");
let draftMetadata = normalizeMetadata({});

function hasFullSong() { return fileInput.files.length > 0; }

function refreshCreateEnabled() {
  const anyWorking = stemsListEl.querySelector(".stem-card[data-state='working']");
  const anyReady = stemsListEl.querySelector(".stem-card[data-state='ready']");
  goBtn.disabled = !!anyWorking || !(hasFullSong() || anyReady);
}

// Cards parked in the "choosing" state render the backend list, so they need a
// nudge when it arrives (or when the full song appears and separation unlocks).
export function refreshChoosingCards() {
  stemsListEl.querySelectorAll(".stem-card[data-state='choosing']").forEach((c) => { if (c._render) c._render(); });
}

// ---- metadata + cover art ----
function collectNewProjectMetadata() {
  const current = normalizeMetadata(draftMetadata);
  current.title = (npSongTitleInput.value || "").trim();
  current.artist = (npArtistInput.value || "").trim();
  current.album = (npAlbumInput.value || "").trim();
  current.year = (npYearInput.value || "").trim();
  return current;
}

function renderNewProjectCover() {
  const meta = normalizeMetadata(draftMetadata);
  const has = !!meta.coverArtUrl;
  npCoverThumb.classList.toggle("has-cover", has);
  npCoverThumb.replaceChildren();
  if (has) { const img = document.createElement("img"); img.src = meta.coverArtUrl; img.alt = ""; npCoverThumb.append(img); }
  npCoverTitle.textContent = has ? (meta.coverArtName || "Cover art") : "Choose image";
  // Rule 24: optional is silent and status is not a sentence. The title already
  // carries the file name; this line is the upload progress channel, empty at rest.
  npCoverSub.textContent = "";
  npCoverClear.hidden = !has;
}

async function setNewProjectCover(file) {
  if (file) await changeNewProjectCover((job) => uploadProjectCover(job, file));
}

const setNewProjectCoverFromDrop = (dataTransfer) =>
  changeNewProjectCover((job) => uploadDroppedProjectCover(job, dataTransfer));

// The draft has no status line of its own — the sub-label under the thumbnail is
// where both progress and errors go.
async function changeNewProjectCover(run) {
  const before = collectNewProjectMetadata();
  const status = (msg, error) => { if (error || msg !== "Uploaded") npCoverSub.textContent = msg; };
  const meta = await applyCoverChange(before, async () => run(await ensureDraftJob()),
    status, "Uploading...", "Uploaded");
  draftMetadata = meta || before;
  renderNewProjectCover();
}

async function clearNewProjectCover() {
  const current = collectNewProjectMetadata();
  if (draftJob && draftMetadata.coverArt) {
    try {
      const cleared = await clearProjectCover(draftJob);
      draftMetadata = { ...current, ...cleared, title: current.title, artist: current.artist, album: current.album, year: current.year };
    } catch {
      draftMetadata = { ...current, coverArt: null, coverArtName: "", coverArtUrl: "", coverArtUpdatedAt: null };
    }
  } else {
    draftMetadata = { ...current, coverArt: null, coverArtName: "", coverArtUrl: "", coverArtUpdatedAt: null };
  }
  renderNewProjectCover();
}

// ---- stem cards ----
// One stem card: a self-contained state machine (choosing source -> working ->
// ready) wired to the draft-job endpoints above. Kept as one closure per card
// (like project.js's per-row builders, e.g. renderStemTabs) rather than a shared
// render loop — each card's async work (separate/upload) is independent of the
// others.
function createStemCard() {
  stemSeq += 1;
  const card = document.createElement("div");
  card.className = "stem-card";
  card.dataset.state = "choosing";
  card.dataset.mode = hasFullSong() ? "separate" : "upload";
  card._n = stemSeq;
  card._pos = 0; card._duration = NaN; card._playing = false;
  card._serverStemId = null;
  card._removed = false;

  function render() {
    if (!hasFullSong() && card.dataset.mode === "separate") card.dataset.mode = "upload";
    const state = card.dataset.state;
    const mode = card.dataset.mode;
    let body = "";
    if (state === "choosing") {
      const avail = separators.filter((s) => s.available);
      const selectedBackend = avail.find((s) => s.id === card._backend) || avail[0];
      body = `
        <div class="view-switch" role="group" aria-label="Audio source">
          <button type="button" class="mode ${mode === "separate" ? "active" : ""}" data-pick="separate"
            ${hasFullSong() ? "" : "disabled title='Upload the full song first to separate stems from it'"}>Separate from audio</button>
          <button type="button" class="mode ${mode === "upload" ? "active" : ""}" data-pick="upload">Upload my own</button>
        </div>
        ${mode === "separate" ? `
          <div class="sc-source-row">
            <select class="sc-backend">
              ${separators.map((s) => `<option value="${s.id}" ${s.available ? "" : "disabled"}
                ${s.id === selectedBackend?.id ? "selected" : ""}>${s.label}${s.available ? "" : " — unavailable"}</option>`).join("")}
            </select>
            <select class="sc-part"></select>
            <button type="button" class="primary sc-go" ${avail.length ? "" : "disabled"}>Separate</button>
          </div>
          ${avail.length ? "" : `<p class="sc-error">No separation backend is available.</p>`}
        ` : `
          <div class="sc-drop" tabindex="0" role="button" aria-label="Choose or drop an audio file">
            ${UPLOAD_ARROW_ICON}
            <span>Drop a stem file here, or click to browse</span>
            <input type="file" class="sc-file" accept="audio/*" hidden />
          </div>
        `}
        ${card._error ? `<p class="sc-error">${card._error}</p>` : ""}
      `;
    } else if (state === "working") {
      body = `
        <div class="sc-working">
          <span class="sc-work-copy">
            <span class="sc-work-label"></span>
          </span>
        </div>
      `;
    } else if (state === "ready") {
      body = `
        <div class="sc-ready">
          <button type="button" class="sc-preview" aria-label="Play preview">${previewIcon(card._playing ? "pause" : "play")}</button>
          <div class="sc-ready-main">
            <input type="text" class="sc-name" />
            <span class="sc-caption"></span>
            <div class="sc-scrub-row">
              <div class="sc-scrub" role="slider" tabindex="0" aria-label="Seek preview" aria-valuemin="0">
                <span class="sc-scrub-fill"></span>
                <span class="sc-scrub-handle"></span>
              </div>
              <span class="sc-time">0:00 / 0:00</span>
            </div>
          </div>
        </div>
      `;
    }
    card.innerHTML = `
      <div class="stem-card-head">
        <button type="button" class="sc-remove" aria-label="Remove audio">
          ${REMOVE_ICON}
        </button>
      </div>
      ${body}
    `;
    // Everything above is a fixed shell. User strings — the stem name, the
    // uploaded file name, the progress label — are written in as text, the same
    // way buildProjectRow and the Rocksmith arrangement rows do it, so a file
    // called `<img onerror=...>` stays a file name.
    setText(".sc-name", card._name, "value");
    setText(".sc-caption", card._source);
    setText(".sc-work-label", card._workLabel);
    wire();
    if (card.dataset.state === "working") refreshCreateEnabled();
  }

  function setText(selector, value, prop = "textContent") {
    const el = card.querySelector(selector);
    if (el) el[prop] = value || "";
  }

  function wire() {
    card.querySelector(".sc-remove").addEventListener("click", () => removeCard());

    if (card.dataset.state === "choosing") {
      card.querySelectorAll("[data-pick]").forEach((b) =>
        b.addEventListener("click", () => { card.dataset.mode = b.dataset.pick; card._error = null; render(); }));

      if (card.dataset.mode === "separate") {
        const backendSel = card.querySelector(".sc-backend");
        const partSel = card.querySelector(".sc-part");
        if (backendSel) {
          card._backend = card._backend || backendSel.value;
          const fillParts = () => {
            const b = separators.find((s) => s.id === backendSel.value);
            const parts = (b && b.stems) || [];
            const def = DEFAULT_PART_ORDER.find((p) => parts.some((s) => s.id === p)) || (parts[0] && parts[0].id);
            partSel.innerHTML = parts.map((s) => `<option value="${s.id}" ${s.id === (card._part || def) ? "selected" : ""}>${s.label}</option>`).join("");
          };
          fillParts();
          backendSel.addEventListener("change", () => { card._backend = backendSel.value; card._part = null; fillParts(); });
          card.querySelector(".sc-go").addEventListener("click", () => {
            card._backend = backendSel.value;
            card._part = partSel.value;
            startSeparation();
          });
        }
      } else {
        const drop = card.querySelector(".sc-drop");
        const input = card.querySelector(".sc-file");
        drop.addEventListener("click", () => input.click());
        drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
        input.addEventListener("change", () => { if (input.files[0]) acceptUpload(input.files[0]); });
        ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
        ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
        drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) acceptUpload(f); });
      }
    }

    if (card.dataset.state === "ready") {
      const nameInput = card.querySelector(".sc-name");
      nameInput.addEventListener("input", () => { card._name = nameInput.value; });
      card.querySelector(".sc-preview").addEventListener("click", () => togglePlay());
      wireCardScrub();
      syncCardScrub();
    }
  }

  function removeCard() {
    card._removed = true;
    if (card._audioEl) card._audioEl.pause();
    card.remove();
    if (card._serverStemId) cleanupOrphanStem(card._serverStemId);
    refreshCreateEnabled();
  }

  function setReadyAudio(url) {
    const a = new Audio(url);
    card._audioEl = a;
    card._pos = 0; card._duration = NaN;
    a.addEventListener("loadedmetadata", () => { card._duration = a.duration; syncCardScrub(); });
    a.addEventListener("timeupdate", () => { card._pos = a.currentTime; syncCardScrub(); });
    a.addEventListener("ended", () => { pausePlayback(); card._pos = 0; a.currentTime = 0; syncCardScrub(); });
  }

  async function startSeparation() {
    card.dataset.state = "working";
    card._workLabel = `Separating with ${backendLabel(card._backend)}…`;
    card._error = null;
    render();
    try {
      const job = await ensureDraftJob();
      const data = await operationRequest(
        `/api/projects/${job}/stems/separate`,
        {backend: card._backend, part: card._part},
        "Separating audio", `${backendLabel(card._backend)} · ${card._part}`,
      );
      if (card._removed) { cleanupOrphanStem(data.stem.id); return; }
      card._serverStemId = data.stem.id;
      card._name = data.stem.name;
      card._source = `Separated · ${backendLabel(card._backend)}`;
      setReadyAudio(data.stem.audio_url);
      card.dataset.state = "ready";
      render();
      if (data.warning) toast(data.warning, 6000, "warn");
    } catch (err) {
      card._error = err.cancelled ? null : err.message;
      card.dataset.state = "choosing";
      render();
    }
    refreshCreateEnabled();
  }

  async function acceptUpload(file) {
    card.dataset.state = "working";
    card._workLabel = "Uploading…";
    card._error = null;
    render();
    try {
      const job = await ensureDraftJob();
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", file.name.replace(/\.[^.]+$/, ""));
      const data = await uploadRequest(`/api/projects/${job}/stems/upload`, fd, "Adding audio", file.name);
      if (card._removed) { cleanupOrphanStem(data.stem.id); return; }
      card._serverStemId = data.stem.id;
      card._name = data.stem.name;
      card._source = `Uploaded · ${file.name}`;
      setReadyAudio(data.stem.audio_url);
      card.dataset.state = "ready";
      render();
    } catch (err) {
      card._error = err.message;
      card.dataset.state = "choosing";
      render();
    }
    refreshCreateEnabled();
  }

  const syncCardScrub = () => syncScrub(card, card._pos, card._duration);

  function seekFrac(seconds) {
    card._pos = seconds;
    if (card._audioEl) card._audioEl.currentTime = card._pos;
    syncCardScrub();
  }

  const wireCardScrub = () => wireScrub(card, () => card._duration, () => card._pos, seekFrac);

  function togglePlay() { card._playing ? pausePlayback() : playPreview(); }

  function playPreview() {
    if (!card._audioEl || !Number.isFinite(card._duration)) return;
    card._playing = true;
    const btn = card.querySelector(".sc-preview");
    if (btn) btn.innerHTML = previewIcon("pause");
    card._audioEl.currentTime = card._pos;
    card._audioEl.play();
  }

  function pausePlayback() {
    card._playing = false;
    const btn = card.querySelector(".sc-preview");
    if (btn) btn.innerHTML = previewIcon("play");
    if (card._audioEl) card._audioEl.pause();
  }

  card._render = render;
  card._acceptUpload = acceptUpload;
  render();
  return card;
}

function bulkAddStemFiles(fileList) {
  Array.from(fileList || []).filter(isAudioFile).forEach((f) => {
    const card = createStemCard();
    stemsListEl.appendChild(card);
    card._acceptUpload(f);
  });
}

// ---- the full song ----
export async function setMainFile(file) {
  const dt = new DataTransfer();
  if (file) dt.items.add(file);
  fileInput.files = dt.files;
  if (!file) {
    npDrop.classList.remove("has-file", "error");
    npDropTitle.textContent = "Drop the full song, or click to browse";
    npDropSub.textContent = NP_SUB_DEFAULT;
    npClear.hidden = true;
    refreshChoosingCards();
    refreshCreateEnabled();
    return;
  }
  npDrop.classList.remove("error");
  npDrop.classList.add("has-file");
  npDropTitle.textContent = file.name;
  npDropSub.textContent = "Uploading…";
  npClear.hidden = false;
  npClear.disabled = true;
  if (!npNameInput.value) npNameInput.value = file.name.replace(/\.[^.]+$/, "");
  if (npSongTitleInput && !npSongTitleInput.value) npSongTitleInput.value = file.name.replace(/\.[^.]+$/, "");
  try {
    const job = await ensureDraftJob();
    const fd = new FormData();
    fd.append("audio", file);
    const res = await fetch(`/api/projects/${job}/mix`, { method: "POST", body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Upload failed");
    const data = await res.json();
    npDropSub.textContent = data.tempo ? `${Math.round(data.tempo)} BPM detected` : "Ready";
  } catch (err) {
    npDrop.classList.remove("has-file"); npDrop.classList.add("error");
    npDropTitle.textContent = "Upload failed — click to try again";
    npDropSub.textContent = err.message;
    fileInput.value = "";
  }
  npClear.disabled = false;
  refreshChoosingCards();
  refreshCreateEnabled();
}

// Stop any card's preview playback/progress timer before its DOM node is
// dropped — closures keep them alive otherwise, so audio would keep playing
// in the background after the modal closes.
function disposeStemCards() {
  stemsListEl.querySelectorAll(".stem-card").forEach((c) => {
    if (c._audioEl) c._audioEl.pause();
  });
  stemsListEl.replaceChildren();
}

// ---- open / close / create ----
// Creating finishes by replacing whatever is open, so the unsaved-work question
// belongs here rather than at Create — by then the answer "cancel" is a lie.
// True once the modal is up and reset — a caller seeding it with a dropped file
// has to wait for that, and gets nothing when the question was answered "cancel".
export async function openNewProject() {
  if (!await canLeaveOpenProject()) return false;
  npNameInput.value = "";
  if (npSongTitleInput) npSongTitleInput.value = "";
  if (npArtistInput) npArtistInput.value = "";
  if (npAlbumInput) npAlbumInput.value = "";
  if (npYearInput) npYearInput.value = "";
  draftMetadata = normalizeMetadata({});
  renderNewProjectCover();
  fileInput.value = "";
  npDrop.classList.remove("has-file", "error");
  npDropTitle.textContent = "Drop the full song, or click to browse";
  npDropSub.textContent = NP_SUB_DEFAULT;
  npClear.hidden = true;
  disposeStemCards();
  stemSeq = 0;
  draftJob = null; draftJobPromise = null;
  setNpStatus("", false);
  modalBackdrop.hidden = false;
  refreshCreateEnabled();
  npNameInput.focus();
  return true;
}

// Any draft job that never made it to Create is abandoned server-side. onClosed
// then decides what to show instead — closing with nothing open falls back to
// the launcher, which is project.js's call to make, not this module's.
export function closeNewProject() {
  modalBackdrop.hidden = true;
  disposeStemCards();
  if (draftJob) {
    const abandoned = draftJob;
    draftJob = null; draftJobPromise = null;
    fetch(`/api/projects/${abandoned}`, { method: "DELETE" }).catch(() => {});
  }
  onModalClosed();
}

async function createProject() {
  if (!hasFullSong() && !stemsListEl.querySelector(".stem-card[data-state='ready']")) return;
  setNpStatus("Creating project…", true);
  warnEl.innerHTML = "";   // a previous project's warnings must not survive the wait
  try {
    const job = await ensureDraftJob();
    draftMetadata = collectNewProjectMetadata();
    const res = await fetch(`/api/projects/${job}/finalize`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: (npNameInput.value || "").trim(), metadata: metadataPayload(draftMetadata) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Request failed");
    }
    const data = await res.json();
    setNpStatus("", false);
    draftJob = null; draftJobPromise = null;   // it's a real project now — closeNewProject must not delete it
    closeNewProject();
    onProjectCreated(data);
  } catch (err) {
    setNpStatus("Error: " + err.message, false);
  }
}

/**
 * Wire the modal.
 * @param {object} hooks
 * @param {(data: object) => void} hooks.onCreated  the finalize response — open it as a project
 * @param {() => void} hooks.onClosed               the modal closed; decide what is on screen now
 * @param {() => Promise<boolean>} [hooks.canLeave] may the open project be left? (unsaved work)
 */
export function initNewProject({ onCreated, onClosed, canLeave }) {
  onProjectCreated = onCreated;
  onModalClosed = onClosed;
  if (canLeave) canLeaveOpenProject = canLeave;

  form.addEventListener("submit", (e) => { e.preventDefault(); createProject(); });
  newProjBtn.addEventListener("click", openNewProject);
  npCancelBtn.addEventListener("click", closeNewProject);
  $("npClose").addEventListener("click", closeNewProject);
  modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeNewProject(); });
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (modalBackdrop.hidden) return false;
    closeNewProject(); return true;
  });

  npDrop.addEventListener("click", (e) => { if (!e.target.closest(".np-clear")) fileInput.click(); });
  npDrop.addEventListener("keydown", (e) => {
    if (e.target.closest(".np-clear")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) setMainFile(fileInput.files[0]); });
  npClear.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (npClear.disabled) return;
    const hadJob = draftJob;
    await setMainFile(null);
    if (hadJob) fetch(`/api/projects/${hadJob}/stems/mix`, { method: "DELETE" }).catch(() => {});
  });
  ["dragenter", "dragover"].forEach((ev) => npDrop.addEventListener(ev, (e) => { e.preventDefault(); npDrop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => npDrop.addEventListener(ev, (e) => { e.preventDefault(); npDrop.classList.remove("drag"); }));
  npDrop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) setMainFile(f); });

  if (npCoverDrop) {
    npCoverDrop.addEventListener("click", (e) => { if (!e.target.closest(".cover-clear")) npCoverInput.click(); });
    npCoverDrop.addEventListener("keydown", (e) => {
      if (e.target.closest(".cover-clear")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); npCoverInput.click(); }
    });
    npCoverInput.addEventListener("change", () => { if (npCoverInput.files[0]) setNewProjectCover(npCoverInput.files[0]); npCoverInput.value = ""; });
    npCoverClear.addEventListener("click", (e) => { e.stopPropagation(); clearNewProjectCover(); });
    ["dragenter", "dragover"].forEach((ev) => npCoverDrop.addEventListener(ev, (e) => { e.preventDefault(); npCoverDrop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => npCoverDrop.addEventListener(ev, (e) => { e.preventDefault(); npCoverDrop.classList.remove("drag"); }));
    npCoverDrop.addEventListener("drop", (e) => { setNewProjectCoverFromDrop(e.dataTransfer); });
  }

  addStemBtn.addEventListener("click", () => { stemsListEl.appendChild(createStemCard()); refreshCreateEnabled(); });
  stemBulkBrowseBtn.addEventListener("click", () => stemBulkInput.click());
  stemBulkInput.addEventListener("change", () => { bulkAddStemFiles(stemBulkInput.files); stemBulkInput.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => stemsAddEl.addEventListener(ev, (e) => { e.preventDefault(); stemsAddEl.classList.add("drag"); }));
  stemsAddEl.addEventListener("dragleave", () => stemsAddEl.classList.remove("drag"));
  stemsAddEl.addEventListener("drop", (e) => { e.preventDefault(); stemsAddEl.classList.remove("drag"); bulkAddStemFiles(e.dataTransfer.files); });
}
