// The stage's palette, refreshed from CSS at boot and on theme changes.
//
// A canvas cannot resolve a custom property — `ctx.fillStyle = "var(--x)"` is
// simply ignored — and a getComputedStyle call per fill would run thousands of
// times a frame. So the names live in style.css (`--stage-*`, the source of
// truth, shared with the DOM half of the same chrome) and this module reads them
// on theme changes, keeping CSS queries out of the rendering loop.
//
// Every colour the canvas draws comes from here. A literal in a renderer is a
// bug — that is what tests/stage-paint.test.mjs checks.

import { hexA } from "./util.js";

const NAMES = [
  "ground", "toolbar", "ink", "paper", "chrome", "chrome-hover", "text", "label", "hint", "accent", "ok", "warn", "error",
  "line", "grid-bar", "grid-beat", "grid-sub",
  "marker", "marker-idle", "section", "phrase", "tone", "shape", "trace", "ref",
];

// Deferred module scripts run after the stylesheet is parsed, so :root is
// resolved by the time this evaluates.
export const PAINT = {};
export const UI_PAINT = {};
export function refreshStagePaint() {
  const cs = getComputedStyle(document.documentElement);
  for (const name of NAMES) {
    const key = name.replace(/-(.)/g, (_, c) => c.toUpperCase());
    UI_PAINT[key] = cs.getPropertyValue("--stage-" + name).trim();
    // Spectrogram pixels and their annotations retain the original palette.
    PAINT[key] = cs.getPropertyValue("--spectral-" + name).trim() || UI_PAINT[key];
  }
}
refreshStagePaint();
Object.seal(PAINT);
Object.seal(UI_PAINT);

// How see-through, in three steps, and the reasoning is the same as the spacing
// scale's: the number follows from what is underneath, so there is nothing to
// pick. A wash tints data you still have to read through it. A veil carries
// chrome that sits on top of the song and may hide it. A halo backs a single
// glyph, which is a hairline of ink and needs the most help.
export const WASH = 0.14, VEIL = 0.72, HALO = 0.85;

// A glyph drawn straight onto the spectrogram is unreadable over a bright
// partial, so every one of them is stroked with the ground colour first. This is
// the stage's equivalent of a shadow, and like the system's two shadows there is
// exactly one of it.
export const halo = () => hexA(PAINT.ground, HALO);
export const veil = (c = PAINT.chrome) => hexA(c, VEIL);
export const wash = (c) => hexA(c, WASH);
