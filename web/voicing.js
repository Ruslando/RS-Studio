// The voicing surface the editor talks to. The cost engine itself (shape
// enumeration, cost model, DP) lives in voicing-core.js — pure and DOM-free so
// tests can run it headless — and is re-exported here so callers keep importing
// everything voicing-related from this module.
//
// What sits on top of it is the worker plumbing that ranks a column's other
// positions, and the column navigation the arrow keys walk. Both used to serve a
// floating "Tab preview" sidebar that drew the same shapes as small SVG diagrams;
// the fretboard panel draws them on the neck itself, which is the instrument the
// diagrams were each a small copy of, so the sidebar is gone and its two callers
// are what is left here.

import { scroll } from "./dom.js";
import { draw } from "./repaint.js";
import { columnOf } from "./edit.js";
import { xOf, yOf } from "./geometry.js";
import { gridAt, segBarSec } from "./grid.js";
import { songBarStarts } from "./song-bars.js";
import { editLanes } from "./lanes.js";
import { selectedTablatureLane } from "./layer-role.js";
import { playbackTime } from "./playback.js";
import { S, setSelection } from "./store.js";
import { setPlaybackCursor } from "./tracing.js";
import { clamp } from "./util.js";
import { chordColumns, columnShapeChoices, lockedShape, overrideInfluence, shapeKey } from "./voicing-core.js";

export * from "./voicing-core.js";
export { analyzeChord, detectChord, PC_NAMES, pcName } from "./chords.js";

// Live voicing state for one column: its current (sounding) shape, the ranked
// playable shapes (easiest first), the current shape's rank, and whether it's
// manually pinned. `voiced` is the whole-lane voicing the export would produce.
export function columnVoicingState(colNotes, tuning, voiced) {
  const cur = new Map();
  for (const n of colNotes) { const p = voiced.get(n); if (p) cur.set(n, p); }
  const curKey = shapeKey(cur);
  const choices = columnShapeChoices(colNotes, tuning);
  if (cur.size && !choices.some((sh) => shapeKey(sh) === curKey)) choices.unshift(cur);
  return { cur, choices, curIdx: choices.findIndex((sh) => shapeKey(sh) === curKey), pinned: !!lockedShape(colNotes, tuning) };
}

// The distinct candidates, cheapest passage first. Every one of them is the written
// pitches in another place (the worker no longer enumerates re-voicings), so the
// drift tiers that used to order this list are all zero and cost is the whole sort.
// `skipKey` drops the shape the caller is already showing.
//
// The RANK is still never printed — a printed 1st/2nd/3rd invites reading a model
// estimate as a verdict on which shape is correct. The COST now is, on the board (see
// drawCost): the stage marks columns where the voicer reused a remembered grip while
// a cheaper one was on offer, and a mark asserting "there was a better answer here"
// with no way to see how much better is that same verdict with its evidence withheld.
// A number invites arithmetic; an ordinal invites obedience.
function rankArrangements(all, skipKey = "") {
  const seen = new Set([skipKey]);
  const overall = (choice) => finiteCost(choice, "passage") ?? Infinity;
  return all
    .filter((choice) => {
      const key = shapeKey(choice.shape);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    })
    .sort((a, b) => overall(a) - overall(b));
}

// Every other way to play one column, for a caller that draws it itself: the
// fretboard puts them on the neck it is already drawing.
//
// `current` is not sent to the worker — the board draws the lane's own voicing for
// that column, which is the same shape by definition. So everything that comes back
// is somewhere else, and nothing has to be filtered out of it.
export function columnAlternatives(note, done) {
  const ctx = columnOf(note);
  if (!ctx) { done(null); return; }
  const { lane, tuning, col } = ctx;
  const columns = chordColumns(lane.notes);
  const focusIdx = columns.findIndex((c) => c.notes.includes(note));
  if (focusIdx < 0) { done(null); return; }
  const influence = overrideInfluence(col.notes);
  requestArrangementChoices({
    analysis: null, columns, focusIdx, tuning,
    sourcePitches: col.notes.map((n) => n.pitch),
    current: null, influence,
    context: scoringContext(col.t0),
    // An offer is priced by walking the lane to this column, so it has to walk it
    // under the same bar plan the tab did — otherwise the board ranks shapes against
    // a hand that was never there.
    bars: songBarStarts(),
    // The neck the shapes are priced against. Without it the worker falls back to
    // the electric's 22 frets and would offer an acoustic a shape at fret 21.
    instrument: lane.instrument,
    // And where the hand has been put. An offer priced against a hand the player
    // moved is priced against a hand that is not there.
    holds: lane.handHolds,
  }, (raw) => {
    const ranked = rankArrangements(raw.map(deserializeArrangement));
    // Which notes are muted is a property of the note, not of where it is put, and
    // the worker's answer carries only pitches. With re-voicings off a candidate is
    // this column's notes in another place — the worker pushes `focusNotes` itself
    // and serializes them in order — so the flag comes back by index. The board draws
    // a mute as an X wherever it lands, so the offer has to know.
    for (const choice of ranked) {
      choice.notes.forEach((n, i) => { n.dead = !!col.notes[i]?.fx?.dead; });
    }
    done({ lane, tuning, t0: col.t0, notes: col.notes, influence, ranked });
  });
}

let recommendationWorker = null;
const recommendationCache = new Map();
function requestArrangementChoices(payload, done) {
  recommendationWorker?.terminate();
  recommendationWorker = null;
  const key = recommendationCacheKey(payload);
  if (recommendationCache.has(key)) {
    const cached = recommendationCache.get(key);
    recommendationCache.delete(key); recommendationCache.set(key, cached);
    queueMicrotask(() => done(cached));
    return;
  }
  const worker = new Worker(new URL("./voicing-worker.js", import.meta.url), { type: "module" });
  recommendationWorker = worker;
  worker.onmessage = (ev) => {
    if (recommendationWorker !== worker) return;
    worker.terminate(); recommendationWorker = null;
    const choices = ev.data.choices || [];
    recommendationCache.set(key, choices);
    if (recommendationCache.size > 20) recommendationCache.delete(recommendationCache.keys().next().value);
    done(choices);
  };
  worker.onerror = () => {
    if (recommendationWorker !== worker) return;
    worker.terminate(); recommendationWorker = null; done([]);
  };
  worker.postMessage(payload);
}

function recommendationCacheKey({ analysis, columns, focusIdx, tuning, sourcePitches, current, influence, context, bars, instrument, holds }) {
  const lane = columns.map((c, i) => ({
    t0: c.t0,
    notes: c.notes.map((n) => ({
      pitch: n.pitch, start: n.start, end: n.end,
      slide: n.slide, bend: n.bend, harmonic: n.harmonic, stroke: n.stroke,
      dead: !!n.fx?.dead, vibrato: !!n.fx?.vibrato,
      pos: i === focusIdx ? null : n.pos,
      arrangement: i === focusIdx ? null : n.arrangement,
    })),
  }));
  return JSON.stringify([
    analysis?.root, analysis?.pcs, analysis?.fullPcs, tuning, sourcePitches,
    focusIdx, current, influence, context, bars, instrument, holds, lane,
  ]);
}

// The worker also returns each candidate's window-local neighbours (`raw.path`).
// That was the sidebar's before/after strip; the neck draws the lane's real
// neighbours through onion skin instead, so it is dropped on the way in.
function deserializeArrangement(raw) {
  const notes = raw.notes.map((n) => ({ pitch: n.pitch }));
  return {
    kind: raw.kind || "arranged", current: !!raw.current, costs: raw.costs || {}, notes,
    // The hand the engine would play this shape with, priced by the same solve — see
    // scoreShapesAsDecided. By string, because note objects do not cross the worker.
    seat: raw.seat ?? null, fingers: new Map(raw.fingers || []),
    shape: new Map(notes.flatMap((n, i) => raw.positions[i] ? [[n, raw.positions[i]]] : [])),
  };
}

// Boundary material for contextWindow(): the user's section markers and the bar
// length in force at this chord. Both are optional — a lane with neither still
// gets the phrase/column fallback inside the engine.
function scoringContext(t) {
  const bar = segBarSec(gridAt(t));
  return {
    sectionTimes: (S.state?.sectionMarkers || []).map((m) => Number(m?.t)).filter(Number.isFinite),
    barSeconds: Number.isFinite(bar) && bar > 0 ? bar : null,
  };
}

const finiteCost = (choice, key) => Number.isFinite(choice.costs?.[key]) ? choice.costs[key] : null;

// Scroll the editor so `notes` are centred in the viewport (both axes).
function centerViewOnNotes(notes) {
  if (!notes.length) return;
  const cx = xOf((Math.min(...notes.map((n) => n.start)) + Math.max(...notes.map((n) => n.end))) / 2);
  const cy = (yOf(Math.max(...notes.map((n) => n.pitch))) + yOf(Math.min(...notes.map((n) => n.pitch))) + S.state.rowH) / 2;
  scroll.scrollLeft = clamp(cx - scroll.clientWidth / 2, 0, Math.max(0, scroll.scrollWidth - scroll.clientWidth));
  scroll.scrollTop = clamp(cy - scroll.clientHeight / 2, 0, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
  draw();
}

// Move the focus to the column containing `note`: select that column's notes and
// jump the playhead + view to them. The fretboard follows the playhead, so this is
// what puts a chord on the neck.
function focusColumn(note, { seek = true } = {}) {
  const ctx = note && columnOf(note);
  if (!ctx) return;
  setSelection(new Set(ctx.col.notes));
  // ↑ ↓ pick between two things sounding at the same moment, so they must not move
  // the playhead: moving it would change the very set they are choosing from.
  if (seek) setPlaybackCursor(ctx.col.t0);
  centerViewOnNotes(ctx.col.notes);   // ends with draw()
}

// The lane the arrow keys walk: the one the fretboard is drawing.
function arrowLane() {
  return selectedTablatureLane(editLanes());
}

// ← → anywhere: the previous / next onset column in that lane, stepped from **the
// playhead** rather than from the selection. The playhead is where the neck already
// is, and focusColumn moves it to whatever it lands on, so repeated presses walk
// the song. This used to be bound only while the tab preview was open, which made
// the one gesture for reading a piece a property of a window being open.
export function stepColumnFocus(dir) {
  const lane = arrowLane();
  if (!lane) return;
  const cols = chordColumns(lane.notes);
  if (!cols.length) return;
  // A hair of slack, or → from a column's own onset finds that same column again:
  // the playhead is parked on it to the microsecond.
  const t = playbackTime() + (dir > 0 ? 1e-3 : -1e-3);
  const next = dir > 0 ? cols.find((c) => c.t0 > t) : [...cols].reverse().find((c) => c.t0 < t);
  if (next) focusColumn(next.notes[0]);
}

// ↑ ↓: between the columns *sounding at once*. A note held while another line moves
// under it is deliberately not one chord — the onset grouping says so — which leaves
// two independent things at one moment, and one playhead cannot name both. Ordered
// by pitch, because that is what up and down mean on an instrument.
const colPitch = (col) => Math.max(...col.notes.map((n) => n.pitch));

export function stepVoiceFocus(dir) {
  const lane = arrowLane();
  if (!lane) return;
  const t = playbackTime() + 1e-3;
  const sounding = chordColumns(lane.notes)
    .filter((c) => c.t0 <= t && Math.max(...c.notes.map((n) => n.end)) >= t)
    .sort((a, b) => colPitch(a) - colPitch(b));
  if (sounding.length < 2) return;
  const here = sounding.findIndex((c) => c.notes.some((n) => S.selection.has(n)));
  const idx = clamp((here < 0 ? (dir > 0 ? -1 : sounding.length) : here) + dir, 0, sounding.length - 1);
  if (idx !== here) focusColumn(sounding[idx].notes[0], { seek: false });
}
