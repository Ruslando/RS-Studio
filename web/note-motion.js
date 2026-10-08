// Paint-only edit feedback. Musical state and hit testing always land immediately.
import { motionTiming } from "./panel-motion.js";
import { draw } from "./repaint.js";

const LIMIT = 128;
const effects = new Map();
const gesture = new Map();
const lifts = new Map();
const edges = new Map();
const glows = new Map();
let playbackPosition = 0;
let playing = false;
let glowTiming = null;
let gestureMode = null;
let heldScale = 1;
let reducedMotion = false;
let project = null;
let frameTime = 0;
let held = new Set();
const key = (lane, note) => `${lane.id}:${note.id}`;
const geometry = (note) => ({ ...note });
const changed = (a, b) => a.start !== b.start || a.end !== b.end || a.pitch !== b.pitch;

export function clearNoteMotion() {
  effects.clear(); gesture.clear(); lifts.clear(); edges.clear(); glows.clear(); held.clear(); project = null; gestureMode = null;
}
window.addEventListener("cw-project-closed", clearNoteMotion);
window.addEventListener("cw-project-opened", clearNoteMotion);

function useProject(state) {
  if (project !== state) { clearNoteMotion(); project = state; }
}

function remember(lane, note, kind, timing, from = null) {
  if (!timing.duration) return;
  const id = key(lane, note);
  effects.delete(id);
  if (effects.size >= LIMIT) effects.delete(effects.keys().next().value);
  effects.set(id, { lane, note: { ...note }, from, kind, time: performance.now(), ...timing });
  draw();
}

export function animateNoteChanges(previous, state, cuts = null) {
  useProject(state);
  const timing = motionTiming("--dur-note");
  if (!timing.duration) { clearNoteMotion(); return; }
  const changes = [];
  for (const lane of state.editLanes || []) {
    if (!lane.visible) continue;
    const before = new Map((previous.lanes[lane.id] || []).map(note => [note.id, note]));
    for (const note of lane.notes) {
      const old = before.get(note.id);
      const id = key(lane, note), edge = edges.get(id);
      if (edge && changed(edge.to, note)) edges.delete(id);
      if (cuts) lifts.delete(id);
      if (!old) changes.push({ lane, note, kind: cuts?.has(note.id) ? "slice" : "add" });
      else if (changed(old, note)) changes.push({ lane, note, kind: cuts ? "slice-settle" : "settle" });
      before.delete(note.id);
      if (changes.length > LIMIT) { effects.clear(); return; }
    }
    // Slicing replaces one note with two, rather than deleting a musical event.
    if (!cuts) for (const note of before.values()) {
      changes.push({ lane, note, kind: "remove" });
      if (changes.length > LIMIT) { effects.clear(); return; }
    }
  }
  for (const { lane, note, kind } of changes) {
    remember(lane, note, kind, timing);
    if (["add", "slice", "slice-settle"].includes(kind)) {
      const spring = liftTiming();
      heldScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--note-held-scale"));
      if (spring.duration) setSpring(lifts, key(lane, note), {
        lane, pulse: true, horizontal: true, time: performance.now(), ...spring,
        duration: spring.duration * 2,
      });
    }
  }
}

const bounceTiming = () => motionTiming("--dur-note-bounce", "--ease-note-bounce");
const liftTiming = () => motionTiming("--dur-note-lift", "--ease-note-lift");
const springProgress = (effect, now) => effect.ease(Math.max(0, Math.min(1, (now - effect.time) / effect.duration)));
const liftAt = (effect, now) => {
  if (effect.pulse) {
    // Replay the actual pickup followed by release, using the same scale/curve.
    const phase = Math.max(0, Math.min(2, (now - effect.time) / effect.duration * 2));
    return phase <= 1 ? effect.ease(phase) : 1 - effect.ease(phase - 1);
  }
  return effect.from + (effect.to - effect.from) * springProgress(effect, now);
};
const edgeAt = (effect, now) => {
  const p = springProgress(effect, now);
  let start = effect.from.start + (effect.to.start - effect.from.start) * p;
  let end = effect.from.end + (effect.to.end - effect.from.end) * p;
  const minSpan = (effect.to.end - effect.to.start) * .7;
  if (end - start < minSpan) {
    if (effect.from.start !== effect.to.start && effect.from.end === effect.to.end) start = end - minSpan;
    else end = start + minSpan;
  }
  return { start, end };
};
function setSpring(records, id, spring) {
  records.delete(id);
  if (records.size >= LIMIT) records.delete(records.keys().next().value);
  records.set(id, spring);
}
function resizeBounce(lane, note, previous, timing) {
  if (!timing.duration) return;
  const id = key(lane, note), now = performance.now();
  const current = edges.get(id);
  setSpring(edges, id, { lane, from: current ? edgeAt(current, now) : previous,
    to: geometry(note), time: now, ...timing });
}

export function beginNoteGesture(state, lane, notes, mode = "move") {
  useProject(state);
  gesture.clear();
  gestureMode = mode;
  heldScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--note-held-scale"));
  if (notes.length > LIMIT) return;
  const timing = motionTiming("--dur-note");
  const spring = liftTiming();
  for (const note of notes.slice(0, LIMIT)) {
    if (mode === "move") edges.delete(key(lane, note));
    gesture.set(key(lane, note), geometry(note));
    remember(lane, note, "settle", timing);
    if (spring.duration) {
      const id = key(lane, note), now = performance.now();
      setSpring(lifts, id, { lane, pulse: true,
        horizontal: mode === "move", time: now, ...spring, duration: spring.duration * 2 });
    }
  }
}

export function updateNoteGesture(state, lane, notes) {
  useProject(state);
  if (notes.length > LIMIT) return;
  const timing = motionTiming("--dur-note");
  const spring = bounceTiming();
  for (const note of notes.slice(0, LIMIT)) {
    const id = key(lane, note), old = gesture.get(id);
    if (old && changed(old, note)) {
      remember(lane, note, gestureMode === "resize" ? "settle" : "drag", timing, old);
      if (gestureMode === "resize") resizeBounce(lane, note, old, spring);
    }
    gesture.set(id, geometry(note));
  }
}

export function finishNoteGesture(state, drag) {
  const timing = liftTiming();
  if (state === project && timing.duration && drag?.notes?.length <= LIMIT && ["move", "resize"].includes(drag.mode)) {
    const lane = drag.lane || state.editLanes.find(l => l.notes.includes(drag.note));
    if (lane) for (const note of drag.notes) {
      const id = key(lane, note), now = performance.now(), current = lifts.get(id);
      setSpring(lifts, id, { lane, from: current ? liftAt(current, now) : 0, to: 0,
        horizontal: drag.mode === "move", time: now, ...timing });
      const edge = edges.get(id);
      if (edge && changed(edge.to, note)) resizeBounce(lane, note, edgeAt(edge, now), bounceTiming());
    }
    draw();
  }
  gesture.clear(); gestureMode = null;
}

export function beginNoteMotionFrame(state, drag) {
  useProject(state);
  frameTime = performance.now();
  held = new Set(drag && ["move", "resize"].includes(drag.mode) ? drag.notes : []);
  reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) { effects.clear(); lifts.clear(); edges.clear(); }
  for (const records of [effects, lifts, edges]) for (const [id, effect] of records)
    if (frameTime - effect.time >= effect.duration || !state?.editLanes?.includes(effect.lane)) records.delete(id);
  if (effects.size || lifts.size || edges.size) draw();
}

const glowAt = effect => effect.duration
  ? effect.from + (effect.to - effect.from) * springProgress(effect, frameTime)
  : effect.to;
const underPlayhead = (lane, note) => playing && lane.visible && note.start <= playbackPosition && playbackPosition < note.end;

export function beginNotePlaybackFrame(state, position, isPlaying) {
  useProject(state);
  playbackPosition = position; playing = isPlaying;
  glowTiming = {
    enter: motionTiming("--dur-note-glow-in", "--ease"),
    leave: motionTiming("--dur-note-glow-out", "--ease"),
  };
  for (const [id, effect] of glows) {
    if (!state?.lanes?.includes(effect.lane) || !effect.lane.visible) { glows.delete(id); continue; }
    const target = underPlayhead(effect.lane, effect.note) ? 1 : 0;
    if (target !== effect.to || (!glowTiming.enter.duration && effect.duration)) {
      const from = glowAt(effect);
      Object.assign(effect, target ? glowTiming.enter : glowTiming.leave, { from, to: target, time: frameTime });
    }
    if (!effect.to && frameTime - effect.time >= effect.duration) glows.delete(id);
    else if (frameTime - effect.time < effect.duration) draw();
  }
}

export function notePlaybackGlow(lane, note) {
  const id = key(lane, note);
  let effect = glows.get(id);
  if (!effect && glowTiming && underPlayhead(lane, note)) {
    if (glows.size >= LIMIT) glows.delete(glows.keys().next().value);
    effect = { lane, note, from: 0, to: 1, time: frameTime, ...glowTiming.enter };
    glows.set(id, effect);
    if (effect.duration) draw();
  }
  return effect ? glowAt(effect) : 0;
}

const progress = effect => effect.ease(Math.max(0, Math.min(1, (frameTime - effect.time) / effect.duration)));

export function noteMotion(lane, note) {
  const effect = effects.get(key(lane, note));
  const p = effect ? progress(effect) : 1;
  const arriving = effect && ["add", "slice"].includes(effect.kind);
  const id = key(lane, note), lift = lifts.get(id), edge = edges.get(id);
  const height = reducedMotion ? 0 : lift ? liftAt(lift, frameTime) : 0;
  const bounds = edge ? edgeAt(edge, frameTime) : note;
  return {
    alpha: arriving && !lift?.pulse ? .45 + .55 * p : 1,
    reveal: arriving && !lift?.pulse ? p : 1,
    emphasis: Math.max(held.has(note) ? .35 : 0, effect ? 1 - p : 0),
    cut: effect?.kind === "slice" ? 1 - p : 0,
    scale: 1 + (heldScale - 1) * height,
    scaleX: lift?.horizontal || (!lift && gestureMode === "move") ? 1 + (heldScale - 1) * height : 1,
    start: bounds.start, end: bounds.end,
  };
}

export function noteMotionGhosts() {
  const result = [];
  for (const effect of effects.values()) {
    if (!effect.lane.visible || !["remove", "drag"].includes(effect.kind)) continue;
    const p = progress(effect);
    result.push({ lane: effect.lane, note: effect.from || effect.note,
      alpha: (effect.kind === "drag" ? .18 : .65) * (1 - p), shrink: effect.kind === "remove" ? p : 0 });
  }
  return result;
}
