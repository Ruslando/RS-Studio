// Marker selection and clipboard: tempo, section, phrase, tone and hand flags.
// Ctrl-click a flag adds or drops it; Shift-click takes every flag on that rail
// from the last one clicked. While flags are selected, Copy, Cut, Delete act on
// them, and Paste puts the last copied flags at the playhead, at their distances
// from the earliest one, into the active layer.
// Pasted tempo flags change the grid only; notes keep their times.

import { draw } from "./repaint.js";
import { songEnd } from "./project-position-core.js";
import { commit, commitStructure, snapshotEdit } from "./edit-history.js";
import { gridOffset, restoreGridState, currentGridState } from "./grid-controls.js";
import { snap } from "./grid-read.js";
import { markerKey, markerRails, markerSelection, setMarkerSelection } from "./marker-rails.js";
import { tempoFlags } from "./markers.js";
import { sectionMarkersChanged } from "./section-markers.js";
import { normalizePhraseBoundaries, normalizeSectionMarkers } from "./section-marker-core.js";
import { normalizeToneMarkers } from "./tone-marker-core.js";
import { activeLane } from "./lanes.js";
import { playbackTime } from "./playback.js";
import { toast } from "./notify.js";
import { refreshSaveState } from "./save-state.js";
import { refreshTabIfOpen } from "./tablature.js";
import { S, setSelection } from "./store.js";
import { landMarkers, markerRange } from "./marker-clipboard-core.js";
import { HAND_ANCHOR_VERSION, nearestHandStart, normalizeHandAnchors } from './hand-anchor-state.js';

let anchor = null;    // the flag a Shift-click counts from
let clip = null;      // the copied flags, or null when notes were copied last

const allFlags = () => [...tempoFlags(), ...markerRails().flatMap((rail) => rail.flags?.() || [])];
const selectedFlags = () => { const keys = markerSelection(); return allFlags().filter((f) => keys.has(markerKey(f.kind, f.key))); };
const duration = () => Number(S.state?.duration) || Number(S.state?.scoreDuration) || Infinity;

export const hasMarkerSelection = () => markerSelection().size > 0;
export const hasMarkerClip = () => !!clip;
export const forgetMarkerClip = () => { clip = null; };   // notes were copied: Paste is theirs
export function clearMarkerSelection() {
  if (!hasMarkerSelection()) return false;
  setMarkerSelection([]); anchor = null; draw();
  return true;
}

// Ctrl/Shift-click on a flag. True when it took the click.
export function markerSelectClick(e, x, y) {
  if (!(e.ctrlKey || e.metaKey || e.shiftKey) || e.altKey) return false;
  const flags = allFlags(), hit = flags.find((f) => x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1);
  if (!hit) return false;
  e.preventDefault();
  pickMarker(e, hit, flags.filter((f) => f.kind === hit.kind));
  return true;
}

// Ctrl toggles `hit` ({ kind, key, t }); Shift adds every one of `same` (its kind,
// in any order) from the last one picked. Shared by the rails and the marker list.
export function pickMarker(e, hit, same) {
  const keys = new Set(markerSelection()), key = markerKey(hit.kind, hit.key);
  if (e.shiftKey && anchor?.kind === hit.kind) {
    for (const f of markerRange(same, anchor.t, hit.t)) keys.add(markerKey(f.kind, f.key));
  } else {
    if (keys.has(key)) keys.delete(key); else keys.add(key);
    anchor = hit;
  }
  setMarkerSelection(keys);
  if (keys.size && S.selection.size) setSelection(new Set());   // one selection at a time
  draw();
}

// The copy of one flag: what it is, minus its identity.
function itemOf(f) {
  if (f.kind === "tempo") {
    const { t, bpm, tsNum, tsDen, subdiv } = f.seg;
    return { kind: "tempo", t, bpm, tsNum, tsDen, subdiv: subdiv || 1 };
  }
  const { id, ...rest } = f.marker || f.boundary;
  return { ...structuredClone(rest), kind: f.kind, t: f.t };
}

export function copyMarkers() {
  const flags = selectedFlags();
  if (!flags.length) return false;
  clip = flags.map(itemOf);
  S.clipboard = []; S.clipboardRef = null; S.clipboardSrc = [];   // the last copy is what Paste pastes
  toast(`Copied ${clip.length} marker${clip.length === 1 ? "" : "s"}`);
  return true;
}

// Remove the selected flags. The grid start cannot go; it stays.
function removeSelected(flags) {
  const gone = (kind) => new Set(flags.filter((f) => f.kind === kind).map((f) => f.key));
  const tempo = new Set(flags.filter((f) => f.kind === "tempo" && !f.seg.seg0).map((f) => f.seg.ref));
  S.state.tempoMap = (S.state.tempoMap || []).filter((m) => !tempo.has(m));
  const sections = gone("section");
  S.state.sectionMarkers = normalizeSectionMarkers(S.state.sectionMarkers, duration()).filter((m) => !sections.has(m.id));
  const lane = activeLane();
  if (lane) {
    const phrases = gone("phrase"), tones = gone("tone");
    lane.phraseBoundaries = normalizePhraseBoundaries(lane.phraseBoundaries, duration()).filter((m) => !phrases.has(m.id));
    lane.toneMarkers = normalizeToneMarkers(lane.toneMarkers, duration()).filter((m) => !tones.has(m.id));
    if (!lane.locked) {
      const hands = gone('hand-anchor'), initial = lane.handHolds?.[0];
      lane.handHolds = (lane.handHolds || []).filter(h => h === initial || !hands.has(h.id));
    }
  }
}

export function deleteMarkers() {
  const flags = selectedFlags();
  if (!flags.length) return false;
  if (flags.every(f => f.kind === 'hand-anchor' && (f.marker === activeLane()?.handHolds?.[0] || activeLane()?.locked))) return true;
  const prev = snapshotEdit();
  removeSelected(flags);
  setMarkerSelection([]);
  done(prev, flags.some(f => f.kind === 'hand-anchor'));
  return true;
}

export function cutMarkers() {
  return copyMarkers() && deleteMarkers();
}

function done(prev, hands = false) {
  sectionMarkersChanged();
  if (hands) commit(prev, undefined, null, { preserveTiming: true });
  else commitStructure(prev);
  refreshSaveState(); draw(); refreshTabIfOpen();
}

export function pasteMarkers(at = playbackTime()) {
  if (!clip?.length || !S.state) return false;
  const lane = activeLane();
  const laneKinds = clip.some((c) => c.kind === "phrase" || c.kind === "tone" || c.kind === 'hand-anchor');
  if (laneKinds && lane?.locked) { toast(`Layer “${lane.name}” is locked — unlock it to edit`); return true; }
  const prev = snapshotEdit(), end = duration(), stamp = Date.now(), keys = [];
  const limit = songEnd(S.state) || end;   // the end marker, not only the audio length
  const placed = landMarkers(clip, clip.every(c => c.kind === 'hand-anchor')
    ? nearestHandStart(lane?.notes || [], at) ?? at : snap(Math.max(0, at))).filter((c) => c.t < limit);
  const same = (list, t) => (list || []).filter((m) => Math.abs(+m.t - t) > 1e-4);   // a flag already there is replaced
  for (const [k, c] of placed.entries()) {
    const { kind, ...data } = c;
    if (kind === "tempo") {
      const { bpm, tsNum, tsDen, subdiv } = data;
      if (c.t <= gridOffset() + 1e-3) {   // lands on or before the grid start: it becomes the start's tempo
        restoreGridState({ ...currentGridState(), bpm, tsNum, tsDen, subdiv });
        keys.push(markerKey("tempo", "start"));
      } else {
        S.state.tempoMap = [...same(S.state.tempoMap, c.t), { t: c.t, bpm, tsNum, tsDen, subdiv }];
        keys.push(markerKey("tempo", c.t.toFixed(4)));
      }
      continue;
    }
    const id = `${kind}_${stamp}_${k}`;
    keys.push(markerKey(kind, id));
    if (kind === "section") {
      const others = same(S.state.sectionMarkers, c.t).filter((m) => data.sectionType !== "end" || m.sectionType !== "end");
      S.state.sectionMarkers = normalizeSectionMarkers([...others, { ...data, id }], end);
    } else if (lane && kind === "phrase") {
      lane.phraseBoundaries = normalizePhraseBoundaries([...same(lane.phraseBoundaries, c.t), { ...data, id }], end);
    } else if (lane && kind === "tone") {
      lane.toneMarkers = normalizeToneMarkers([...same(lane.toneMarkers, c.t), { ...data, id }], end);
    } else if (lane && kind === 'hand-anchor') {
      const t = nearestHandStart(lane.notes, c.t);
      if (t != null) {
        lane.handHolds = normalizeHandAnchors(lane.notes, [...same(lane.handHolds, t), { id, t, fret: data.fret }]);
        lane.handAnchorVersion = HAND_ANCHOR_VERSION;
      }
    }
  }
  S.state.tempoMap?.sort((a, b) => a.t - b.t);
  if (S.selection.size) setSelection(new Set());
  setMarkerSelection(keys);   // the paste stays selected, as pasted notes do
  done(prev, placed.some(c => c.kind === 'hand-anchor'));
  return true;
}

export function init_marker_clipboard() {
  window.addEventListener("cw-project-opened", () => { clip = null; anchor = null; setMarkerSelection([]); });
}
