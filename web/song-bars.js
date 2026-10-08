// Where the bars of THIS song are — the store's answer, in one place, because two
// features now ask it for different reasons: section markers snap to bar lines, and
// the voicer plans the fretting hand a bar at a time (planSeats).
//
// An imported score states its own bar lines and they win; otherwise the tempo grid
// tiles them. bars.js does the arithmetic and knows nothing about the store.
//
// The grid comes from `S.appliedGrid` and not from grid.js's live inputs, for two
// reasons. It keeps this module DOM-free, which the modern Guitar Pro export and its
// headless tests need — and it is the more correct source anyway: bar lines should
// follow the grid that has been committed, not a half-typed BPM. Same fallback chain
// guitar-pro-score.js already uses.

import { barStartsFromGrid } from "./bars.js";
import { S } from "./store.js";

export function songBarStarts() {
  const stored = (S.state?.scoreBars || []).map((bar) => Number(bar.seconds)).filter(Number.isFinite);
  if (stored.length) return [...new Set(stored)].sort((a, b) => a - b);
  const grid = S.appliedGrid || S.state?.baseGrid || S.state?.grid;
  if (!grid) return [];
  return barStartsFromGrid(
    { ...grid, tempoMap: S.state?.tempoMap || [] },
    Math.max(0, Number(S.state?.duration) || Number(S.state?.scoreDuration) || 0),
  );
}
