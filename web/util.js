// Small pure helpers (formatting, clamping, volume math) shared across modules.

import { DEFAULT_LAYER_VOLUME } from "./constants.js";

export function noteName(p) {
  const n = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return n[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
}

// "C#4" / "Eb2" -> MIDI, or null. Octave numbering is scientific pitch (C4 = 60),
// matching noteName above so the two round-trip.
const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteToMidi(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) return null;
  return PITCH_CLASS[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0)
    + (parseInt(m[3], 10) + 1) * 12;
}

// A tuning string ("G2 D2 A1 E1", high to low) -> open-string MIDI, or null if
// any note is unparseable or there are fewer than three strings.
export function parseTuning(str) {
  const parts = String(str || "").trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const midis = parts.map(noteToMidi);
  return midis.every((v) => v != null) ? midis : null;
}

export const tuningToNames = (t) => t.map((p) => noteName(p)).join(" ");
// A UI preference nobody should be interrupted over. localStorage throws in
// private-browsing mode and when the origin's quota is full; losing a panel
// width is not worth an error, and there is nothing useful to do about it.
export function rememberPref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode or quota */ }
}

// "#rrggbb" + alpha -> an rgba() string. Canvas has no way to set a fill's
// opacity separately from its colour, so every translucent shape builds one.
export function hexA(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

export function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
// External tablature uses score-relative milliseconds while the editor/audio
// use absolute song seconds. Keep both directions in one tested place so view
// switches and click-to-seek cannot silently disagree about offset or tempo scale.
export function tabMsToSongTime(ms, offset = 0, scale = 1) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return offset + ms / 1000 / safeScale;
}
export function songTimeToTabMs(time, offset = 0, scale = 1) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return (time - offset) * safeScale * 1000;
}
// Return the horizontal scroll position that reveals the playhead. `center` is
// used on a view switch; normal playback keeps the established 60px lead-in and
// leaves an already-visible playhead alone.
export function playheadScrollLeft(time, pxPerSec, viewportWidth, scrollWidth, currentLeft = 0, center = false) {
  const width = Math.max(0, viewportWidth || 0), max = Math.max(0, (scrollWidth || 0) - width);
  const x = Math.max(0, time || 0) * Math.max(0, pxPerSec || 0);
  if (center) return clamp(x - width / 2, 0, max);
  if (x < currentLeft || x > currentLeft + width - 60) return clamp(x - 60, 0, max);
  return clamp(currentLeft, 0, max);
}
// Canvas backing-store scale: device px per CSS px (HiDPI display / browser zoom).
// Canvases sized without this render at CSS resolution and get upscaled blurry.
export function dpr() {
  return window.devicePixelRatio || 1;
}
export function normLayerVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, 0, 1) : DEFAULT_LAYER_VOLUME;
}
export function layerVolumePercent(lane) {
  return Math.round(normLayerVolume(lane ? lane.volume : DEFAULT_LAYER_VOLUME) * 100);
}
export function volumeToDb(v) {
  const linear = normLayerVolume(v);
  return linear <= 0 ? -80 : 20 * Math.log10(linear);
}
// Note-scheduler window [from, horizon). `prevFrom` carries the previous tick's
// horizon so the windows stay gapless when a tick stalls past the lookahead (a
// dropped rAF frame used to skip the notes in the gap outright). Catch-up is
// capped at `grace` s so a long stall (background tab) can't burst-fire a
// backlog — missed notes fire immediately, at most `grace` late.
export function schedWindow(prevFrom, ct, look, grace = 0.25) {
  return [Math.max(ct - grace, Math.min(prevFrom, ct)), ct + look];
}
// Perceived-attack time of a decoded sample, in seconds: leading silence baked
// into the file (mp3 encoder padding + recorded pre-attack — ~28ms measured on
// the electric/bass sets, ~58ms acoustic) up to the mid-rise point (half the
// attack-region peak — a standard perceptual-attack proxy; the first-audibility
// point would undershoot slow attacks). Sampled voices are triggered early by
// this much so the heard attack lands on the note, not after it.
export function onsetSec(data, sampleRate, th = 0.01) {
  const attackEnd = Math.min(data.length, Math.round(sampleRate * 0.5));
  let peak = 0;
  for (let i = 0; i < attackEnd; i++) if (Math.abs(data[i]) > peak) peak = Math.abs(data[i]);
  const rise = Math.max(th, peak * 0.5);
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) >= rise) return i / sampleRate;
  return 0;
}
// Follower-stem vari-speed trim (fraction of the base rate, + = speed up): a fixed
// ±2% engages once the smoothed drift passes 12ms and releases under 4ms, so a
// stem can't sit at an audible steady flam (>~10ms) below the threshold forever.
// Tight thresholds are safe: graph-routed media element clocks measured exact
// against the graph feed (latency probe, 2026-07-03); the EMA + hysteresis band
// absorb what read noise remains. 2% is inaudible with preservesPitch.
export function followerTrim(err, prev = 0) {
  if (Math.abs(err) > 0.012) return err > 0 ? -0.02 : 0.02;
  return Math.abs(err) < 0.004 ? 0 : prev;
}

// What a dropped or picked file is. The extension test is the one that matters:
// a drag from a file manager often carries an empty `type`, and no browser sets
// one for Guitar Pro at all. Both the launcher's drop zone and the new-project
// stem list ask, so the answer lives here rather than in either of them.
export function isAudioFile(file) {
  return !!file && (
    (file.type && file.type.startsWith("audio/")) ||
    /\.(aac|aif|aiff|flac|m4a|mp3|mp4|ogg|opus|wav|webm)$/i.test(file.name || "")
  );
}

export function isGuitarProFile(file) {
  return !!file && /\.(?:gp|gpx|gp[345])$/i.test(file.name || "");
}
