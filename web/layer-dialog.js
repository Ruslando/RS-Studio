// Layer form controls and live-edit staging. The entry point supplies the
// lane renderer and tuning-manager navigation, so this view imports neither UI
// controller nor lane controller back into the graph.
import { $ } from "./dom.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { snapshotInputs, revertInputs, inputsDirty } from "./settings-inputs.js";

const layerSettingsBackdrop = $("layerSettingsBackdrop"), settingsClose = $("settingsClose");

export const layerName = $("layerName"), layerColor = $("layerColor");

export const layerInstr = $("layerInstr"), layerTun = $("layerTun"), layerCapo = $("layerCapo"), layerArrangement = $("layerArrangement"), layerOwnTempo = $("layerOwnTempo"), layerOwnSections = $("layerOwnSections"), layerScrollSpeed = $("layerScrollSpeed"), layerBassPicked = $("layerBassPicked");
export const spLayerName = $("spLayerName");

export const layerVolume = $("layerVolume"), layerVolumeValue = $("layerVolumeValue");

export const layerDeleteBtn = $("layerDelete");

// Staged the same way the settings modal is: the layer's fields repaint the
// stage as you touch them, so Cancel walks them back rather than deferring them.
let layerSnapshot = null;
let layerActions = null;
export function openLayerSettings(actions = null) {
  layerActions = actions;
  $("layerSave").textContent = actions ? "Create" : "Apply";
  $("settingsPanel").setAttribute("aria-label", actions ? "Add note layer" : "Edit note layer");
  services.renderLayerSettings();
  layerSettingsBackdrop.hidden = false;
  layerSnapshot = snapshotInputs($("settingsPanel"));
  syncLayerActions();
}
function syncLayerActions() { $("layerSave").hidden = !layerActions && !inputsDirty(layerSnapshot); }

export function closeLayerSettings() {
  const actions = layerActions;
  layerActions = null; layerSnapshot = null; layerSettingsBackdrop.hidden = true;
  actions?.save();
}
function cancelLayerSettings() {
  revertInputs(layerSnapshot); layerSnapshot = null;
  layerSettingsBackdrop.hidden = true;
  const actions = layerActions;
  layerActions = null;
  actions?.cancel();
}

// Tunings live in Settings. A layer's "Manage tunings…" opens that page with the
// layer's tuning selected.
export function openTuningManager(selectKey) { services.openTunings(selectKey); }

let services;
export function initLayerDialog(dependencies) {
  services = dependencies;
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if (layerSettingsBackdrop.hidden) return false;
    cancelLayerSettings(); return true;
  });
  settingsClose.addEventListener("click", cancelLayerSettings);
  $("layerSave").addEventListener("click", () => {
    if (layerActions) { closeLayerSettings(); return; }
    layerSnapshot = snapshotInputs($("settingsPanel")); syncLayerActions();
  });
  for (const type of ["input", "change", "click"])
    $("settingsPanel").addEventListener(type, () => queueMicrotask(syncLayerActions));
}
