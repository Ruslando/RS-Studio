// The New Project modal: upload a full song, fill in its details, and create it.
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

import { $, fileInput, form, goBtn, modalBackdrop, newProjBtn, npClear, npDrop, npDropSub, npDropTitle, warnEl } from "./dom.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { applyCoverChange, clearProjectCover, coverStatus, latinFields, metadataPayload, normalizeMetadata, uploadDroppedProjectCover, uploadProjectCover } from "./metadata.js";
import { loadWithScreen } from "./project-loading.js";
import { uploadRequest } from "./operation-progress.js";

// Set by initNewProject. See the module banner: these are the only way out.
let onProjectCreated = () => {};
let onModalClosed = () => {};
let canLeaveOpenProject = async () => true;


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

const NP_SUB_DEFAULT = npDropSub.textContent;
const npSongTitleInput = $("npSongTitle"), npArtistInput = $("npArtist");
const npAlbumInput = $("npAlbum"), npYearInput = $("npYear");
const npCoverDrop = $("npCoverDrop"), npCoverThumb = $("npCoverThumb");
const npCoverTitle = $("npCoverTitle"), npCoverSub = $("npCoverSub");
const npCoverClear = $("npCoverClear"), npCoverInput = $("npCoverInput");
const npFormFields = $("npFormFields"), npClose = $("npClose");
const npAudioPreviewRow = $("npAudioPreviewRow"), npAudioPreview = $("npAudioPreview");
const npPitch = $("npPitch"), npTuningRef = $("npTuningRef");
const npTuningDetected = $("npTuningDetected"), npTuningShiftAudio = $("npTuningShiftAudio");
const npPitchApply = $("npPitchApply"), npPitchStatus = $("npPitchStatus");
let draftMetadata = normalizeMetadata({});
let autoMetadataValues = { title: "", artist: "", album: "", year: "" };
let autoCoverArt = "";
let draftTuning = { estimate: null, reference: 0, shift: 0 };
let draftTargetHz = 440;
let draftShiftAudio = false;
let uploadedSong = false;
const metadataInputs = { title: npSongTitleInput, artist: npArtistInput, album: npAlbumInput, year: npYearInput };
for (const [key, input] of Object.entries(metadataInputs)) {
  input.addEventListener("input", () => {
    autoMetadataValues[key] = null;
    if (key === "title" || key === "artist") refreshCreateEnabled();
  });
}
const npLatin = latinFields({ title: "npSongTitle", artist: "npArtist", album: "npAlbum" });

// True while the full song is still on its way to the server: Create would
// finalize a draft with no audio in it yet.
let mainUploading = false;
let formBusy = false;

function refreshCreateEnabled() {
  // A project is named after its song, so it cannot be created without one.
  const named = npSongTitleInput.value.trim() && npArtistInput.value.trim();
  goBtn.disabled = mainUploading || formBusy || !uploadedSong || !named
    || !npTuningRef.checkValidity() || draftPitchPending();
}

function setFormBusy(busy) {
  formBusy = !!busy;
  npFormFields.inert = formBusy;
  npFormFields.setAttribute("aria-busy", String(formBusy));
  npClose.disabled = formBusy;
  npPitchApply.disabled = formBusy || !uploadedSong;
  refreshCreateEnabled();
}

function setUploadStep(hasAudio) {
  uploadedSong = !!hasAudio;
  npFormFields.classList.toggle("has-audio", uploadedSong);
  $("newProjModal").classList.toggle("audio-step", !uploadedSong);
  $("newProjModal").classList.toggle("audio-ready", uploadedSong);
  npAudioPreviewRow.hidden = !uploadedSong;
  npPitch.hidden = !uploadedSong;
  if (!uploadedSong) { npPitchStatus.textContent = ""; npPitchStatus.hidden = true; }
  refreshCreateEnabled();
}

const hzOf = (cents) => 440 * 2 ** (cents / 1200);
const centsOfHz = (hz) => 1200 * Math.log2(hz / 440);

function currentDraftTuning() {
  const reference = draftTuning.reference || 0;
  const target = centsOfHz(draftTargetHz);
  return { reference, shift: draftShiftAudio ? target - reference : 0 };
}

function draftPitchPending() {
  const activeShift = Math.abs(draftTuning.shift || 0) >= 0.05;
  if (!draftShiftAudio) return activeShift;
  if (uploadedSong && !npTuningRef.checkValidity()) return true;
  const targetHz = Math.round(Number(npTuningRef.value) || draftTargetHz);
  const currentHz = Math.round(hzOf((draftTuning.reference || 0) + (draftTuning.shift || 0)));
  return !activeShift ? targetHz !== Math.round(hzOf(draftTuning.reference || 0)) : targetHz !== currentHz;
}

function refreshDraftPitchAction() {
  npPitchApply.hidden = !uploadedSong || !draftPitchPending();
  npPitchApply.disabled = formBusy || !uploadedSong;
  refreshCreateEnabled();
}

function renderDraftTuning() {
  npTuningRef.value = String(draftTargetHz);
  npTuningShiftAudio.checked = draftShiftAudio;
  npTuningDetected.textContent = draftTuning.estimate == null
    ? "Not detected" : `${Math.round(hzOf(draftTuning.estimate))} Hz`;
  refreshDraftPitchAction();
}

async function applyDraftPitchShift() {
  if (!draftJob || !uploadedSong) return;
  if (draftShiftAudio && !npTuningRef.reportValidity()) return;
  if (npTuningRef.checkValidity()) draftTargetHz = Math.round(Number(npTuningRef.value));
  if (!draftPitchPending()) return;
  const previousShift = draftTuning.shift || 0;
  setFormBusy(true);
  npPitchApply.textContent = "Applying…";
  try {
    const res = await fetch(`/api/projects/${draftJob}/tuning`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentDraftTuning()),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Could not update pitch settings");
    const data = await res.json();
    draftTuning = data.tuning;
    npPitchStatus.textContent = "";
    npPitchStatus.hidden = true;
    renderDraftTuning();
    if (Math.abs(previousShift - (draftTuning.shift || 0)) >= 0.05) {
      setPreviewSource(`/api/audio/${draftJob}/mix`, true);
    }
  } catch (err) {
    npPitchStatus.textContent = err.message;
    npPitchStatus.hidden = false;
  } finally {
    npPitchApply.textContent = "Apply pitch shift";
    setFormBusy(false);
    renderDraftTuning();
  }
}

function setPreviewSource(url, cacheBust = false) {
  if (!url) {
    npAudioPreview.pause();
    npAudioPreview.removeAttribute("src");
    npAudioPreview.load();
    return;
  }
  const playing = !npAudioPreview.paused;
  const time = Number.isFinite(npAudioPreview.currentTime) ? npAudioPreview.currentTime : 0;
  const next = cacheBust ? `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}` : url;
  npAudioPreview.addEventListener("loadedmetadata", () => {
    npAudioPreview.currentTime = Math.min(time, npAudioPreview.duration || time);
    if (playing) npAudioPreview.play().catch(() => {});
  }, { once: true });
  npAudioPreview.src = next;
  npAudioPreview.load();
}

// ---- metadata + cover art ----
function collectNewProjectMetadata() {
  const current = normalizeMetadata(draftMetadata);
  current.title = (npSongTitleInput.value || "").trim();
  current.artist = (npArtistInput.value || "").trim();
  current.album = (npAlbumInput.value || "").trim();
  current.year = (npYearInput.value || "").trim();
  return npLatin.read(current);
}

function prepareMetadataForAudio() {
  for (const [key, input] of Object.entries(metadataInputs)) {
    const value = input.value.trim();
    if (!value || value === autoMetadataValues[key]) {
      input.value = "";
      autoMetadataValues[key] = input.value;
    }
  }
  npLatin.fill(collectNewProjectMetadata());
  const current = normalizeMetadata(draftMetadata);
  if (current.coverArt && current.coverArt === autoCoverArt) {
    draftMetadata = normalizeMetadata({ ...current, coverArt: null, coverArtName: "", coverArtUpdatedAt: null, coverArtUrl: "" });
    autoCoverArt = "";
    renderNewProjectCover();
  }
}

function applyAudioMetadata(audioMetadata = {}) {
  for (const [key, input] of Object.entries(metadataInputs)) {
    const value = String(audioMetadata[key] || "").trim();
    if (value && (!input.value.trim() || input.value.trim() === autoMetadataValues[key])) {
      input.value = value;
      autoMetadataValues[key] = value;
    }
  }
  const current = normalizeMetadata(draftMetadata);
  const replaceAutoCover = current.coverArt && current.coverArt === autoCoverArt;
  if (audioMetadata.coverArt && (!current.coverArt || replaceAutoCover)) {
    draftMetadata = normalizeMetadata({ ...current, ...audioMetadata });
    autoCoverArt = audioMetadata.coverArt;
  } else if (!audioMetadata.coverArt && replaceAutoCover) {
    draftMetadata = normalizeMetadata({ ...current, coverArt: null, coverArtName: "", coverArtUpdatedAt: null, coverArtUrl: "" });
    autoCoverArt = "";
  }
  npLatin.fill(collectNewProjectMetadata());
  renderNewProjectCover();
  refreshCreateEnabled();
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
  setFormBusy(true);
  try {
    const meta = await applyCoverChange(before, async () => run(await ensureDraftJob()),
      coverStatus(npCoverDrop, (message) => { npCoverSub.textContent = message; }), "Uploading...", "Uploaded");
    draftMetadata = meta || before;
    if (meta) autoCoverArt = "";
    renderNewProjectCover();
  } finally {
    setFormBusy(false);
  }
}

async function clearNewProjectCover() {
  const current = collectNewProjectMetadata();
  setFormBusy(true);
  try {
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
    autoCoverArt = "";
    renderNewProjectCover();
  } finally {
    setFormBusy(false);
  }
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
    setPreviewSource("");
    draftTuning = { estimate: null, reference: 0, shift: 0 };
    draftTargetHz = 440;
    draftShiftAudio = false;
    setUploadStep(false);
    renderDraftTuning();
    refreshCreateEnabled();
    return;
  }
  npDrop.classList.remove("error");
  npDrop.classList.add("has-file");
  npDropTitle.textContent = file.name;
  npDropSub.textContent = "";   // the progress panel says it, with the bytes sent
  npClear.hidden = false;
  npClear.disabled = true;
  const firstUpload = !uploadedSong;
  let uploadSucceeded = false;
  prepareMetadataForAudio();
  mainUploading = true;
  setFormBusy(true);
  try {
    const job = await ensureDraftJob();
    const fd = new FormData();
    fd.append("audio", file);
    const data = await uploadRequest(`/api/projects/${job}/mix`, fd, "Uploading song", file.name);
    npDropSub.textContent = "";
    draftTuning = { estimate: null, reference: 0, shift: 0, ...(data.tuning || {}) };
    draftTargetHz = Math.round(hzOf(draftTuning.reference || 0));
    draftShiftAudio = false;
    applyAudioMetadata(data.audioMetadata);
    renderDraftTuning();
    setPreviewSource(data.stem.audio_url);
    setUploadStep(true);
    uploadSucceeded = true;
  } catch (err) {
    npDrop.classList.remove("has-file"); npDrop.classList.add("error");
    npDropTitle.textContent = "Upload failed — click to try again";
    npDropSub.textContent = err.message;
    fileInput.value = "";
  }
  mainUploading = false;
  npClear.disabled = false;
  setFormBusy(false);
  if (firstUpload && uploadSucceeded) npSongTitleInput.focus();
}

// ---- open / close / create ----
// Creating finishes by replacing whatever is open, so the unsaved-work question
// belongs here rather than at Create — by then the answer "cancel" is a lie.
// True once the modal is up and reset — a caller seeding it with a dropped file
// has to wait for that, and gets nothing when the question was answered "cancel".
export async function openNewProject() {
  if (!await canLeaveOpenProject()) return false;
  mainUploading = false;
  setFormBusy(false);
  if (npSongTitleInput) npSongTitleInput.value = "";
  if (npArtistInput) npArtistInput.value = "";
  if (npAlbumInput) npAlbumInput.value = "";
  if (npYearInput) npYearInput.value = "";
  draftMetadata = normalizeMetadata({});
  autoMetadataValues = { title: "", artist: "", album: "", year: "" };
  autoCoverArt = "";
  npLatin.fill(draftMetadata);
  renderNewProjectCover();
  fileInput.value = "";
  setPreviewSource("");
  draftTuning = { estimate: null, reference: 0, shift: 0 };
  draftTargetHz = 440;
  draftShiftAudio = false;
  setUploadStep(false);
  renderDraftTuning();
  npDrop.classList.remove("has-file", "error");
  npDropTitle.textContent = "Drop the full song, or click to browse";
  npDropSub.textContent = NP_SUB_DEFAULT;
  npClear.hidden = true;
  draftJob = null; draftJobPromise = null;
  modalBackdrop.hidden = false;
  refreshCreateEnabled();
  if (npDrop) npDrop.focus();
  return true;
}

// Any draft job that never made it to Create is abandoned server-side. onClosed
// then decides what to show instead — closing with nothing open falls back to
// the launcher, which is project.js's call to make, not this module's.
function closeNewProject() {
  modalBackdrop.hidden = true;
  npAudioPreview.pause();
  if (draftJob) {
    const abandoned = draftJob;
    draftJob = null; draftJobPromise = null;
    fetch(`/api/projects/${abandoned}`, { method: "DELETE" }).catch(() => {});
  }
  onModalClosed();
}

async function createProject() {
  if (!uploadedSong) return;
  warnEl.innerHTML = "";   // a previous project's warnings must not survive the wait
  goBtn.disabled = true;
  // The loading screen (design.md 4.17): this ends in the project opening, and
  // nothing can be done until it has. A failure is said there, and Back returns
  // to this window with everything still in it.
  setFormBusy(true);
  try {
    await loadWithScreen(async () => {
      const job = await ensureDraftJob();
      draftMetadata = collectNewProjectMetadata();
      const res = await fetch(`/api/projects/${job}/finalize`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: metadataPayload(draftMetadata) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || "Request failed");
      }
      const data = await res.json();
      draftJob = null; draftJobPromise = null;   // it's a real project now — closeNewProject must not delete it
      closeNewProject();
      await onProjectCreated(data);
    }, { title: "Creating project", failureTitle: "Could not create the project" });
  } finally {
    setFormBusy(false);
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
  $("npClose").addEventListener("click", closeNewProject);
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (modalBackdrop.hidden) return false;
    if (formBusy) return false;
    closeNewProject(); return true;
  });

  npDrop.addEventListener("click", (e) => { if (!e.target.closest(".np-clear")) fileInput.click(); });
  npDrop.addEventListener("keydown", (e) => {
    if (e.target.closest(".np-clear")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) setMainFile(fileInput.files[0]); });
  npTuningRef.addEventListener("input", () => {
    const value = Number(npTuningRef.value);
    if (Number.isInteger(value) && value >= 427 && value <= 453) draftTargetHz = value;
    refreshDraftPitchAction();
  });
  npTuningRef.addEventListener("change", refreshDraftPitchAction);
  npTuningShiftAudio.addEventListener("change", () => {
    draftShiftAudio = npTuningShiftAudio.checked;
    refreshDraftPitchAction();
  });
  npPitchApply.addEventListener("click", applyDraftPitchShift);
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

}
