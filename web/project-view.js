// Where you were in a project: zoom, scroll, playhead, stem, speed and the View panel. Kept per
// project in the preferences (synced to the server, see index.html) whenever it
// changes, so reopening a project lands there whether or not it was saved since.
import { audio, scroll, speedSel } from "./dom.js";
import { S } from "./store.js";
import { playbackTime, seekPlayback } from "./playback.js";

const keyOf = (job) => `cw.view.${job}`;
const kept = (job) => job && job !== "tutorial";

export function savedView(job) {
  if (!kept(job)) return null;
  try { return JSON.parse(localStorage.getItem(keyOf(job))) || null; } catch { return null; }
}

let timer = 0;
function save() {
  clearTimeout(timer); timer = 0;
  if (!S.state || !kept(S.state.job)) return;
  try {
    localStorage.setItem(keyOf(S.state.job), JSON.stringify({
      zoomX: S.zoomX, zoomY: S.zoomY, left: scroll.scrollLeft, top: scroll.scrollTop,
      time: playbackTime(), stem: S.state.curStem, speed: speedSel.value,
      intensity: S.state.viewIntensity, spectrogram: S.state.specView || 'fine', sharp: !!S.state.specSharp,
    }));
  } catch { /* storage blocked: the project still opens, just at the start */ }
}
const later = () => { if (!timer) timer = setTimeout(save, 500); };

// Zoom, stem and speed are applied while the project loads (applyProject); the
// playhead and the scroll need the laid-out editor and the audio's length.
export function restoreView(view) {
  if (!view) return;
  const place = () => {
    if (Number.isFinite(view.time) && view.time > 0) seekPlayback(view.time);
    requestAnimationFrame(() => {
      if (Number.isFinite(view.left)) scroll.scrollLeft = view.left;
      if (Number.isFinite(view.top)) scroll.scrollTop = view.top;
    });
  };
  if (!audio.getAttribute("src") || audio.readyState >= 1) place();
  else audio.addEventListener("loadedmetadata", place, { once: true });
}

export function initProjectView() {
  scroll.addEventListener("scroll", later, { passive: true });
  speedSel.addEventListener("change", later);
  for (const event of ["cw-transport", "cw-stem-view-changed"]) window.addEventListener(event, later);
  window.addEventListener("cw-project-closed", save);   // fired while the project is still there
  window.addEventListener("pagehide", save);
}
