// Rocksmith CDLC export UI: the arrangement picker, the metadata form and the
// POST that builds the .psarc. The File-menu entry is wired in ui.js with the
// other exports.

import { $ } from "./dom.js";
import { editLanes } from "./lanes.js";
import { isTablatureLane } from "./layer-role.js";
import { applyCoverChange, clearProjectCover, exportSongName, metadataFromState, metadataPayload, normalizeMetadata, uploadDroppedProjectCover, uploadProjectCover } from "./metadata.js";
import { downloadProjectBlob, toast } from "./notify.js";
import { S } from "./store.js";
import { TUNINGS, buildSpecForLanesAsync, customTunings, laneTuning, parseTuning, tuningToNames } from "./tablature.js";

const RS_KIND_OPTIONS = [
  ["lead", "Lead"],
  ["rhythm", "Rhythm"],
  ["alt_lead", "Alt Lead"],
  ["alt_rhythm", "Alt Rhythm"],
  ["bonus_lead", "Bonus Lead"],
  ["bonus_rhythm", "Bonus Rhythm"],
  ["bass", "Bass"],
  ["alt_bass", "Alt Bass"],
  ["bonus_bass", "Bonus Bass"],
];

function defaultRsKind(track, used) {
  if (RS_KIND_OPTIONS.some(([kind]) => kind === track.arrangement)) {
    used.add(track.arrangement);
    return track.arrangement;
  }
  const tuning = track.tuning || [];
  const isBass = tuning.length === 4 || (tuning.length === 5 && Math.max(...tuning) < 52);
  const order = isBass
    ? ["bass", "alt_bass", "bonus_bass"]
    : ["lead", "rhythm", "alt_lead", "alt_rhythm", "bonus_lead", "bonus_rhythm"];
  const kind = order.find((k) => !used.has(k)) || order[0];
  used.add(kind);
  return kind;
}

function rsStringCountForKind(kind) {
  return kind.includes("bass") ? 4 : 6;
}

function sameTuning(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function rsTuningValue(tuning) {
  return tuning.map((v) => String(v)).join(",");
}

function rsTuningFromSelect(select) {
  return (select.value || "").split(",").map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v));
}

function rsDefaultTuning(count, preferred) {
  if (preferred && preferred.length === count) return preferred;
  return (count === 4 ? TUNINGS.bass4 : TUNINGS.guitar6).tuning;
}

function appendRsTuningGroup(select, label, tunings) {
  if (!tunings.length) return;
  const group = document.createElement("optgroup");
  group.label = label;
  for (const item of tunings) group.append(new Option(item.label, rsTuningValue(item.tuning)));
  select.append(group);
}

function createRsTuningSelect(count, selected) {
  const select = document.createElement("select");
  select.className = "rs-arr-tuning";
  select.title = "Open-string tuning, highest first";
  select.setAttribute("aria-label", "Tuning");

  const builtIns = Object.entries(TUNINGS)
    .filter(([, def]) => def.tuning.length === count)
    .map(([, def]) => ({ label: def.label, tuning: def.tuning }));
  const customs = customTunings
    .map((t) => ({ label: `${t.name} (${t.notes})`, tuning: parseTuning(t.notes) || [] }))
    .filter((t) => t.tuning.length === count);
  const allKnown = [...builtIns, ...customs];
  const current = selected && selected.length === count && !allKnown.some((t) => sameTuning(t.tuning, selected))
    ? [{ label: `Current layer (${tuningToNames(selected)})`, tuning: selected }]
    : [];

  appendRsTuningGroup(select, "Built-in", builtIns);
  appendRsTuningGroup(select, "Custom", customs);
  appendRsTuningGroup(select, "Current note layer", current);
  select.value = rsTuningValue(selected);
  return select;
}

function updateRsTuningSelect(row, preferred) {
  const count = rsStringCountForKind(row.querySelector(".rs-arr-kind").value);
  const selected = rsDefaultTuning(count, preferred && preferred.length === count ? preferred : row._trackTuning);
  const next = createRsTuningSelect(count, selected);
  const current = row.querySelector(".rs-arr-tuning");
  if (current) current.replaceWith(next);
  else row.append(next);
}

function rsMetaFromForm() {
  const meta = normalizeMetadata(S.state.metadata || {});
  meta.title = ($("rsTitle").value || "").trim();
  meta.artist = ($("rsArtist").value || "").trim();
  meta.album = ($("rsAlbum").value || "").trim();
  meta.year = ($("rsYear").value || "").trim();
  return meta;
}

// Failure is a dot, not red text (rule 8), so this is a class rather than an
// inline colour — and the colour it used to set, --danger, has never been a
// token in this system, so the line was rendering at its ordinary --label
// either way.
function setRsStatus(msg, error = false) {
  const el = $("rsExportStatus");
  el.textContent = msg || "";
  el.hidden = !msg;
  el.classList.toggle("error", !!msg && error);
}

function renderRsCover(meta) {
  const thumb = $("rsCoverThumb"), title = $("rsCoverTitle"), sub = $("rsCoverSub"), clear = $("rsCoverClear");
  const has = !!meta.coverArtUrl;
  thumb.classList.toggle("has-cover", has);
  thumb.replaceChildren();
  // .src takes a URL, so an image whose name or address contains quotes or
  // angle brackets can't close the attribute and inject markup.
  if (has) { const img = document.createElement("img"); img.src = meta.coverArtUrl; img.alt = ""; thumb.append(img); }
  title.textContent = has ? (meta.coverArtName || "Cover art") : "Choose image";
  sub.textContent = "";   // rule 24: optional is silent; the title carries the name
  clear.hidden = !has;
}

// Rule 24: a warning is a triangle with its sentence in the tooltip, on a
// wrapping span — `title` on an <svg> is inert without a <title> child, and an
// aria-hidden svg would leave the mark with no accessible name either.
const OFF_REASON = "Tablature is off for this note layer. Check it to export anyway.";
const WARN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17.5v.01"/></svg>`;

// Lanes shown in the currently-open export dialog, indexed by rs-arr-row
// dataset.track. Includes layers with tablature off (shown but unchecked) so
// the user can see and override that per-layer setting instead of the lane
// silently disappearing from the picker.
let rsModalLanes = [];

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
    // Rule 25: the count is written the way the edit lanes write it — the app's
    // glyph plus a tabular number — so counts line up down the list.
    const count = row.querySelector(".count");
    count.textContent = String(notes.length);
    count.title = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
    row.querySelector(".rs-arr-kind").addEventListener("change", () =>
      updateRsTuningSelect(row, rsTuningFromSelect(row.querySelector(".rs-arr-tuning"))));
    updateRsTuningSelect(row, row._trackTuning);
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
          : "Linux export needs oggenc (vorbis-tools) and wav2wem on PATH.")
      : "Wwise isn't installed. Rocksmith audio can't be converted without it.";
    const link = $("rsWwiseGet");
    link.href = linux ? "https://github.com/pas2k/wav2wem" : "https://www.audiokinetic.com/download/";
    link.textContent = linux ? "Get wav2wem" : "Get Wwise";
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
  renderRsCover(meta);
  renderRsArrangements(lanes);
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

export function exportRocksmith() {
  openRocksmithExportModal();
}

async function submitRocksmithExport() {
  if (!S.state) return;
  // Enter in a text field submits a form whether or not its submit button is
  // disabled, so the check guards the work as well as the button.
  if (!converterOk) return;
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
    picks.push({ lane, kind, tuning });
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
  spec.rocksmith = { arrangements: picks.map((p, i) => ({ track: i, kind: p.kind, tuning: p.tuning })) };

  $("rsExportGo").disabled = true;
  setRsStatus("Building CDLC…");
  try {
    const res = await fetch(`/api/projects/${S.state.job}/rocksmith`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "CDLC build failed");
    const buf = await res.arrayBuffer();
    const cd = res.headers.get("Content-Disposition") || "";
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || "song_p.psarc";
    let warns = []; try { warns = JSON.parse(res.headers.get("X-Tab-Warnings") || "[]"); } catch { /* advisory only */ }
    downloadProjectBlob(new Blob([buf], { type: "application/octet-stream" }), name);
    closeRocksmithExportModal();
    toast(warns.length ? `Exported ${name} - ${warns.length} warning(s)` : `Exported ${name}`);
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
  $("rocksmithExportBackdrop").addEventListener("click", (e) => { if (e.target === $("rocksmithExportBackdrop")) closeRocksmithExportModal(); });
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
