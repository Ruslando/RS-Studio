// Rocksmith CDLC export UI: the arrangement picker, the metadata form and the
// POST that builds the .psarc. The File-menu entry is wired in ui.js with the
// other exports.

import { $ } from "./dom.js";
import { MAX_CAPO, editLanes } from "./lanes.js";
import { RS_KIND_OPTIONS, defaultRsKind, isTablatureLane, laneScrollSpeed } from "./layer-role.js";
import { nameExportChords } from "./chord-names.js";
import { applyCoverChange, clearProjectCover, coverStatus, exportSongName, latinFields, metadataFromState, metadataPayload, normalizeMetadata, uploadDroppedProjectCover, uploadProjectCover } from "./metadata.js";
import { icon } from "./icons.js";
import { downloadProjectBlob, toast } from "./notify.js";
import { jobRequest } from "./operation-progress.js";
import { S } from "./store.js";
import { markerArtifacts } from "./marker-artifacts.js";
import { adjacentMarkerTime } from "./marker-navigation-core.js";
import { createOverview } from "./overview.js";
import { matchKey } from "./keymap.js";
import { togglePlay, transportPlaying } from "./playback.js";
import { rememberPref } from "./util.js";
import { rocksmithIssueCodes } from "./rocksmith-check.js";
import { TUNINGS, buildSpecForLanesAsync, customTunings, laneTuning, parseTuning, tuningToNames } from "./tablature.js";

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

const rsLatin = latinFields({ title: "rsTitle", artist: "rsArtist", album: "rsAlbum" });

function rsMetaFromForm() {
  const meta = normalizeMetadata(S.state.metadata || {});
  meta.title = ($("rsTitle").value || "").trim();
  meta.artist = ($("rsArtist").value || "").trim();
  meta.album = ($("rsAlbum").value || "").trim();
  meta.year = ($("rsYear").value || "").trim();
  rsLatin.read(meta);
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
const WARN_ICON = icon("warning", 14);

// Lanes shown in the currently-open export dialog, indexed by rs-arr-row
// dataset.track. Includes layers with tablature off (shown but unchecked) so
// the user can see and override that per-layer setting instead of the lane
// silently disappearing from the picker.
let rsModalLanes = [];

function renderRsArrangements(lanes) {
  const wrap = $("rsArrangements");
  // Every layer's own arrangement is spoken for before a layer without one is given a free one.
  const used = new Set(lanes.map((lane) => lane.rocksmithArrangement));
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

// ---- Preview clip ----
// A start in the song's audio and a length, like DLC Builder's preview (28 s,
// 2.5 s fade-in, 3 s fade-out). The server clamps the same way.
//
// The strip is the editor's overview (overview.js) with the clip as its window
// and a playhead of its own: click, drag or type a time to move it, Play from
// there (Space too, while this window is open), and "Start here" to put the
// clip at it. Dragging the clip moves it.
const PREVIEW_DEFAULT = 28, PREVIEW_MIN = 5, PREVIEW_MAX = 30, FADE_IN = 2.5, FADE_OUT = 3;
const PREVIEW_MAP_H = 64;
let clip = { start: 0, length: PREVIEW_DEFAULT }, songLength = 0, playT = 0;
let previewAudio = null, previewFrame = 0, previewImage = null, previewOverview = null;

const mixStem = () => S.state?.stems?.find((s) => s.id === "mix") || S.state?.stems?.[0] || null;
const previewEnd = () => Math.min(songLength, clip.start + clip.length);
const previewPlaying = () => !!previewAudio && !previewAudio.paused;
const inClip = (t) => t >= clip.start && t <= previewEnd();

// The playhead goes back to the clip's start with every change; playing, the
// clip plays again from there. `live` (while dragging) only moves the playhead.
function setClip(start, length = clip.length, live = false) {
  length = Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, Math.round(length * 10) / 10));
  start = Math.max(0, Math.min(Math.max(0, songLength - length), start));
  clip = { start: Math.round(start * 10) / 10, length };
  $("rsPreviewStart").value = clip.start.toFixed(1);
  $("rsPreviewLength").value = String(clip.length);
  if (live) setPlayhead(clip.start);
  else seekPreview(clip.start);
}

function setPlayhead(t) {
  playT = Math.max(0, Math.min(songLength, t));
  previewOverview?.draw();
  // As the editor's buttons (renderMarkerArtifacts): off with no marker that way.
  const markers = previewMarkers();
  $("rsPreviewPrev").disabled = adjacentMarkerTime(markers, playT, -1, songLength) === null;
  $("rsPreviewNext").disabled = adjacentMarkerTime(markers, playT, 1, songLength) === null;
}

// Song sections, phrases, tone switches and tempo flags: places a preview tends
// to start well. Hand anchors are left out; they mark the hand, not the music.
const previewMarkers = () => markerArtifacts().filter((m) => m.kind !== "anchor" && m.t < songLength);

// DLC Builder's default: the first chorus, else the middle of the song.
function defaultStart() {
  const chorus = (S.state.sectionMarkers || []).find((m) => String(m.sectionType || "").startsWith("chorus"));
  return chorus ? Number(chorus.t) : songLength / 2 - PREVIEW_DEFAULT / 2;
}

function stopPreview() {
  cancelAnimationFrame(previewFrame);
  if (previewAudio) previewAudio.pause();
  $("rsPreviewPlay").setAttribute("aria-pressed", "false");
}

// From the playhead. Started inside the clip, it plays the clip as Rocksmith
// will, fades included, and returns to the clip's start; outside, it plays on.
function playPreview() {
  if (previewPlaying()) { stopPreview(); return; }
  const stem = mixStem();
  if (!stem?.audioUrl) return;
  if (!previewAudio || previewAudio.dataset.src !== stem.audioUrl) {
    previewAudio = new Audio(stem.audioUrl);
    previewAudio.dataset.src = stem.audioUrl;
  }
  playsClip = startsClip(playT);
  previewAudio.currentTime = playT;
  previewAudio.volume = previewGain(playT);
  previewAudio.play().catch(stopPreview);
  $("rsPreviewPlay").setAttribute("aria-pressed", "true");
  const tick = () => {
    const t = previewAudio.currentTime;
    if (previewAudio.paused || previewAudio.ended) { stopPreview(); return; }
    if (playsClip && t >= previewEnd()) { stopPreview(); setPlayhead(clip.start); return; }
    previewAudio.volume = previewGain(t);
    setPlayhead(t);
    previewFrame = requestAnimationFrame(tick);
  };
  previewFrame = requestAnimationFrame(tick);
}

// Started inside the clip, playback is the clip with its fades; outside, the song.
let playsClip = false;
const startsClip = (t) => t >= clip.start && t < previewEnd() - 0.05;
function previewGain(t) {
  if (!playsClip) return 1;
  const start = clip.start, end = previewEnd(), len = end - start;
  const short = len < FADE_IN + FADE_OUT, fadeIn = short ? len / 2 : FADE_IN, fadeOut = short ? len / 2 : FADE_OUT;
  return Math.max(0, Math.min(1, (t - start) / fadeIn, (end - t) / fadeOut));
}

// Like the editor's seekPlayback: while playing, the audio moves with the
// playhead and keeps playing from there, scrubbing included.
function seekPreview(t) {
  setPlayhead(t);
  if (!previewPlaying()) return;
  playsClip = startsClip(playT);
  previewAudio.currentTime = playT;
  previewAudio.volume = previewGain(playT);
}

// The editor's marker jump (marker-artifacts.js navigateMarker): from the
// playhead to the next marker, and the clip starts there. The playhead stays on
// the marker itself, so the next jump goes on from it even where the clip had
// to be rounded or pulled back from the song's end.
function jumpPreview(direction) {
  const t = adjacentMarkerTime(previewMarkers(), playT, direction, songLength);
  if (t === null) return;
  setClip(t, clip.length, true);
  seekPreview(t);
}

function renderPreviewClip() {
  const stem = mixStem();
  songLength = Number(stem?.spec?.duration) || Number(S.state.duration) || 0;
  // A score without audio has no clip to choose; the export refuses it anyway.
  $("rsPreviewOverview").closest(".section").hidden = !stem || songLength < PREVIEW_MIN;
  if (!stem || songLength < PREVIEW_MIN) return;
  if (transportPlaying()) togglePlay();     // one song playing at a time
  $("rsPreviewStart").max = songLength.toFixed(1);
  previewImage = null;
  if (stem.spec?.url) {
    previewImage = new Image();
    previewImage.onload = () => previewOverview.draw();
    previewImage.src = stem.spec.url;
  }
  const saved = S.state.metadata?.rocksmith || {};
  setClip(Number.isFinite(saved.previewStart) ? saved.previewStart : defaultStart(),
    Number.isFinite(saved.previewLength) ? saved.previewLength : PREVIEW_DEFAULT);
}

function initPreviewClip() {
  previewOverview = createOverview({
    ruler: $("rsPreviewRuler"), map: $("rsPreviewMap"),
    time: { root: $("rsPreviewTime"), button: $("rsPreviewTimeLabel"), input: $("rsPreviewTimeInput") },
    getTime: () => playT, getDuration: () => songLength, getImage: () => previewImage,
    seek: (t, phase) => { if (phase !== "end") seekPreview(t); },
    frame: () => ({ t0: clip.start, t1: previewEnd(), y0: 0, y1: 1 }),
    bodyCursor: (t) => (inClip(t) ? "grab" : "pointer"),
    // Pressed on the clip, a drag moves it and a click seeks; elsewhere it scrubs.
    bodyDown: (t0) => {
      if (!inClip(t0)) return null;
      const base = clip.start;
      let resume = false;
      return {
        move: (t, moved) => {
          if (!moved) return;
          if (previewPlaying()) { resume = true; stopPreview(); }
          setClip(base + t - t0, clip.length, true);
        },
        up: (t, moved) => {
          if (!moved) seekPreview(t0);
          else if (resume) playPreview();
        },
      };
    },
  });
  // The dialog is hidden until opened, so the canvases are sized once it shows.
  new ResizeObserver(() => { previewOverview.fit(PREVIEW_MAP_H); previewOverview.draw(); }).observe($("rsPreviewOverview"));
  window.addEventListener("cw-intensity-status", () => previewOverview.draw());
  $("rsPreviewStart").addEventListener("change", () => setClip(Number($("rsPreviewStart").value) || 0));
  $("rsPreviewLength").addEventListener("change", () => setClip(clip.start, Number($("rsPreviewLength").value) || PREVIEW_DEFAULT));
  // The editor's buttons give the focus up after a jump, so Space plays rather
  // than jumping again; here it goes back to the window, whose Space plays.
  for (const [id, direction] of [["rsPreviewPrev", -1], ["rsPreviewNext", 1]]) {
    $(id).addEventListener("click", () => {
      jumpPreview(direction);
      $("rocksmithExportModal").focus({ preventScroll: true });
    });
  }
  $("rsPreviewHere").addEventListener("click", () => setClip(playT));
  $("rsPreviewPlay").addEventListener("click", playPreview);
  // This window's own Space: the preview, not the song behind it. A focused
  // button keeps Space as its click, and a text field keeps it as a character.
  $("rocksmithExportModal").addEventListener("keydown", (e) => {
    // Ctrl+←/→ jumps between markers, as in the editor (edit.js), outside fields.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && ["ArrowLeft", "ArrowRight"].includes(e.key)
        && !e.target.closest("input, select, textarea") && !$("rsPreviewOverview").closest(".section").hidden) {
      e.preventDefault();
      jumpPreview(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (!matchKey(e, "playPause") || e.target.closest("button, select, textarea, input[type=text], input:not([type])")) return;
    e.preventDefault();
    if ($("rsPreviewOverview").closest(".section").hidden) return;
    playPreview();
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
  renderPreviewClip();
  $("rsLeadIn").value = String(leadIn(localStorage.getItem(LS_LEAD_IN)));
  try { $("rsAuthor").value = localStorage.getItem(LS_AUTHOR) || ""; } catch { /* storage blocked: empty */ }
  try { $("rsDynamicDifficulty").checked = localStorage.getItem(LS_DD) !== "0"; } catch { /* storage blocked: on */ }
  try { $("rsValidate").checked = localStorage.getItem(LS_VALIDATE) !== "0"; } catch { /* storage blocked: on */ }
  rsIgnored = new Set(meta.rocksmith?.ignoredIssues || []);
  renderRsIssues();
  setRsStatus("");
  converterOk = false;
  $("rsExportGo").disabled = true;
  $("rsWwiseGet").hidden = false;
  checkAudioConverter();
  $("rocksmithExportBackdrop").hidden = false;
  // The window itself, not the title: Space then plays the preview right away.
  $("rocksmithExportModal").focus({ preventScroll: true });
}

function closeRocksmithExportModal() {
  stopPreview();
  $("rocksmithExportBackdrop").hidden = true;
}

// Upload, drop and clear differ only in which metadata call they make and what
// they say afterwards. The shared part is the bit that is easy to get wrong:
// the text fields are read from the form FIRST, so a cover change does not
// discard a title the user has typed but not yet exported with.
async function applyRsCover(working, done, run) {
  if (!S.state) return;
  const meta = await applyCoverChange(rsMetaFromForm(), () => run(S.state.job), coverStatus($("rsCoverDrop"), setRsStatus), working, done);
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
const LS_LEAD_IN = "cw.rsLeadIn", LEAD_IN_DEFAULT = 10;
// The charter's name for toolkit.version, like DLC Builder's "Charter name": one per user.
const LS_AUTHOR = "cw.rsAuthor";
// Difficulty levels on or off, on unless turned off; one setting for every export.
const LS_DD = "cw.rsDynamicDifficulty";
// Stop on issues, as DLC Builder's "Validate before release build": on unless turned off.
const LS_VALIDATE = "cw.rsValidate";

// Codes this song exports past, as DLC Builder's IgnoredIssues: kept with the
// song's details, also for codes the chart no longer has.
let rsIgnored = new Set();

const rsPickedLaneIds = () => [...$("rsArrangements").querySelectorAll(".rs-arr-row")]
  .filter((row) => row.querySelector(".rs-arr-on").checked)
  .map((row) => rsModalLanes[parseInt(row.dataset.track, 10)]?.id);

// The live check's issues of the ticked layers, each code with an Ignore box.
function renderRsIssues() {
  const box = $("rsIssues");
  const codes = rocksmithIssueCodes(rsPickedLaneIds());
  box.replaceChildren(...[...codes].sort(([a], [b]) => a.localeCompare(b)).map(([code, { title, count }]) => {
    const label = document.createElement("label");
    label.className = "chk";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rsIgnored.has(code);
    input.addEventListener("change", () => { if (input.checked) rsIgnored.add(code); else rsIgnored.delete(code); });
    label.append(input, ` Ignore ${code}: ${title}${count > 1 ? ` (${count}×)` : ""}`);
    return label;
  }));
  if (!codes.size) box.textContent = "No issues found.";
}

// The checked codes neither fixed nor ignored; empty with the check turned off.
const rsOpenIssues = () => !$("rsValidate").checked ? []
  : [...rocksmithIssueCodes(rsPickedLaneIds()).keys()].filter((code) => !rsIgnored.has(code));
function leadIn(raw) {
  const value = raw === null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : LEAD_IN_DEFAULT;
}

// The leading silence the next export will use: the live check times its
// issues the same way (a first note needs an empty first phrase before it).
export function rsLeadIn() {
  let stored = null;
  try { stored = localStorage.getItem(LS_LEAD_IN); } catch { /* storage blocked: the default */ }
  return leadIn(stored);
}

export function exportRocksmith() {
  openRocksmithExportModal();
}

let exporting = false;

async function submitRocksmithExport() {
  if (!S.state || exporting) return;
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
  const open = rsOpenIssues();
  if (open.length) {
    setRsStatus(`Fix or ignore the issues first (${open.join(", ")}), or turn off Stop on issues.`, true);
    return;
  }

  const meta = rsMetaFromForm();
  meta.rocksmith = { previewStart: clip.start, previewLength: clip.length, ignoredIssues: [...rsIgnored].sort() };
  S.state.metadata = { ...normalizeMetadata(S.state.metadata || {}), ...meta };
  const leadingSilence = leadIn($("rsLeadIn").value);
  rememberPref(LS_LEAD_IN, leadingSilence);
  const author = $("rsAuthor").value.trim();
  rememberPref(LS_AUTHOR, author);
  const dynamicDifficulty = $("rsDynamicDifficulty").checked;
  rememberPref(LS_DD, dynamicDifficulty ? "1" : "0");
  const validate = $("rsValidate").checked;
  rememberPref(LS_VALIDATE, validate ? "1" : "0");
  // A whole number from 1; anything else falls back to 1 (the server checks again).
  const version = Math.max(1, Math.floor(Number($("rsVersion").value)) || 1);
  $("rsVersion").value = String(version);
  const state = S.state, songName = exportSongName(meta, state.name || state.filename || "song");

  // A job, not a wait in a window (design.md 4.17): the form has been read, so the
  // window closes and the build runs in the progress panel while the editor stays
  // usable. What was typed is in the project's details, so reopening the window
  // after a failure finds it again.
  exporting = true;
  closeRocksmithExportModal();
  try {
    await jobRequest("Exporting Rocksmith CDLC", songName, async (panel) => {
      panel.update({ stage: "Calculating fingerings", fraction: null });
      // Rocksmith is independent of eye visibility and note count: the picker
      // decides what to voice, including layers with tablature switched off if
      // the user ticked them.
      const spec = await buildSpecForLanesAsync(picks.map((p) => p.lane));
      // The chord names the editor shows, the user's own included, are the ones the game shows.
      spec.tracks.forEach((track, i) => nameExportChords(picks[i].lane, track.notes));
      spec.name = songName;
      spec.metadata = metadataPayload(state.metadata);
      spec.rocksmith = { arrangements: picks.map((p, i) => ({ track: i, kind: p.kind, tuning: p.tuning, capo: p.capo, scrollSpeed: laneScrollSpeed(p.lane),
        bassPicked: p.kind.includes("bass") && !!p.lane.bassPicked })), leadingSilence, version, author, dynamicDifficulty,
        validate, ignoredIssues: [...rsIgnored].sort(),
        preview: { start: clip.start, length: clip.length } };
      panel.update({ stage: "Building the package", fraction: null });
      const res = await fetch(`/api/projects/${state.job}/rocksmith`, {
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
      toast(warns.length ? `Exported ${name} - ${warns.length} warning(s)` : `Exported ${name}`, 2200, warns.length ? "warn" : "ok");
    });
  } catch { /* the panel's toast has said what failed */ } finally {
    exporting = false;
  }
}

export function init_rocksmith_export() {
  initPreviewClip();
  $("rocksmithExportForm").addEventListener("submit", (e) => { e.preventDefault(); submitRocksmithExport(); });
  $("rsExportClose").addEventListener("click", closeRocksmithExportModal);
  $("rsArrangements").addEventListener("change", renderRsIssues);
  window.addEventListener("cw-rocksmith-checked", () => { if (!$("rocksmithExportBackdrop").hidden) renderRsIssues(); });
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
