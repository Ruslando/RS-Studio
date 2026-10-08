import { operationRequest } from "./operation-progress.js";
import { toast } from "./notify.js";
import { placeFloating } from "./floating-position.js";
// On-demand note detection: the per-stem model dropdown, the floating detect
// panel, running a detector over a whole stem or an Alt-dragged time frame, and
// merging the results into the active edit layer.
//
// Everything this file used to draw now lives in note-render.js.

import { confirmAppendBtn, confirmBackdrop, confirmCancelBtn, confirmMsgEl, confirmReplaceBtn, detectBtn, detectClose, detectModelSel, detectPanel, detectStatus, detectStemNameEl, detectTargetLayer } from "./dom.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { draw } from "./repaint.js";
import { commit, snapshotEdit } from "./edit.js";
import { currentGridState, FINE_SUBDIV, gridAt, quantizeFine, segBeatSec, segStep, setSubdiv, snapNote } from "./grid.js";
import { confirmChoice } from "./dialog.js";
import { nid } from "./ids.js";
import { S, setSelection } from "./store.js";
import { curStemObj, editLanes, refreshCounts, renderLanes, targetLane } from "./lanes.js";
import { fmtTime } from "./util.js";

// ---- on-demand detection (per stem) ----
let requiredModel = null;
let detectionEpoch = 0;
let completedDetections = 0;
let detecting = false;
let cancelMerge = null;
let cancelGridChoice = null;

const differsFromGrid = (note) => {
  const snapped = snapNote(note.start, note.end);
  return Math.abs(snapped.start - note.start) > 1e-6 || Math.abs(snapped.end - note.end) > 1e-6;
};

function needsFinerGrid(notes) {
  return notes.some((note) => {
    const seg = gridAt(note.start);
    return segStep(seg) > segBeatSec(seg) / FINE_SUBDIV + 1e-9 && differsFromGrid(note);
  });
}

function useFineGrid(notes) {
  for (const note of notes) {
    const seg = gridAt(note.start);
    if (segStep(seg) <= segBeatSec(seg) / FINE_SUBDIV + 1e-9) continue;
    if (seg.ref) seg.ref.subdiv = FINE_SUBDIV;
    else setSubdiv(FINE_SUBDIV);
  }
  S.appliedGrid = currentGridState();
}

function updateDetectButton() {
  document.getElementById("detectButtonLabel").textContent = "Detect";
  detectBtn?.setAttribute("aria-busy", String(detecting));
  if (detectBtn) detectBtn.disabled = detecting ||
    !!detectModelSel?.selectedOptions[0]?.disabled ||
    (!!requiredModel && detectModelSel?.value !== requiredModel);
}

export function requireDetectModel(model = null) {
  requiredModel = model;
  if (model && [...(detectModelSel?.options || [])].some((option) => option.value === model))
    detectModelSel.value = model;
  updateDetectButton();
}

export const detectCompletionCount = () => completedDetections;

// Results from a step the reader has left must not write into restored state.
export function cancelPendingDetection() {
  detectionEpoch++;
  cancelMerge?.();
  cancelGridChoice?.abort();
  detecting = false;
  updateDetectButton();
}

async function loadDetectors() {
  if (!detectModelSel) return;
  try {
    const items = await (await fetch("/api/detectors")).json();
    detectModelSel.innerHTML = items
      .map((d) => `<option value="${d.id}" ${d.available ? "" : "disabled"}>${d.label}${d.available ? "" : " — unavailable"}</option>`).join("");
    if (requiredModel && [...detectModelSel.options].some((option) => option.value === requiredModel))
      detectModelSel.value = requiredModel;
    updateDetectButton();
  } catch { /* leave empty; Detect will no-op */ }
}

// Reflect what Detect will run on (whole stem, or the Alt-dragged frame) while
// idle. Result/error text overwrites this until the next frame change.
export function updateDetectStatus() {
  if (detectStatus) detectStatus.textContent = S.detectRegion
    ? `range ${fmtTime(S.detectRegion.t0)}–${fmtTime(S.detectRegion.t1)}`
    : "whole stem";
  if (detectTargetLayer) {
    const lane = targetLane();
    detectTargetLayer.textContent = lane ? lane.name : "—";
    detectTargetLayer.parentElement?.style.setProperty("--chip-dot", lane?.color || "");
  }
}

// Ask whether detected notes should replace the notes already there or be appended
// alongside them. `scoped` is true for an Alt-dragged time frame (replace clears
// just the frame), false for a whole-lane detect (replace clears the whole lane).
// Resolves "replace" | "append" | null (cancel).
function confirmDetectMerge(count, laneName, scoped) {
  return new Promise((resolve) => {
    confirmMsgEl.textContent = scoped
      ? `The selected time frame already has ${count} note${count === 1 ? "" : "s"} in “${laneName}”.`
      : `“${laneName}” already has ${count} note${count === 1 ? "" : "s"}.`;
    confirmBackdrop.hidden = false;
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      if (cancelMerge === onCancel) cancelMerge = null;
      confirmBackdrop.hidden = true;
      confirmReplaceBtn.removeEventListener("click", onReplace);
      confirmAppendBtn.removeEventListener("click", onAppend);
      confirmCancelBtn.removeEventListener("click", onCancel);
      confirmBackdrop.removeEventListener("mousedown", onBackdrop);
      window.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onReplace = () => finish("replace");
    const onAppend = () => finish("append");
    const onCancel = () => finish(null);
    cancelMerge = onCancel;
    const onBackdrop = (e) => { if (e.target === confirmBackdrop) onCancel(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } };
    confirmReplaceBtn.addEventListener("click", onReplace);
    confirmAppendBtn.addEventListener("click", onAppend);
    confirmCancelBtn.addEventListener("click", onCancel);
    confirmBackdrop.addEventListener("mousedown", onBackdrop);
    window.addEventListener("keydown", onKey, true);   // capture so it beats the global Esc handlers
    confirmReplaceBtn.focus();
  });
}

// A note counts as "in the frame" if its span overlaps it at all — so the merge
// prompt fires (and Replace clears) for anything visibly inside the band.
export const inFrame = (n, r) => n.start < r.t1 && n.end > r.t0;

async function runDetect() {
  if (!S.state || !detectModelSel.value ||
      detectModelSel.selectedOptions[0]?.disabled ||
      (requiredModel && detectModelSel.value !== requiredModel)) return;
  const epoch = ++detectionEpoch;
  // Detection can take a while; the user may open a different project — or delete
  // the target layer — before the response lands. `lane` and the status line
  // belong to THIS project and THIS layer, so every await below re-checks both.
  // Only the Detect button is disabled during the request; the layer list stays
  // live, and writing into a removed layer loses the notes while reporting
  // success.
  const state = S.state;
  const lane = targetLane();
  if (!lane) { detectStatus.textContent = "no note layer"; return; }
  const stillTargeting = () => S.state === state && editLanes().includes(lane);
  const model = detectModelSel.value, stemId = state.curStem;
  const region = S.detectRegion;   // snapshot — the band may be cleared mid-request
  detecting = true;
  closeDetectPanel();
  updateDetectButton();
  try {
    // If the target layer already holds notes (inside the frame, or anywhere when
    // detecting the whole lane), ask how to merge instead of silently appending.
    let mergeMode = "append";
    const existing = region
      ? lane.notes.filter((n) => inFrame(n, region)).length
      : lane.notes.length;
    if (existing) {
      mergeMode = await confirmDetectMerge(existing, lane.name, !!region);
      if (epoch !== detectionEpoch) return;
      if (mergeMode === null) { detectStatus.textContent = "cancelled"; return; }
      if (!stillTargeting()) return;
    }
    detectStatus.textContent = region ? "detecting range…" : "detecting…";
    const body = { job: state.job, stem: stemId, model };
    if (region) { body.start = region.t0; body.end = region.t1; }
    const modelName = detectModelSel.selectedOptions[0]?.textContent || model;
    const sourceName = curStemObj()?.name || stemId;
    const data = await operationRequest("/api/detect", body,
      "Detecting notes", `${modelName} · ${sourceName} → ${lane.name}`);
    if (data.warning) toast(data.warning, 6000, "warn");
    if (epoch !== detectionEpoch || !stillTargeting()) return;
    // Drop the detected notes straight into the active edit lane as editable
    // notes (fresh ids, like a manual trace/paste) — undo-committed and left
    // selected. Appended notes that overlap existing ones stay put and get
    // flagged as a stack (no auto-merge).
    let added = (data.notes || []).map((n) => ({
      ...n, ...quantizeFine(n.start, n.end), id: nid(),
    }));
    let gridChoice = "current";
    if (needsFinerGrid(added)) {
      const controller = new AbortController();
      cancelGridChoice = controller;
      try {
        gridChoice = await confirmChoice({
          title: "Detected notes use a finer grid",
          message: "Note detection uses a finer 1/32 grid by default. Switch the affected grid sections to 1/32 to preserve the detected timing, or adjust the notes to the current grid.",
          confirmLabel: "Use 1/32 grid",
          alternativeLabel: "Adjust notes to current grid",
          cancelLabel: "Cancel detection",
          signal: controller.signal,
        });
      } finally {
        if (cancelGridChoice === controller) cancelGridChoice = null;
      }
      if (epoch !== detectionEpoch || !stillTargeting()) return;
      if (gridChoice === "cancel") { detectStatus.textContent = "cancelled"; return; }
    }
    if (added.length) {
      const prev = snapshotEdit();
      if (gridChoice === "confirm") useFineGrid(added);
      else added = added.map((note) => ({ ...note, ...snapNote(note.start, note.end) }));
      const wasEmpty = lane.notes.length === 0;
      // Replace clears the frame's notes (scoped detect) or the whole lane (full detect).
      if (mergeMode === "replace") lane.notes = region ? lane.notes.filter((n) => !inFrame(n, region)) : [];
      lane.notes.push(...added);
      // A fresh Kong piano transcription is a MIDI/reference layer by default.
      // The user can explicitly opt it into the tablature pipeline afterwards.
      if (model === "piano" && wasEmpty) lane.tablatureEnabled = false;
      commit(prev);
      setSelection(new Set(added));
      S.state.lanes.forEach((l) => (l.active = l === lane));
      renderLanes(); refreshCounts(); draw();
    }
    detectStatus.textContent = (added.length
      ? `${mergeMode === "replace" ? "replaced → " : "+"}${added.length} note${added.length === 1 ? "" : "s"} → “${lane.name}”`
      : "no notes found" + (region ? " in range" : "")) +
      (data.warning ? ` · ⚠ ${data.warning}` : "");
    completedDetections++;
  } catch (e) {
    if (epoch === detectionEpoch && S.state === state)
      detectStatus.textContent = e.cancelled ? "detection cancelled" : "detection failed: " + e.message;
  } finally {
    if (epoch === detectionEpoch) {
      detecting = false;
      updateDetectButton();
    }
  }
}

// ---- detect panel (floating popover: opened by right-click or the Frame tool) ----


function detectPanelOpen() { return detectPanel && !detectPanel.hidden; }

function closeDetectPanel() {
  if (detectPanel) detectPanel.hidden = true;
  document.removeEventListener("mousedown", detectPanelOutside, true);
}

function detectPanelOutside(e) {
  // Answering a child dialog or navigating the walkthrough is not a click
  // outside this workflow. Closing here also moves the tour card mid-click.
  if (e.target.closest?.(".tour-card, #actionConfirmBackdrop, #confirmBackdrop")) return;
  if (detectPanelOpen() && !detectPanel.contains(e.target)) closeDetectPanel();
}

export function openDetectPanel(clientX, clientY) {
  if (!detectPanel || !S.state) return;
  if (detectStemNameEl) detectStemNameEl.textContent = curStemObj() ? curStemObj().name : S.state.curStem;
  updateDetectStatus();
  detectPanel.hidden = false;
  // Clamp into the viewport near the click.
  placeFloating(detectPanel, clientX, clientY, 0);
  setTimeout(() => document.addEventListener("mousedown", detectPanelOutside, true), 0);
}

export function init_detect() {
  registerEscapeLayer(ESC_DEPTH.panel, () => {
    if (!detectPanelOpen()) return false;
    closeDetectPanel(); return true;
  });
  if (detectBtn) detectBtn.addEventListener("click", () => { runDetect(); });
  detectModelSel?.addEventListener("change", updateDetectButton);
  loadDetectors();
  detectClose?.addEventListener("click", closeDetectPanel);
}
