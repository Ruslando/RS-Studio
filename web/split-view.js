// Split view: two spectrogram panes over the one project, side by side or
// stacked, each with its own playhead, zoom, scroll, audio layer, editing layer
// and fretboard.
//
// Only one pane is live: the real #viewer, with every handler the editor has.
// The other is painted by the same renderers (draw.js, fretboard.js) with that
// pane's view swapped into S and dom.js for the length of its paint. The pane
// under the pointer becomes the live one, so both panes edit natively and every
// edit shows in both because there is only one project. A click in the other
// pane makes it the live one and then lands there as the click it was. The
// transport and the sidebar follow the live pane.
//
// Each pane is heard as its own audio layer; notes only from the live pane's
// layer (setPlaybackFocus).
// Playheads: independent (only the live pane plays), linked (both move with the
// transport, each at its own position) or synced (one playhead for both).
import { PX_PER_SEC } from "./constants.js";
import { $, audio, bindViewport, editorEl, liveViewport } from "./dom.js";
import { S } from "./store.js";
import { draw } from "./repaint.js";
import { freshMemo } from "./paint-memo.js";
import { layout, syncRowHeight, updateZoomLabels, xOf, yOf } from "./geometry.js";
import { playbackTime, seekPlayback, setPlaybackFocus, showPlayhead, transportPlaying } from "./playback.js";
import { activeLane, activateLane, editLanes } from "./lanes.js";
import { selectStem, spectrogramUrl } from "./project.js";
import { prepareSpectSample } from "./tracing.js";
import { timingIdOf, withTiming } from "./timing.js";
import { layoutFretboard, paintFretboardInto } from "./fretboard.js";
import { splitter } from "./splitters.js";
import { initRepeatDock, swapRepeatDocks } from "./repeat-dock.js";
import { createRepeatNavigatorMirror } from "./repeat-navigator-mirror.js";
import { connectRepeatSplit, holdRepeatPlayhead, pairRepeats, repeatZones, restoreRepeatReview, savedRepeatReview, swapRepeatPane, withRepeatPane } from "./repeats.js";
import { busLevel } from "./volume.js";
import { clamp, normLayerVolume } from "./util.js";

const panel = $("editingPanel"), pane = $("splitPane"), toggle = $("splitViewToggle");
const dividers = { columns: $("splitDivider"), rows: $("splitDividerY") };
const controls = $("splitControls"), modeSel = $("splitMode"), layoutSel = $("splitLayout"), syncViewBox = $("splitSyncView");
const fretboard = $("splitFretboard"), fretDivider = $("splitFretDivider");
const heads = [$("splitHead0"), $("splitHead1")];
const paneView = {
  stage: pane.querySelector(".split-stage"), ruler: pane.querySelector(".split-ruler"),
  scroll: pane.querySelector(".split-scroll"), viewer: pane,
  rulerRight: pane.querySelector(".split-ruler-right"), stageSpacer: pane.querySelector(".split-spacer"),
};
// The view the other pane shows; null while the split is closed.
let other = null;
let liveSide = 0;     // where the live editor sits: 0 first (left/top), 1 second
let mode = "free";    // "free" | "link" | "sync"
let offset = 0;       // linked: the other playhead's lead over the live one, s
let headKey = "", focusKey = "";
let renderRepeatMirror = null;
// Linked, the other pane's audio layer plays at its own position.
// ponytail: a plain element, outside the Web Audio mix; route it through the stem
// mixer if its few ms of extra output latency ever matter.
const follower = new Audio();
follower.preload = "auto"; follower.preservesPitch = true;

// What the pane paints with besides the project. Pointer and gesture state is
// the live pane's alone, so the other pane paints without it.
const SWAPPED = ["zoomX", "zoomY", "pxPerSec", "stageHeight", "spectImg", "spectPixels", "mouseX", "mouseY",
  "hoverNote", "drag", "marquee", "matchHover", "refEdgeHover", "refLockHover", "rulerHover"];
const IDLE = { spectPixels: null, mouseX: null, mouseY: null, hoverNote: null, drag: null, marquee: null,
  matchHover: -1, refEdgeHover: null, refLockHover: null, rulerHover: null };

// Linked during a repeat review, each playhead is the same distance into its own
// instance, and stops at its edges: a shorter instance waits at its end while the
// longer one plays on. Otherwise linked keeps the offset the two had.
const linkedTime = () => {
  const zones = repeatZones();
  return zones?.live && zones.other ? { at: zones.other.t0 + playbackTime() - zones.live.t0, zone: zones.other }
    : { at: playbackTime() + offset, zone: { t0: 0, t1: S.state.duration || 0 } };
};
function otherTime() {
  if (mode === "sync") return playbackTime();
  if (mode !== "link") return other.time;
  const { at, zone } = linkedTime();
  return clamp(at, zone.t0, zone.t1);
}
const moving = () => mode !== "free" && transportPlaying();
const stemOf = (id) => S.state.stems.find((s) => s.id === id);

const liveView = () => ({
  zoomX: S.zoomX, zoomY: S.zoomY, left: liveViewport.scroll.scrollLeft, top: liveViewport.scroll.scrollTop,
  time: playbackTime(), stemId: S.state.curStem, laneId: activeLane()?.id,
  img: S.spectImg, imgUrl: liveImageUrl(),
});
const imageUrl = (stem) => stem && spectrogramUrl(stem, stem.channel || "stereo").href;
const liveImageUrl = () => (S.spectImg ? imageUrl(stemOf(S.state.curStem)) : null);

// The audio and note layers of each pane, for the transport (playback.js).
function syncFocus() {
  if (!other) return;
  const live = activeLane()?.id;
  const stems = mode === "sync" ? [S.state.curStem, other.stemId] : [S.state.curStem];
  const next = { stems: [...new Set(stems.filter(Boolean))], lanes: live ? [live] : [] };
  const key = JSON.stringify(next);
  if (key !== focusKey) { focusKey = key; setPlaybackFocus(next); }
}

// Load a view into the live editor through the editor's own controls.
function showLive(view) {
  const lane = S.state.lanes.find((l) => l.id === view.laneId);
  if (lane) activateLane(lane);
  const stemId = view.loading ?? view.stemId;   // a choice still decoding goes along
  if (stemId && stemId !== S.state.curStem) {
    selectStem(stemId);
    // Already decoded: show it now instead of the other stem until the reload lands.
    if (view.img && view.imgUrl === imageUrl(stemOf(stemId))) { S.spectImg = view.img; prepareSpectSample(); }
  }
  S.zoomX = view.zoomX; S.pxPerSec = PX_PER_SEC * view.zoomX; S.zoomY = view.zoomY;
  syncRowHeight(); layout(); updateZoomLabels();
  liveViewport.scroll.scrollLeft = view.left; liveViewport.scroll.scrollTop = view.top;
  if (Math.abs(view.time - playbackTime()) > 1e-3) seekPlayback(view.time);   // seeking keeps playing
}

function swap() {
  const next = other;
  next.time = otherTime();   // while each pane still has its own instance
  swapRepeatPane();   // the repeat review's instance goes with its pane
  next.left = paneView.scroll.scrollLeft; next.top = paneView.scroll.scrollTop;   // it may have been scrolled
  other = { ...liveView(), pendingScroll: true };
  offset = -offset;
  liveSide = 1 - liveSide;
  editorEl.classList.toggle("live-second", liveSide === 1);
  showLive(next);
  holdRepeatPlayhead();
  Object.assign(S, { mouseX: null, mouseY: null, hoverNote: null });   // the pointer is on the other stage now
  layoutFretboard();
  swapRepeatDocks($("repeatNavigator"), $("splitRepeatNavigator"));
  syncFocus(); follow(); draw(); later();
}

// A press in the other pane makes it live, and then reaches what the live editor
// now shows under the pointer: the gesture starts there as if it had all along.
// The click that ends it would go to the pair's common parent (its press began
// on the other pane), so it is handed on too.
let handing = false;
function activate(e) {
  if (!other || S.drag) return;
  e.stopImmediatePropagation();
  // Not on the press itself: that would cancel the mousedown the stage's gestures start from.
  if (e.type !== "pointerdown") e.preventDefault();
  else { swap(); handing = true; }
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (target && !pane.contains(target) && target !== fretboard) target.dispatchEvent(new e.constructor(e.type, e));
}
function handOnClick(e) {
  if (!handing) return;
  handing = false;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || target === e.target || !e.target.contains?.(target)) return;   // it landed where it belongs
  e.stopImmediatePropagation();
  target.dispatchEvent(new MouseEvent("click", e));
}

// Linked: keep the other pane's audio layer playing at its own position.
// ponytail: hard resync past 80 ms; a vari-speed trim like the stem followers' if it flams.
function follow() {
  const stem = mode === "link" && other && transportPlaying() && stemOf(other.stemId);
  const { at, zone } = stem ? linkedTime() : { at: 0, zone: null };
  if (!stem || at < Math.max(0, zone.t0) || at >= zone.t1) { follower.pause(); return; }
  if (follower.dataset.stem !== stem.id) { follower.src = stem.audioUrl; follower.dataset.stem = stem.id; }
  follower.volume = stem.muted ? 0 : clamp(normLayerVolume(stem.volume) * busLevel("audio"), 0, 1);
  if (follower.playbackRate !== audio.playbackRate) follower.playbackRate = audio.playbackRate;
  try { if (Math.abs(follower.currentTime - at) > 0.08) follower.currentTime = at; } catch { /* not loaded yet */ }
  if (follower.paused) follower.play().catch(() => {});
}

export function paintSplitPane(paint, panels) {
  if (!other || !(panels || moving())) return;
  // Opened before the live picture had loaded: the pane fetches its own.
  if (!other.img && other.loading == null && other.imgUrl !== imageUrl(stemOf(other.stemId))) loadOther(other.stemId);
  syncFocus();
  if (moving()) follow();
  if (syncViewBox.checked) { other.zoomX = S.zoomX; other.zoomY = S.zoomY; }
  const time = otherTime(), playing = moving(), liveTop = liveViewport.scroll.scrollTop;
  const lanes = S.state.lanes, live = lanes.find((l) => l.active);
  const lane = lanes.find((l) => l.id === other.laneId) || live;
  const stem = stemOf(other.stemId);
  const keep = Object.fromEntries(SWAPPED.map((key) => [key, S[key]]));
  const keepState = { rowH: S.state.rowH, curStem: S.state.curStem, spec: S.state.spec };
  Object.assign(S, IDLE, { zoomX: other.zoomX, zoomY: other.zoomY, pxPerSec: PX_PER_SEC * other.zoomX, spectImg: other.img });
  if (stem) Object.assign(S.state, { curStem: stem.id, spec: stem.spec });
  lanes.forEach((l) => { l.active = l === lane; });
  bindViewport(paneView);
  showPlayhead(time, playing);
  try {
    const run = () => {
      layout();   // sizes the spacer for this pane's zoom before it can scroll
      const sc = paneView.scroll, w = sc.clientWidth;
      if (other.pendingScroll) { sc.scrollLeft = other.left; sc.scrollTop = other.top; other.pendingScroll = false; }
      // A zoom from the other pane (Sync view) keeps this one's centre in place.
      if (other.px && other.px !== S.pxPerSec) sc.scrollLeft = (sc.scrollLeft + w / 2) * S.pxPerSec / other.px - w / 2;
      other.px = S.pxPerSec;
      if (syncViewBox.checked) sc.scrollTop = liveTop * S.stageHeight / keep.stageHeight;
      // Playback and explicit seeks (including arrow-key note navigation) keep
      // the other pane's playhead visible. Consume seeks once so a paused pane
      // can still be scrolled freely afterwards.
      const x = xOf(time);
      if ((playing || (other.followSeek && mode !== "free"))
        && (x < sc.scrollLeft || x > sc.scrollLeft + w * 0.9)) sc.scrollLeft = Math.max(0, x - w * 0.1);
      other.followSeek = false;
      // Shown an instance by the repeat review: frame it like the live editor does.
      if (other.reveal) {
        sc.scrollLeft = Math.max(0, xOf(other.reveal.t0) - w * 0.2);
        sc.scrollTop = Math.max(0, yOf(other.reveal.pitch) - sc.clientHeight / 2);
        other.reveal = null;
      }
      withRepeatPane(() => { renderRepeatMirror?.(); paint(); });
      if (!fretboard.hidden) paintFretboardInto(fretboard);
    };
    freshMemo(() => (lane ? withTiming(timingIdOf(lane), run) : run()));
  } finally {
    showPlayhead(null);
    bindViewport(liveViewport);
    lanes.forEach((l) => { l.active = l === live; });
    Object.assign(S, keep);
    Object.assign(S.state, keepState);
  }
  renderHeads();
}

// Each pane's header names its audio and editing layer.
function renderHeads() {
  const live = { stemId: S.state.curStem, laneId: activeLane()?.id };
  const views = liveSide ? [other, live] : [live, other];
  const stems = S.state.stems.map((s) => [s.id, s.name]), layers = editLanes().map((l) => [l.id, l.name]);
  const key = JSON.stringify([liveSide, views.map((v) => [v.loading ?? v.stemId, v.laneId]), stems, layers]);
  if (key === headKey) return;
  headKey = key;
  heads.forEach((head, side) => {
    head.toggleAttribute("data-live", side === liveSide);
    const [stemSel, laneSel] = head.querySelectorAll("select");
    fill(stemSel, stems, views[side].loading ?? views[side].stemId, "No audio");
    fill(laneSel, layers, views[side].laneId, "No layers");
  });
}
function fill(select, items, value, empty) {
  select.replaceChildren(...(items.length ? items : [["", empty]]).map(([id, name]) => new Option(name, id)));
  select.value = value ?? "";
  select.disabled = !items.length;
}

// The other pane's picture of stem `id`, as the spectrogram settings ask for it
// now. It switches once decoded, so a stem's picture never shows another's range.
function loadOther(id) {
  const view = other, stem = stemOf(id), url = imageUrl(stem);
  if (!stem || (view.stemId === id && view.imgUrl === url)) return;
  const img = new Image();
  img.src = url;
  view.loading = id;
  img.decode().then(() => {
    if (other !== view || view.loading !== id) return;
    Object.assign(view, { stemId: id, img, imgUrl: url, loading: null });
    syncFocus(); follow(); draw(); later();
  }, () => { if (view.loading === id) { view.loading = null; view.imgUrl = url; draw(); } });   // no retry loop
}
function chooseStem(side, id) {
  if (side === liveSide) selectStem(id); else loadOther(id);
}
function chooseLane(side, id) {
  if (side !== liveSide) { other.laneId = id; syncFocus(); draw(); later(); return; }
  const lane = S.state.lanes.find((l) => l.id === id);
  if (lane) activateLane(lane);
}

// Comparing instances, the panes are independent or linked: synced, both would
// show one position, which is never two instances.
let reviewing = false;
function setReviewing(on) {
  reviewing = on;
  modeSel.querySelector('option[value="sync"]').disabled = on;
  if (on && mode === "sync") { modeSel.value = "link"; setMode("link"); }
  later();
}

function setMode(next) {
  other.time = otherTime();   // where the old mode left it
  mode = next;
  offset = other.time - playbackTime();
  syncFocus(); follow(); draw(); later();
}

function setLayout(next) {
  editorEl.classList.toggle("rows", next === "rows");
  draw(); later();
}

const share = (value) => clamp(Number.isFinite(value) ? value : 0.5, 0.2, 0.8);
const shares = { panes: 0.5, boards: 0.5 };
function resizePanes(value) {
  shares.panes = share(value);
  editorEl.style.setProperty("--split-a", `${shares.panes}fr`);
  editorEl.style.setProperty("--split-b", `${1 - shares.panes}fr`);
  draw(); later();
}
function resizeBoards(value) {
  shares.boards = share(value);
  editorEl.style.setProperty("--fret-first", `${shares.boards * 100}%`);
  layoutFretboard(); draw(); later();
}

// ---- kept per project, in the preferences like project-view.js's view ----
// Whether the split is open, its settings, and where the other pane was. The
// live pane is the editor's own view, which project-view.js already keeps.
const storeKey = () => (S.state?.job && S.state.job !== "tutorial" ? `cw.split.${S.state.job}` : null);
let lastOther = null, saveTimer = 0;
function remember() {
  if (other) lastOther = { stemId: other.loading ?? other.stemId, laneId: other.laneId, zoomX: other.zoomX, zoomY: other.zoomY,
    left: paneView.scroll.scrollLeft, top: paneView.scroll.scrollTop, time: otherTime(), liveSide, offset };
}
export function savedSplitView() {
  remember();
  const live = S.state ? liveView() : null;
  if (live) { delete live.img; delete live.imgUrl; }
  return { open: !!other, layout: layoutSel.value, mode, syncView: syncViewBox.checked,
    ...shares, other: lastOther, live, review: savedRepeatReview() };
}
function save() {
  clearTimeout(saveTimer); saveTimer = 0;
  const key = storeKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(savedSplitView()));
  } catch { /* storage blocked: the split just opens fresh next time */ }
}
const later = () => { if (!saveTimer) saveTimer = setTimeout(save, 500); };
function restore() {
  close({ keep: false });
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storeKey())); } catch { /* none kept */ }
  saved ||= S.state?.savedSplitView;
  layoutSel.value = saved?.layout === "rows" ? "rows" : "columns";
  mode = modeSel.value = ["link", "sync"].includes(saved?.mode) ? saved.mode : "free";
  syncViewBox.checked = !!saved?.syncView;
  editorEl.classList.toggle("rows", layoutSel.value === "rows");
  resizePanes(saved?.panes); resizeBoards(saved?.boards);
  lastOther = saved?.other && typeof saved.other === "object" ? saved.other : null;
  clearTimeout(saveTimer); saveTimer = 0;   // nothing changed yet
  if (saved?.open) open();
  if (saved?.live) showLive(saved.live);
  restoreRepeatReview(saved?.review);
}

function open() {
  if (other || !S.state?.spec) return;
  other = { ...liveView(), pendingScroll: true };
  liveSide = 0; headKey = ""; focusKey = ""; offset = 0;
  // Where the other pane was, last time in this project.
  const last = lastOther, num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  if (last) {
    for (const key of ["zoomX", "zoomY", "left", "top", "time"]) other[key] = num(last[key], other[key]);
    if (S.state.lanes.some((l) => l.id === last.laneId)) other.laneId = last.laneId;
    liveSide = last.liveSide === 1 ? 1 : 0;
    offset = num(last.offset, 0);
  }
  editorEl.classList.add("split"); editorEl.classList.toggle("live-second", liveSide === 1);
  for (const el of [pane, ...Object.values(dividers), fretboard, fretDivider, controls, ...heads]) el.hidden = false;
  toggle.setAttribute("aria-pressed", "true");
  if (last?.stemId && last.stemId !== other.stemId) loadOther(last.stemId);
  layoutFretboard(); syncFocus(); follow(); draw(); later();
  pairRepeats(true);
}
function close({ keep = true } = {}) {
  if (!other) return;
  remember();   // reopening the split here brings the other pane back
  other = null;
  follower.pause(); setPlaybackFocus(null); pairRepeats(false);
  editorEl.classList.remove("split", "live-second");
  for (const el of [pane, ...Object.values(dividers), fretboard, fretDivider, controls, ...heads]) el.hidden = true;
  toggle.setAttribute("aria-pressed", "false");
  layoutFretboard(); draw();
  if (keep) save();
  else { clearTimeout(saveTimer); saveTimer = 0; }
}

// The repeat review shows a second instance here (repeats.js).
function showInstance({ t0, pitch }, { linked = false } = {}) {
  if (!other || (linked && mode !== "link")) return;
  if (mode === "link") offset = t0 - playbackTime();   // the two instances then play side by side
  else if (mode === "free") other.time = t0;
  other.reveal = { t0, pitch };
  syncFocus(); draw(); later();
}

export function init_split_view() {
  renderRepeatMirror = createRepeatNavigatorMirror(pane, () => { if (other) swap(); });
  connectRepeatSplit({
    isOpen: () => !!other,
    liveSide: () => liveSide,
    open: (laneId) => {
      if (!other) open();
      if (!other) return;
      other.laneId = laneId;   // both panes review the scanned layer
      setReviewing(true);
      pairRepeats(true); syncFocus(); draw(); later();
    },
    reviewing: setReviewing,
    reveal: showInstance,
  });
  toggle.addEventListener("click", () => (other ? close() : open()));
  window.addEventListener("cw-project-opened", restore);
  // Fired while the project is still there: keep where the split was, then go.
  window.addEventListener("cw-project-closed", () => { save(); close({ keep: false }); });
  window.addEventListener("pagehide", save);
  for (const el of [pane, fretboard])
    for (const type of ["pointerdown", "mousedown", "contextmenu"]) el.addEventListener(type, activate);
  window.addEventListener("click", handOnClick, true);
  paneView.scroll.addEventListener("scroll", () => { draw(); later(); }, { passive: true });
  heads.forEach((head, side) => {
    const [stemSel, laneSel] = head.querySelectorAll("select");
    stemSel.addEventListener("change", () => chooseStem(side, stemSel.value));
    laneSel.addEventListener("change", () => chooseLane(side, laneSel.value));
  });
  modeSel.addEventListener("change", () => setMode(modeSel.value));
  layoutSel.addEventListener("change", () => setLayout(layoutSel.value));
  syncViewBox.addEventListener("change", () => { draw(); later(); });
  initRepeatDock(controls, $("splitDrag"), { key: "rs-split-controls", edge: "bottom" });
  // The first pane is whichever element sits in the first slot.
  const panes = () => (liveSide ? [pane, liveViewport.viewer] : [liveViewport.viewer, pane]);
  for (const [axis, el, size] of [["x", dividers.columns, "offsetWidth"], ["y", dividers.rows, "offsetHeight"]]) {
    splitter(el, {
      axis,
      start: () => { const [a, b] = panes(); return { from: a[size], room: a[size] + b[size] }; },
      move: (delta, { from, room }) => resizePanes((from + delta) / room),
      toggle: () => resizePanes(0.5),
    });
  }
  const stage = fretDivider.parentElement;
  splitter(fretDivider, {
    axis: "x",
    start: () => ({ size: stage.clientWidth, from: fretDivider.offsetLeft }),
    move: (delta, { size, from }) => resizeBoards((from + delta) / size),
    toggle: () => resizeBoards(0.5),
  });
  window.addEventListener("cw-transport", event => {
    if (other && mode !== "free" && event.detail === "seek") other.followSeek = true;
    follow();
  });
  // A channel or view change reloads the live picture; the other pane's follows.
  window.addEventListener("cw-stem-view-changed", () => { if (other) loadOther(other.loading ?? other.stemId); });
}
