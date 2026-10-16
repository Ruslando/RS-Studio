// Project references, indexed directly from their persisted capture boxes.
import { $, audio, scroll } from "./dom.js";
import { xOf, yOf } from "./geometry.js";
import { activateLane, canEditLane, renderLanes } from "./lanes.js";
import { seekPlayback } from "./playback.js";
import { refreshSaveState } from "./project.js";
import { eachRefGroup, notesInBox } from "./references.js";
import { draw } from "./repaint.js";
import { S, setSelection } from "./store.js";
import { moveViewportTo } from "./viewport-motion.js";
import { initArtifactsPanel } from "./artifacts-panel.js";
import { paintArtifactPreviews, referencePreview, resetArtifactPreviews, stopArtifactPreview, stopArtifactPreviewFor, removeArtifactPreview } from "./artifact-preview.js";

import { openRefMenu } from "./edit.js";

const rows = new Map();
const collapsedReferences = new Set();
const disclosureIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function jumpToReference(lane, ref, index) {
  const group = lane.refBoxes?.[ref];
  if (!group || group.anchors[index] == null) return;
  stopArtifactPreview();
  const box = { t0: Math.max(0, group.anchors[index] + group.rt0),
    t1: Math.min(S.state.duration, group.anchors[index] + group.rt1), pLo: group.pLo, pHi: group.pHi };
  lane.visible = true;
  activateLane(lane);
  setSelection(new Set(notesInBox(box, lane.notes)));
  seekPlayback(box.t0);
  moveViewportTo(xOf(box.t0) - scroll.clientWidth * 0.2,
    yOf((box.pLo + box.pHi) / 2) - scroll.clientHeight / 2);
  renderLanes(); refreshSaveState(); draw();
}

export function renderArtifacts() {
  const list = $("artifactList");
  if (!list) return;
  const entries = [];
  if (S.state) eachRefGroup((lane, ref, group) => entries.push({ lane, ref, group }));
  entries.sort((a, b) => a.ref - b.ref);
  const liveKeys = new Set(entries.map(({lane, ref}) => `${lane.id}:${ref}`));
  for (const [key, row] of rows) if (!liveKeys.has(key)) {
    removeArtifactPreview(row.querySelector('.artifact-preview')); row.remove(); rows.delete(key);
  }
  if ($('artifactCount').textContent !== String(entries.length)) $('artifactCount').textContent = String(entries.length);
  $('artifactEmpty').hidden = entries.length > 0;
  for (const [order, { lane, ref }] of entries.entries()) {
    const rowKey = `${lane.id}:${ref}`;
    if (rows.has(rowKey)) {
      const row = rows.get(rowKey), detail = row.querySelector('.artifact-detail');
      if (detail.textContent !== lane.name) { detail.textContent = lane.name; detail.title = lane.name; }
      if (list.children[order] !== row) list.insertBefore(row, list.children[order] || null);
      continue;
    }
    const row = document.createElement("li"); row.className = "artifact-row";
    const head = document.createElement("div"); head.className = "artifact-row-head";
    const copy = document.createElement("div"); copy.className = "artifact-copy";
    const name = document.createElement("span"); name.className = "artifact-name"; name.textContent = `Reference #${ref}`;
    const detail = document.createElement("span"); detail.className = "artifact-detail"; detail.textContent = lane.name; detail.title = lane.name;
    const key = `${lane.id}:${ref}`;
    row.dataset.reference = String(ref);
    const toggle = document.createElement('button'); toggle.type = 'button';
    toggle.className = 'icon-btn icon-btn--compact artifact-reference-toggle';
    toggle.innerHTML = disclosureIcon;
    toggle.title = `Collapse reference #${ref}`; toggle.setAttribute('aria-label', toggle.title);
    copy.append(name, detail); head.append(toggle, copy); row.append(head);
    const occurrences = referencePreview(lane, ref, index => jumpToReference(lane, ref, index));
    occurrences.id = `artifact-occurrences-${lane.id}-${ref}`;
    toggle.setAttribute('aria-controls', occurrences.id);
    const syncCollapse = () => {
      const collapsed = collapsedReferences.has(key);
      occurrences.hidden = collapsed;
      if (collapsed) stopArtifactPreviewFor(occurrences);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.title = `${collapsed ? 'Expand' : 'Collapse'} reference #${ref}`;
      toggle.setAttribute('aria-label', toggle.title);
    };
    toggle.addEventListener('click', () => {
      if (collapsedReferences.has(key)) collapsedReferences.delete(key); else collapsedReferences.add(key);
      syncCollapse();
    });
    syncCollapse();
    row.addEventListener('contextmenu', event => {
      event.preventDefault(); event.stopPropagation(); stopArtifactPreview();
      const currentLane = S.state?.editLanes.find(item => item.id === lane.id);
      const group = currentLane?.refBoxes?.[ref];
      if (!group?.anchors?.length || !canEditLane(currentLane)) return;
      const ordered = group.anchors.map((anchor, index) => ({anchor, index})).sort((a,b) => a.anchor-b.anchor);
      const position = Math.min(Number(occurrences.dataset.instance || 1) - 1, ordered.length - 1);
      const {anchor, index} = ordered[position];
      const box = {t0: Math.max(0, anchor + group.rt0), t1: Math.min(S.state.duration, anchor + group.rt1), pLo: group.pLo, pHi: group.pHi};
      activateLane(currentLane); setSelection(new Set(notesInBox(box, currentLane.notes))); draw();
      openRefMenu(event.clientX, event.clientY, {lane: currentLane, group, ref, i: index});
    });
    row.append(occurrences); rows.set(rowKey, row);
    list.insertBefore(row, list.children[order] || null);
  }
  paintArtifactPreviews();
}

export function init_artifacts() {
  initArtifactsPanel();
  $('artifactReferencesToggle').addEventListener('click', () => {
    const button = $('artifactReferencesToggle'), body = $('artifactReferencesBody');
    body.hidden = !body.hidden;
    if (body.hidden) stopArtifactPreview();
    button.setAttribute('aria-expanded', String(!body.hidden));
    button.title = `${body.hidden ? 'Expand' : 'Collapse'} references`;
    button.setAttribute('aria-label', button.title);
  });
  audio.addEventListener("play", stopArtifactPreview);
  window.addEventListener("cw-transport", event => { if (event.detail === "play") stopArtifactPreview(); });
  const clear = () => {
    resetArtifactPreviews(true); rows.clear(); collapsedReferences.clear(); $('artifactList').replaceChildren();
  };
  window.addEventListener('cw-project-opened', () => { clear(); renderArtifacts(); });
  window.addEventListener('cw-project-closed', clear);
  window.addEventListener('blur', stopArtifactPreview);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopArtifactPreview(); });
  renderArtifacts();
}
