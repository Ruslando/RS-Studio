// Live grid input serialization, shared by the grid editor and timing switching.
// This module only touches controls/state; it does not import either controller.
import { bpmInput, offsetInput, subdivCustom, subdivCustomWrap, subdivSel, tsDenInput, tsNumInput } from "./dom.js";
import { S } from "./store.js";

export const gridBpm = () => parseFloat(bpmInput.value) || 0;

export const subdivValue = (select, custom) => (select.value === "custom"
  ? Math.max(1, parseInt(custom.value, 10) || 1)
  : parseInt(select.value, 10) || 1);

export const gridSubdiv = () => subdivValue(subdivSel, subdivCustom);

export const beatsPerBar = () => parseInt(tsNumInput.value, 10) || 4;

export const gridTsDen = () => parseInt(tsDenInput.value, 10) || 4;

export const gridOffset = () => parseFloat(offsetInput.value) || 0;

// Subdiv: a preset list of divisions-per-beat plus a "Custom..." free entry.
const SUBDIV_PRESETS = new Set(["1", "2", "3", "4", "6", "8"]);

export function syncSubdivControls(select, custom, wrap) {
  wrap.hidden = select.value !== "custom";
}

export function setSubdivControls(select, custom, wrap, value) {
  const v = String(Math.max(1, parseInt(value, 10) || 1));
  if (SUBDIV_PRESETS.has(v)) {
    select.value = v;
  } else {
    select.value = "custom";
    custom.value = v;
  }
  syncSubdivControls(select, custom, wrap);
}

export const syncSubdivCustom = () => syncSubdivControls(subdivSel, subdivCustom, subdivCustomWrap);

export const setSubdiv = (value) => setSubdivControls(subdivSel, subdivCustom, subdivCustomWrap, value);

export function currentGridState() {
  return {
    bpm: gridBpm(),
    offset: gridOffset(),
    subdiv: gridSubdiv(),
    tsNum: beatsPerBar(),
    tsDen: parseInt(tsDenInput.value, 10) || 4,
  };
}

function copyGridState(g) {
  return {
    bpm: +g.bpm || 0,
    offset: +g.offset || 0,
    subdiv: Math.max(1, parseInt(g.subdiv, 10) || 1),
    tsNum: parseInt(g.tsNum, 10) || 4,
    tsDen: parseInt(g.tsDen, 10) || 4,
  };
}

export function restoreGridState(g) {
  const grid = copyGridState(g);
  bpmInput.value = grid.bpm || "";
  offsetInput.value = grid.offset.toFixed(3);
  setSubdiv(grid.subdiv);
  tsNumInput.value = grid.tsNum;
  tsDenInput.value = String(grid.tsDen);
  S.appliedOffset = grid.offset;
  S.appliedGrid = currentGridState();
}


// Label of the current grid subdivision (e.g. "1/8", "1/16T", "5/beat").
export function gridDivLabelFor(value) {
  const v = String(value);
  const labels = { "1": "1/4", "2": "1/8", "3": "1/8T", "4": "1/16", "6": "1/16T", "8": "1/32" };
  return labels[v] || `${parseInt(v, 10) || 1}/beat`;
}

