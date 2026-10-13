// Rocksmith CDLC export UI: the arrangement picker, the metadata form and the
// POST that builds the .psarc. The File-menu entry is wired in ui.js with the
// other exports.

import { $ } from "./dom.js";
import { MAX_CAPO, editLanes } from "./lanes.js";
import { RS_KIND_OPTIONS, defaultRsKind, isTablatureLane } from "./layer-role.js";
import { applyCoverChange, clearProjectCover, exportSongName, latinFields, metadataFromState, metadataPayload, normalizeMetadata, uploadDroppedProjectCover, uploadProjectCover } from "./metadata.js";
import { downloadProjectBlob, toast } from "./notify.js";
import { S } from "./store.js";
import { rememberPref } from "./util.js";
import { TUNINGS, buildSpecForLanesAsync, customTunings, laneTuning, parseTuning, tuningToNames } from "./tablature.js";

function renderRsArrangements(lanes) {
  const wrap = $("rsArrangements");
  const used = new Set();
  wrap.innerHTML = "";
  lanes.forEach((lane, i) => {
    const notes = lane.notes || [];
    const track = { name: lane.name, notes, tuning: laneTuning(lane), arrangement: lane.rocksmithArrangement };
    const enabled = isTablatureLane(lane);
    const row = document.createElement("div");
    // Rule 21's form sub-list: the row carries fields and the "Arrangements"
    // label still governs it, so it stays in the normal body inside that group,
    // is 44 tall on one line, and its controls drop to 24/r4. It used to be a
    // three-line card whose reason text wrapped, which is what rule 24 means by
    // a wrapping warning breaking every row beside it.
    row.className = "rs-arr-row list-row list-row--fields";
    row.dataset.track = String(i);
    row._trackTuning = track.tuning || [];
    const kind = defaultRsKind(track, used);
    row.innerHTML = `
      <input type="checkbox" class="rs-arr-on" ${enabled && notes.length ? "checked" : ""}>
      <span class="rs-arr-name"></span>
      ${enabled ? "" : `<span class="rs-arr-warn" role="img" title="${OFF_REASON}" aria-label="${OFF_REASON}">${WARN_ICON}</span>`}
      <span class="count"></span>
      <select class="rs-arr-kind">
        ${RS_KIND_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === kind ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    `;
    const trackName = track.name || `Layer ${i + 1}`;
    row.querySelector(".rs-arr-on").setAttribute("aria-label", `Export ${trackName}`);
    row.querySelector(".rs-arr-name").textContent = trackName;
    // Written the way the layer list writes it ("12 notes").
    row.querySelector(".count").textContent = `${notes.length.toLocaleString()} note${notes.length === 1 ? "" : "s"}`;
    row.querySelector(".rs-arr-kind").addEventListener("change", () =>
      updateRsTuningSelect(row, rsTuningFromSelect(row.querySelector(".rs-arr-tuning"))));
    updateRsTuningSelect(row, row._trackTuning);
    // The layer's capo, overridable here like the tuning. Frets count from it, so a
    // different capo keeps the shapes and moves where they sit on the neck.
    const capo = document.createElement("select");
    capo.className = "rs-arr-capo";
    capo.title = "Capo fret in Rocksmith";
    capo.setAttribute("aria-label", `Capo for ${trackName}`);
    const own = Number(lane.capo) || 0;
    for (let fret = 0; fret <= Math.max(MAX_CAPO, own); fret++) capo.append(new Option(fret ? `Capo ${fret}` : "No capo", String(fret)));
    capo.value = String(own);
    row.append(capo);
    wrap.append(row);
  });
}

// Check the audio tools before the user fills in the export form. The backend
// selects Wwise on Windows and native Vorbis/WEM tools on Linux.
let converterOk = false;

async function checkAudioConverter() {
  let linux = false;
  try {
    const res = await fetch("/api/rocksmith/audio-converter");
    if (!res.ok) throw new Error("Audio converter status unavailable.");
    const status = await res.json();
    converterOk = status.found === true;
    linux = status.platform === "linux";
    $("rsWwiseWarn").querySelector(".rs-wwise-text").textContent = linux
      ? (converterOk
          ? "Linux audio export is experimental. Check playback and seeking in Rocksmith 2014."
          : "Linux export needs the wwise-wem package.")
      : "Wwise isn't installed. Rocksmith audio can't be converted without it.";
    const link = $("rsWwiseGet");
    link.href = linux ? "https://github.com/rabbit-smith/wem" : "https://www.audiokinetic.com/download/";
    link.textContent = linux ? "Get wwise-wem" : "Get Wwise";
    link.hidden = converterOk;
  } catch {
    converterOk = false;
    $("rsWwiseWarn").querySelector(".rs-wwise-text").textContent =
      "Audio converter status unavailable.";
    $("rsWwiseGet").hidden = true;
  }
  $("rsWwiseWarn").hidden = converterOk && !linux;
  $("rsExportGo").disabled = !converterOk;
}

function openRocksmithExportModal() {
  if (!S.state) return;
  const lanes = editLanes();
  if (!lanes.length) { toast("No note layers to export"); return; }
  rsModalLanes = lanes;
  const meta = metadataFromState(S.state);
  $("rsTitle").value = meta.title || "";
  $("rsArtist").value = meta.artist || "";
  $("rsAlbum").value = meta.album || "";
  $("rsYear").value = meta.year || "";
  rsLatin.fill(meta);
  renderRsCover(meta);
  renderRsArrangements(lanes);
  $("rsLeadIn").value = String(leadIn(localStorage.getItem(LS_LEAD_IN)));
  setRsStatus("");
  converterOk = false;
  $("rsExportGo").disabled = true;
  $("rsWwiseGet").hidden = false;
  checkAudioConverter();
  $("rocksmithExportBackdrop").hidden = false;
  $("rsTitle").focus();
}

function closeRocksmithExportModal() {
  $("rocksmithExportBackdrop").hidden = true;
}

// Upload, drop and clear differ only in which metadata call they make and what
// they say afterwards. The shared part is the bit that is easy to get wrong:
// the text fields are read from the form FIRST, so a cover change does not
// discard a title the user has typed but not yet exported with.
async function applyRsCover(working, done, run) {
  if (!S.state) return;
  const meta = await applyCoverChange(rsMetaFromForm(), () => run(S.state.job), setRsStatus, working, done);
  if (!meta) return;
  S.state.metadata = meta;
  renderRsCover(S.state.metadata);
}

const uploadRsCover = (file) => file &&
  applyRsCover("Uploading cover art...", "Cover art uploaded", (job) => uploadProjectCover(job, file));
const uploadRsCoverFromDrop = (dataTransfer) =>
  applyRsCover("Uploading cover art...", "Cover art uploaded", (job) => uploadDroppedProjectCover(job, dataTransfer));
const clearRsCover = () =>
  applyRsCover("Removing cover art...", "Cover art removed", (job) => clearProjectCover(job));

// Silence in front of the song, in seconds. Rocksmith starts the track the moment the
// song loads, so a first note in the first second cannot be seen coming; five seconds
// is the room the note highway needs. Remembered across exports, 0 to 30.
const LS_LEAD_IN = "cw.rsLeadIn", LEAD_IN_DEFAULT = 5;
function leadIn(raw) {
  const value = raw === null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : LEAD_IN_DEFAULT;
}

export function exportRocksmith() {
  openRocksmithExportModal();
}

async function submitRocksmithExport() {
  if (!S.state) return;
  // Enter in a text field submits a form whether or not its submit button is
  // disabled, so the check guards the work as well as the button.
  if (!converterOk) return;
  if (!$("rsTitle").value.trim() || !$("rsArtist").value.trim()) {
    setRsStatus("Enter a song title and an artist.", true);
    return;
  }
  if (rsLatin.missing()) {
    setRsStatus("Add a Latin spelling for each name written in another script.", true);
    return;
  }
  const picks = [];
  const seenKinds = new Set();
  for (const row of $("rsArrangements").querySelectorAll(".rs-arr-row")) {
    if (!row.querySelector(".rs-arr-on").checked) continue;
    const lane = rsModalLanes[parseInt(row.dataset.track, 10)];
    const kind = row.querySelector(".rs-arr-kind").value;
    if (seenKinds.has(kind)) {
      setRsStatus("Each Rocksmith arrangement type can only be used once.", true);
      return;
    }
    seenKinds.add(kind);
    const tuning = rsTuningFromSelect(row.querySelector(".rs-arr-tuning"));
    if (!tuning || ![4, 6].includes(tuning.length)) {
      setRsStatus("Rocksmith export needs 4-string bass or 6-string guitar tunings.", true);
      return;
    }
    if (kind.includes("bass") !== (tuning.length === 4)) {
      setRsStatus("Bass arrangements need 4 strings; guitar arrangements need 6.", true);
      return;
    }
    picks.push({ lane, kind, tuning, capo: Number(row.querySelector(".rs-arr-capo").value) || 0 });
  }
  if (!picks.length) { setRsStatus("Select at least one arrangement.", true); return; }

  let spec;
  try {
    setRsStatus("Calculating fingerings…");
    // Rocksmith is independent of eye visibility and note count: the picker
    // above decides what to voice, including layers with tablature switched
    // off if the user ticked them here.
    spec = await buildSpecForLanesAsync(picks.map((p) => p.lane));
  } catch (e) {
    setRsStatus(e.message, true);
    return;
  }
  const meta = rsMetaFromForm();
  S.state.metadata = { ...normalizeMetadata(S.state.metadata || {}), ...meta };
  spec.name = exportSongName(meta, S.state.name || S.state.filename || "song");
  spec.metadata = metadataPayload(S.state.metadata);
  const leadingSilence = leadIn($("rsLeadIn").value);
  rememberPref(LS_LEAD_IN, leadingSilence);
  // A whole number from 1; anything else falls back to 1 (the server checks again).
  const version = Math.max(1, Math.floor(Number($("rsVersion").value)) || 1);
  $("rsVersion").value = String(version);
  spec.rocksmith = { arrangements: picks.map((p, i) => ({ track: i, kind: p.kind, tuning: p.tuning, capo: p.capo })), leadingSilence, version };

  $("rsExportGo").disabled = true;
  setRsStatus("Building CDLC…");
  try {
    const res = await fetch(`/api/projects/${S.state.job}/rocksmith`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "CDLC build failed");
    const buf = await res.arrayBuffer();
    const cd = res.headers.get("Content-Disposition") || "";
    // filename* carries the real (UTF-8) name; filename="" is only its ASCII fallback.
    const encoded = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const name = (encoded ? decodeURIComponent(encoded[1]) : (cd.match(/filename="([^"]+)"/) || [])[1]) || "song_p.psarc";
    let warns = []; try { warns = JSON.parse(res.headers.get("X-Tab-Warnings") || "[]"); } catch { /* advisory only */ }
    downloadProjectBlob(new Blob([buf], { type: "application/octet-stream" }), name);
    closeRocksmithExportModal();
    toast(warns.length ? `Exported ${name} - ${warns.length} warning(s)` : `Exported ${name}`, 2200, warns.length ? "warn" : "ok");
  } catch (e) {
    setRsStatus(e.message, true);
  } finally {
    $("rsExportGo").disabled = !converterOk;
  }
}

export function init_rocksmith_export() {
  $("rocksmithExportForm").addEventListener("submit", (e) => { e.preventDefault(); submitRocksmithExport(); });
  $("rsExportClose").addEventListener("click", closeRocksmithExportModal);
  $("rsExportCancel").addEventListener("click", closeRocksmithExportModal);
  $("rsCoverDrop").addEventListener("click", (e) => { if (!e.target.closest(".cover-clear")) $("rsCoverInput").click(); });
  $("rsCoverDrop").addEventListener("keydown", (e) => {
    if (e.target.closest(".cover-clear")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("rsCoverInput").click(); }
  });
  $("rsCoverInput").addEventListener("change", () => {
    if ($("rsCoverInput").files[0]) uploadRsCover($("rsCoverInput").files[0]);
    $("rsCoverInput").value = "";
  });
  $("rsCoverClear").addEventListener("click", (e) => { e.stopPropagation(); clearRsCover(); });
  ["dragenter", "dragover"].forEach((ev) => $("rsCoverDrop").addEventListener(ev, (e) => { e.preventDefault(); $("rsCoverDrop").classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => $("rsCoverDrop").addEventListener(ev, (e) => { e.preventDefault(); $("rsCoverDrop").classList.remove("drag"); }));
  $("rsCoverDrop").addEventListener("drop", (e) => { uploadRsCoverFromDrop(e.dataTransfer); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("rocksmithExportBackdrop").hidden) {
      e.preventDefault();
      closeRocksmithExportModal();
    }
  });
}
