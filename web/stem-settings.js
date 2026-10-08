// The stem settings panel. Renames a stem, or replaces its audio in place —
// re-separated from the full song, or an uploaded file — reusing the New Project
// modal's source-picker and scrub-preview markup/classes. Only one instance is
// ever open, so this is plain module state rather than a per-card closure.
//
// It is a modal despite the "panel" name: `#stemSettingsBackdrop` is a
// full-screen scrim and `#stemSettingsPanel` a centered 420px window, styled with
// the layer editor and the tuning manager (style.css:717). Hence ESC_DEPTH.modal
// below — and hence nothing else can be open underneath it to tie with.
//
// What this module is NOT is the three operations its buttons trigger. Renaming,
// removing and replacing a stem all change the project, not the panel: removing
// the stem you are listening to has to re-point playback, and removing the last
// one has to drop the editor out of spectrogram view entirely. That work stays in
// project.js and arrives here as callbacks, so the next way to remove a stem — a
// tab-strip menu, a shortcut, an undo — reuses it instead of reaching in here for
// it. Same rule as project-library.js: this is a screen, not a lifecycle.

import { confirmAction } from "./dialog.js";
import { $, stemSettCard, stemSettingsBackdrop, stemSettingsClose, stemSettName, stemSettNameInput } from "./dom.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { UPLOAD_ARROW_ICON } from "./icons.js";
import { toast } from "./notify.js";
import { DEFAULT_PART_ORDER, backendLabel, separators } from "./separators.js";
import { previewIcon, syncScrub, wireScrub } from "./stem-preview.js";
import { operationRequest, uploadRequest } from "./operation-progress.js";
import { S } from "./store.js";

// Set by initStemSettings. See the module banner: these are the only way out.
let onRenameStem = async () => false;
let onRemoveStem = async () => false;
let onStemReplaced = () => {};

let stemEditTarget = null;      // the S.state.stems entry being edited
let stemEditIsMaster = false;   // captured at open; the master can't change under an open panel
let stemEditState = "idle";     // "idle" (preview + replace) | "working"
let stemEditMode = "separate";  // which replacement source is showing
let stemEditBackend = null, stemEditPart = null;
let stemEditError = null;
let stemEditAudioEl = null, stemEditPos = 0, stemEditDuration = NaN, stemEditPlaying = false;
let stemEditWorkLabel = "";

// A full song was uploaded at some point iff the manifest has a filename — the
// only client-side signal that the server's raw `input.*` exists to separate from.
function stemEditHasFullSong() { return !!(S.state && S.state.filename); }

function setStemEditAudio(url) {
  if (stemEditAudioEl) stemEditAudioEl.pause();
  const a = new Audio(url);
  stemEditAudioEl = a;
  stemEditPos = 0; stemEditDuration = NaN; stemEditPlaying = false;
  a.addEventListener("loadedmetadata", () => { stemEditDuration = a.duration; syncStemEditScrub(); });
  a.addEventListener("timeupdate", () => { stemEditPos = a.currentTime; syncStemEditScrub(); });
  a.addEventListener("ended", () => { stemEditPlaying = false; stemEditPos = 0; a.currentTime = 0; syncStemEditScrub(); renderStemEditPreviewBtn(); });
}

export function openStemSettings(stem, isMaster) {
  stemEditTarget = stem;
  stemEditIsMaster = !!isMaster;
  stemEditState = "idle";
  stemEditMode = stemEditHasFullSong() ? "separate" : "upload";
  stemEditBackend = null; stemEditPart = null; stemEditError = null;
  setStemEditAudio(stem.audioUrl);
  renderStemSettings();
  stemSettingsBackdrop.hidden = false;
  stemSettNameInput.focus();
}

export function closeStemSettings() {
  stemSettingsBackdrop.hidden = true;
  if (stemEditAudioEl) { stemEditAudioEl.pause(); stemEditAudioEl = null; }
  stemEditTarget = null;
}

function renderStemSettings() {
  if (!stemEditTarget) return;
  stemSettName.textContent = stemEditTarget.name;
  stemSettNameInput.value = stemEditTarget.name;
  renderStemEditCard();
}

// Rule 17: this window is scrimmed, so the name is staged — it used to commit on
// blur, which meant the rename had already happened by the time you looked at the
// buttons. Save writes it; Cancel and Escape just close and the typing is dropped.
// Replacing the audio is not a staged value: it is a server job with its own
// progress, launched by its own verb, exactly as Remove is.
async function commitStemRename() {
  const stem = stemEditTarget;
  if (!stem) return true;
  const name = stemSettNameInput.value.trim();
  if (!name || name === stem.name) { stemSettNameInput.value = stem.name; return true; }
  if (await onRenameStem(stem, name)) {
    if (stemEditTarget === stem) stemSettName.textContent = name;
    return true;
  }
  if (stemEditTarget === stem) stemSettNameInput.value = stem.name;
  return false;
}

async function saveStemSettings() {
  if (await commitStemRename()) closeStemSettings();
}

function renderStemEditCard() {
  const card = stemSettCard;
  const stem = stemEditTarget;
  if (!stem || !card) return;
  const master = stemEditIsMaster;
  let body = "";
  if (stemEditState === "working") {
    body = `
      <div class="sc-working">
        <span class="sc-work-copy">
          <span class="sc-work-label">${stemEditWorkLabel}</span>
        </span>
      </div>
    `;
  } else {
    // Listening to what is there and replacing it are two different jobs, so
    // they are two groups, both on screen. They were one: a preview row and a
    // "Replace or recreate…" button that swapped the whole card for the pickers
    // — which hid every way of changing the audio behind a word, and made the
    // preview disappear the moment you went looking for them.
    const avail = separators.filter((s) => s.available);
    const showSeparate = !master && stemEditMode === "separate";
    body = `
      <div class="sc-ready">
        <button type="button" class="sc-preview" aria-label="Play preview">${previewIcon(stemEditPlaying ? "pause" : "play")}</button>
        <div class="sc-ready-main">
          <div class="sc-scrub-row">
            <div class="sc-scrub" role="slider" tabindex="0" aria-label="Seek preview" aria-valuemin="0">
              <span class="sc-scrub-fill"></span>
              <span class="sc-scrub-handle"></span>
            </div>
            <span class="sc-time">0:00 / 0:00</span>
          </div>
        </div>
      </div>
      <div class="sc-replace">
        <span class="t-caps sc-replace-label">Replace</span>
        ${!master ? `
          <div class="view-switch" role="group" aria-label="Replacement source">
            <button type="button" class="mode ${stemEditMode === "separate" ? "active" : ""}" data-pick="separate"
              ${stemEditHasFullSong() ? "" : "disabled title='No full song on file to separate from'"}>Separate from audio</button>
            <button type="button" class="mode ${stemEditMode === "upload" ? "active" : ""}" data-pick="upload">Upload my own</button>
          </div>
        ` : ""}
        ${showSeparate ? `
          <div class="sc-source-row">
            <select class="sc-backend">
              ${avail.map((s) => `<option value="${s.id}" ${s.id === (stemEditBackend || (avail[0] && avail[0].id)) ? "selected" : ""}>${s.label}</option>`).join("")}
            </select>
            <select class="sc-part"></select>
            <button type="button" class="primary sc-go" ${avail.length ? "" : "disabled"}>Separate</button>
          </div>
          ${avail.length ? "" : `<p class="sc-error">No separation backend is available.</p>`}
        ` : `
          <div class="sc-drop" tabindex="0" role="button" aria-label="Choose or drop a replacement audio file">
            ${UPLOAD_ARROW_ICON}
            <span>Drop a replacement file here, or click to browse</span>
            <input type="file" class="sc-file" accept="audio/*" hidden />
          </div>
        `}
        ${stemEditError ? `<p class="sc-error"></p>` : ""}
      </div>
    `;
  }
  card.innerHTML = body;
  // The error line quotes server messages, which quote file names. Text, not markup.
  if (stemEditError) card.querySelector(".sc-error").textContent = stemEditError;
  wireStemEditCard();
  syncStemEditScrub();
}

function wireStemEditCard() {
  const card = stemSettCard;
  if (!card || !stemEditTarget) return;

  if (stemEditState === "idle") {
    card.querySelector(".sc-preview").addEventListener("click", () => toggleStemEditPlay());
    wireStemEditScrub();
    // Removal is the footer's job (rule 17): a destructive action in an editor
    // sits far from the primary, outlined, and opens a confirmation.
    card.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => { stemEditMode = b.dataset.pick; stemEditError = null; renderStemEditCard(); }));

    const backendSel = card.querySelector(".sc-backend");
    if (backendSel) {
      const partSel = card.querySelector(".sc-part");
      stemEditBackend = stemEditBackend || backendSel.value;
      const fillParts = () => {
        const b = separators.find((s) => s.id === backendSel.value);
        const parts = (b && b.stems) || [];
        const def = DEFAULT_PART_ORDER.find((p) => parts.some((s) => s.id === p)) || (parts[0] && parts[0].id);
        partSel.innerHTML = parts.map((s) => `<option value="${s.id}" ${s.id === (stemEditPart || def) ? "selected" : ""}>${s.label}</option>`).join("");
      };
      fillParts();
      backendSel.addEventListener("change", () => { stemEditBackend = backendSel.value; stemEditPart = null; fillParts(); });
      card.querySelector(".sc-go").addEventListener("click", () => {
        stemEditBackend = backendSel.value; stemEditPart = partSel.value;
        startStemEditSeparate();
      });
    } else {
      const drop = card.querySelector(".sc-drop");
      const input = card.querySelector(".sc-file");
      drop.addEventListener("click", () => input.click());
      drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
      input.addEventListener("change", () => { if (input.files[0]) startStemEditReplace(input.files[0]); });
      ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
      ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
      drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) startStemEditReplace(f); });
    }
  }
}

// The panel owns the confirmation — it is the thing the user is looking at — and
// project.js owns everything after it. The panel only closes once the removal
// actually happened, so a failed delete leaves it open with its toast.
async function requestStemRemoval() {
  const stem = stemEditTarget;
  if (!stem) return;
  const confirmed = await confirmAction({
    title: "Remove audio",
    message: `The audio and spectrogram for “${stem.name}” are deleted.`,
    confirmLabel: "Remove",
    danger: true,
  });
  // The panel or project may have changed while the confirmation was open.
  if (!confirmed || stemEditTarget !== stem) return;
  if (await onRemoveStem(stem)) closeStemSettings();
}

function renderStemEditPreviewBtn() {
  const btn = stemSettCard.querySelector(".sc-preview");
  if (btn) btn.innerHTML = previewIcon(stemEditPlaying ? "pause" : "play");
}

const syncStemEditScrub = () => syncScrub(stemSettCard, stemEditPos, stemEditDuration);

function seekStemEditFrac(seconds) {
  stemEditPos = seconds;
  if (stemEditAudioEl) stemEditAudioEl.currentTime = stemEditPos;
  syncStemEditScrub();
}

const wireStemEditScrub = () => wireScrub(stemSettCard,
  () => stemEditDuration, () => stemEditPos, seekStemEditFrac);

function toggleStemEditPlay() {
  if (stemEditPlaying) { stemEditPlaying = false; stemEditAudioEl.pause(); }
  else { stemEditPlaying = true; stemEditAudioEl.currentTime = stemEditPos; stemEditAudioEl.play(); }
  renderStemEditPreviewBtn();
}

// New audio landed for `stem`. project.js patches the real stem entry whether or
// not the panel has since moved on to a different stem (or closed) — only the
// panel's own half is guarded here.
function finishStemEdit(stem, s, warn, duration) {
  onStemReplaced(stem, s, warn, duration);
  if (stemEditTarget === stem) {
    setStemEditAudio(s.audio_url);
    toast("Audio updated", 2200, "ok");
    setTimeout(() => { if (stemEditTarget === stem) { stemEditState = "idle"; renderStemEditCard(); } }, 200);
  }
}

function failStemEdit(stem, message) {
  if (stemEditTarget === stem) {
    stemEditError = message;
    stemEditState = "idle";
    renderStemEditCard();
  }
}

async function startStemEditSeparate() {
  const stem = stemEditTarget;
  const state = S.state;   // drop the result if another project opens mid-separation
  stemEditState = "working";
  stemEditWorkLabel = `Separating with ${backendLabel(stemEditBackend)}…`;
  stemEditError = null;
  renderStemEditCard();
  closeStemSettings();
  try {
    const data = await operationRequest(
      `/api/projects/${state.job}/stems/${stem.id}/separate`,
      {backend: stemEditBackend, part: stemEditPart},
      "Separating audio", `${backendLabel(stemEditBackend)} · ${stemEditPart} → ${stem.name}`,
    );
    if (S.state !== state) return;
    finishStemEdit(stem, data.stem, data.warning);
  } catch (err) {
    failStemEdit(stem, err.cancelled ? null : err.message);
  }
}

async function startStemEditReplace(file) {
  const stem = stemEditTarget;
  const state = S.state;   // drop the result if another project opens mid-upload
  stemEditState = "working";
  stemEditWorkLabel = "Uploading…";
  stemEditError = null;
  renderStemEditCard();
  try {
    const fd = new FormData();
    fd.append("file", file);
    const data = await uploadRequest(`/api/projects/${state.job}/stems/${stem.id}/replace`, fd, "Replacing audio", stem.name);
    if (S.state !== state) return;
    finishStemEdit(stem, data.stem, null, data.duration);
  } catch (err) {
    failStemEdit(stem, err.cancelled ? null : err.message);
  }
}

/**
 * Wire the panel.
 * @param {object} hooks
 * @param {(stem: object, name: string) => Promise<boolean>} hooks.onRename   persist a rename; false leaves the old name
 * @param {(stem: object) => Promise<boolean>} hooks.onRemove                 delete the stem and repair the editor; false keeps the panel open
 * @param {(stem: object, s: object, warn: ?string, duration: ?number) => void} hooks.onReplaced  point the project at the stem's new audio
 */
export function initStemSettings({ onRename, onRemove, onReplaced }) {
  onRenameStem = onRename;
  onRemoveStem = onRemove;
  onStemReplaced = onReplaced;

  stemSettingsClose.addEventListener("click", closeStemSettings);
  stemSettingsBackdrop.addEventListener("click", (e) => { if (e.target === stemSettingsBackdrop) closeStemSettings(); });
  $("stemCancel").addEventListener("click", closeStemSettings);
  $("stemSave").addEventListener("click", saveStemSettings);
  $("stemRemove").addEventListener("click", requestStemRemoval);
  stemSettNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveStemSettings(); } });
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (!stemSettingsBackdrop || stemSettingsBackdrop.hidden) return false;
    closeStemSettings(); return true;
  });
}
