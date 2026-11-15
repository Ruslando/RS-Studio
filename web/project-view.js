// Where you were in a project: zoom, scroll, playhead, stem, speed and the View panel. Kept per
// project in the preferences (synced to the server, see index.html) whenever it
// changes, so reopening a project lands there whether or not it was saved since.
import { audio, scroll, speedSel } from "./dom.js";
import { S } from "./store.js";
import { playbackTime, seekPlayback } from "./playback.js";

const keyOf = (job) => `cw.view.${job}`;
const kept = (job) => job && job !== "tutorial";

export function savedView(job, viewKey = job) {
  if (!kept(job)) return null;
  try { return JSON.parse(localStorage.getItem(keyOf(viewKey)) || localStorage.getItem(keyOf(job))) || null; } catch { return null; }
}

let timer = 0, loading = false, cancelRestore = () => {}, pendingTime = null;
export function currentView() {
  return {
    zoomX: S.zoomX, zoomY: S.zoomY, left: scroll.scrollLeft, top: scroll.scrollTop,
    time: pendingTime ?? playbackTime(), stem: S.state.curStem, speed: speedSel.value,
    intensity: S.state.viewIntensity, spectrogram: S.state.specView || 'fine', sharp: !!S.state.specSharp,
    activeLane: S.state.editLanes?.find(lane => lane.active)?.id ?? null,
  };
}
function save() {
  clearTimeout(timer); timer = 0;
  if (loading || !S.state || !kept(S.state.job)) return;
  try {
    localStorage.setItem(keyOf(S.state.viewKey || S.state.job), JSON.stringify(currentView()));
  } catch { /* storage blocked: the project still opens, just at the start */ }
}
const later = () => { if (!loading && !timer) timer = setTimeout(save, 500); };

export function beginProjectView() {
  save();
  cancelRestore();
  loading = true;
}

// Zoom, stem and speed are applied while the project loads (applyProject); the
// playhead and the scroll need the laid-out editor and the audio's length.
export function restoreView(view) {
  cancelRestore();
  const state = S.state;
  let cancelled = false;
  pendingTime = Number.isFinite(view?.time) ? view.time : null;
  const seek = () => {
    if (cancelled || S.state !== state) return;
    const time = pendingTime;
    pendingTime = null;
    if (time !== null) seekPlayback(time);
  };
  cancelRestore = () => {
    cancelled = true; pendingTime = null;
    audio.removeEventListener('loadedmetadata', seek);
  };
  if (!audio.getAttribute('src') || audio.readyState >= 1) seek();
  else audio.addEventListener('loadedmetadata', seek, { once: true });
  // Scroll geometry is ready independently of audio metadata. Do not let a
  // slow audio load save the initial zero scroll over the restored position.
  return new Promise(resolve => requestAnimationFrame(() => {
    if (!cancelled && S.state === state) {
      if (Number.isFinite(view?.left)) scroll.scrollLeft = view.left;
      if (Number.isFinite(view?.top)) scroll.scrollTop = view.top;
      loading = false;
      later();
    }
    resolve();
  }));
}

export function initProjectView() {
  window.cwSaveProjectView = save;
  scroll.addEventListener("scroll", later, { passive: true });
  speedSel.addEventListener("change", later);
  for (const event of ["cw-transport", "cw-stem-view-changed", "cw-zoom-changed", "cw-lanes-rendered"]) window.addEventListener(event, later);
  window.addEventListener("cw-project-closed", () => { save(); cancelRestore(); loading = true; });
  window.addEventListener("pagehide", save);
}
