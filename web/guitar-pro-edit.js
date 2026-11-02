// Source-preserving editor projection -> alphaTab score adapter.
//
// The imported alphaTab score remains authoritative for every construct the
// editor does not touch.  Simple changes are patched onto those source objects.
// Only voices containing added/deleted/moved/resized notes are rebuilt, and
// even there original beats/notes are reused whenever their rhythmic slot still
// exists.  This keeps custom GP data out of the lossy flat-note conversion path.

import { SLIDE_IN, SLIDE_OUT, bendAt, bendCurve, bendPeak, bendShape, slideInOf } from "./bend.js";
import { whammyCurve } from "./whammy.js";
import { gpSlideAt } from "./guitar-pro-core.js";
import { MAX_RHYTHM_PIECES, MAX_TIE_CHAIN } from "./constants.js";
import { TUNINGS } from "./tunings.js";
import { parseTuning } from "./util.js";
import { arrangedNotes, chordColumns, representPickedOpenSlides, unstacked, voiceNotes } from "./voicing-core.js";

const QUARTER_TICKS = 960;
const TICK_QUANTUM = 15; // a 1/256 note; finer than the editor's normal grid
const MAX_VOICES = 4;

function same(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
function effectsOf(note) {
  const out = {};
  for (const key of ["slide", "slideIn", "bend", "bendPoints", "harmonic", "grace", "trill", "tremPick", "slap", "stroke", "ornament",
    "whammy", "whammyPoints", "vibratoStart", "slideStart", "finger"])
    if (note[key] != null) out[key] = note[key];
  if (note.fx && Object.keys(note.fx).length) out.fx = { ...note.fx };
  return out;
}

function tuningFromImportedLane(lane) {
  const tuning = parseTuning(lane.customTuning);
  if (!tuning) throw new Error(`Modern export cannot parse the tuning on “${lane.name}”.`);
  return tuning;
}


function tuningFromLane(lane) {
  if (TUNINGS[lane.tuning]) return [...TUNINGS[lane.tuning].tuning];
  if ((lane.customTuning || "").trim()) return tuningFromImportedLane(lane);
  return [...(String(lane.instrument || "").includes("bass") ? TUNINGS.bass4.tuning : TUNINGS.guitar6.tuning)];
}

export function validateImportedProjection(lanes) {
  for (const lane of lanes) {
    const tuning = tuningFromImportedLane(lane);
    const transposition = pitchOffset(lane);
    const ids = new Set();
    for (const note of lane.notes) {
      const sourceId = note.gp?.noteId;
      if (Number.isFinite(sourceId)) {
        if (ids.has(sourceId)) throw new Error(`Modern export found a duplicate source note on “${lane.name}”.`);
        ids.add(sourceId);
      }
      const position = resolvedPosition(note, tuning, transposition);
      if (!position) throw new Error(`A pitch on “${lane.name}” is below every open string in its tuning.`);
      if (!Number.isFinite(note.start) || !Number.isFinite(note.end) || note.end <= note.start)
        throw new Error(`Modern export found an invalid note duration on “${lane.name}”.`);
    }
  }
}

// What a fret's pitch is short of open string + fret: alphaTab's pitch is
// fret + open + capo - transposition, and frets count from the capo.
const pitchOffset = (lane) => (Number(lane.transpositionPitch) || 0) - (Number(lane.capo) || 0);

function resolvedPosition(note, tuning, transposition = 0) {
  const string = Number(note.pos?.string), fret = Number(note.pos?.fret), pitch = Number(note.pitch);
  if (Number.isInteger(string) && string >= 0 && string < tuning.length && Number.isFinite(fret) && fret >= 0
      && Math.abs(tuning[string] + fret - transposition - pitch) < 1e-6) return { string, fret: Math.round(fret) };
  // A stale position (the pitch was edited since) has lapsed: the note is fingered anew.
  let best = null;
  for (let index = 0; index < tuning.length; index++) {
    const candidate = Math.round(pitch + transposition - tuning[index]);
    if (candidate >= 0 && (!best || candidate < best.fret)) best = { string: index, fret: candidate };
  }
  return best;
}

function masterBarDuration(bar) {
  return typeof bar.calculateDuration === "function" ? bar.calculateDuration()
    : Math.round((bar.timeSignatureNumerator || 4) * 4 / (bar.timeSignatureDenominator || 4) * QUARTER_TICKS);
}

function timeline(score) {
  const points = [];
  let fallback = 0;
  for (const bar of score.masterBars || []) {
    const start = Number.isFinite(bar.start) ? bar.start : fallback;
    const duration = masterBarDuration(bar);
    for (const automation of [...(bar.tempoAutomations || [])].sort((a, b) => a.ratioPosition - b.ratioPosition))
      points.push({ tick: start + duration * (automation.ratioPosition || 0), bpm: Math.max(1, Number(automation.value) || score.tempo || 120) });
    fallback = start + duration;
  }
  if (!points.length || points[0].tick > 0) points.unshift({ tick: 0, bpm: Math.max(1, Number(score.tempo) || 120) });
  points.sort((a, b) => a.tick - b.tick);
  const compact = [];
  for (const point of points) {
    const previous = compact[compact.length - 1];
    if (previous && Math.abs(previous.tick - point.tick) < 1e-6) previous.bpm = point.bpm;
    else compact.push(point);
  }
  let seconds = 0;
  for (let i = 0; i < compact.length; i++) {
    if (i) seconds += (compact[i].tick - compact[i - 1].tick) / QUARTER_TICKS * 60 / compact[i - 1].bpm;
    compact[i].seconds = seconds;
  }
  return compact;
}

function secondsToTick(seconds, points) {
  let point = points[0];
  for (let i = 1; i < points.length && points[i].seconds <= seconds + 1e-9; i++) point = points[i];
  return point.tick + (seconds - point.seconds) * QUARTER_TICKS * point.bpm / 60;
}

// The nearest tick a note can start on: the 1/256 grid, or a triplet's (a third of
// 120, the 1/32 triplet note), whichever is closer. A triplet drawn in the editor
// lands on its triplet tick, not 5 ticks off it.
const TRIPLET_QUANTUM = 40;
function tickToSeconds(tick, points) {
  let point = points[0];
  for (let i = 1; i < points.length && points[i].tick <= tick + 1e-9; i++) point = points[i];
  return point.seconds + (tick - point.tick) / QUARTER_TICKS * 60 / point.bpm;
}

// Where ticks a..b fall in a note from tick start to end, as fractions of its length
// in seconds: how the editor measures where an effect happens in a note.
function partOf(points, start, end, a, b) {
  const s0 = tickToSeconds(start, points), length = tickToSeconds(end, points) - s0;
  const at = (tick) => length > 0 ? Math.max(0, Math.min(1, (tickToSeconds(tick, points) - s0) / length)) : 0;
  return [at(a), at(b)];
}

function quantizeTick(value) {
  const even = Math.round(value / TICK_QUANTUM) * TICK_QUANTUM, triplet = Math.round(value / TRIPLET_QUANTUM) * TRIPLET_QUANTUM;
  return Math.max(0, Math.abs(triplet - value) < Math.abs(even - value) ? triplet : even);
}

function barBounds(score) {
  return score.masterBars.map((bar, index) => ({ index, start: bar.start, end: bar.start + masterBarDuration(bar) }));
}

// A grace note is written in the bar of the note it leads into.
const inBar = (item, bar) => item.grace ? item.attach >= bar.start && item.attach < bar.end
  : item.startTick < bar.end && item.endTick > bar.start;

function barsOverlapping(bounds, start, end) {
  return bounds.filter((bar) => start < bar.end && end > bar.start).map((bar) => bar.index);
}

function durationFigures() {
  const out = [];
  for (const duration of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const base = 4 * QUARTER_TICKS / duration;
    for (const dots of [2, 1, 0]) {
      const factor = dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1;
      const ticks = base * factor;
      if (Number.isInteger(ticks) && ticks >= TICK_QUANTUM) out.push({ ticks, duration, dots });
    }
  }
  return out.sort((a, b) => b.ticks - a.ticks || a.duration - b.duration);
}
const FIGURES = durationFigures();

// Triplet figures (three in the time of two), for spans the plain figures cannot
// spell: an imported triplet keeps its exact ticks (planLane), off the 1/256 grid,
// and so does the rhythm around it.
// Other tuplets (a 6:4, a 5:4) come from the file's notes in the bar (`ratios`).
const tupletFigures = (n, d) => [1, 2, 4, 8, 16, 32, 64].map((duration) =>
  ({ ticks: 4 * QUARTER_TICKS / duration * d / n, duration, dots: 0, tuplet: [n, d] })).filter((f) => f.ticks >= 1);

function decompose(ticks, ratios = []) {
  const result = [];
  let remaining = Math.round(ticks);
  // The file's ratio first: a 6:4 lasts as long as a triplet and is written as itself.
  const figures = [...ratios, [3, 2]].flatMap(([n, d]) => tupletFigures(n, d)).sort((a, b) => b.ticks - a.ticks);
  while (remaining % TICK_QUANTUM && remaining > 0) {
    const figure = figures.find((candidate) => candidate.ticks <= remaining + 1e-6 && Number.isInteger(Math.round(candidate.ticks * 1e6) / 1e6));
    if (!figure) break;
    result.push(figure);
    remaining -= figure.ticks;
  }
  remaining = result.length && remaining < TICK_QUANTUM / 2 ? 0 : Math.max(TICK_QUANTUM, quantizeTick(remaining));
  while (remaining > 0) {
    const figure = FIGURES.find((candidate) => candidate.ticks <= remaining) || FIGURES[FIGURES.length - 1];
    result.push(figure);
    remaining -= figure.ticks;
    if (result.length > MAX_RHYTHM_PIECES) throw new Error("Modern export could not represent an edited rhythm.");
  }
  return result;
}

function sourceNotes(staff) {
  const byId = new Map(), origins = [];
  for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
    byId.set(note.id, note);
    if (!note.isTieDestination) origins.push(note);
  }
  return { byId, origins };
}

function resetRelationships(note) {
  for (const key of ["bendOrigin", "hammerPullOrigin", "hammerPullDestination", "slurOrigin", "slurDestination",
    "slideTarget", "slideOrigin", "tieOrigin", "tieDestination", "effectSlurOrigin", "effectSlurDestination"])
    note[key] = null;
  note.isTieDestination = false;
}

// Copy every field alphaTab's model exposes EXCEPT the ones it owns itself.
// Two kinds are skipped, and that is the whole criterion:
//   1. identity and graph links (id, index, beat, tie/slur/slide partners) —
//      copying them points the clone at the original's neighbours;
//   2. anything score.finish() recomputes (bend points are rebuilt through
//      addBendPoint below so the derived maxBendPoint comes out consistent).
// A new alphaTab version adding a field of either kind means adding it here;
// everything else copies correctly by default, which is why this is a skip list
// and not an allow list.
function copyNote(alphaTab, source) {
  const note = new alphaTab.model.Note();
  if (!source) return note;
  const skip = new Set(["id", "index", "beat", "bendOrigin", "hammerPullOrigin", "hammerPullDestination", "slurOrigin",
    "slurDestination", "slideTarget", "slideOrigin", "tieOrigin", "tieDestination", "effectSlurOrigin", "effectSlurDestination",
    "bendPoints", "maxBendPoint"]);
  for (const key of Object.keys(source)) if (!skip.has(key)) note[key] = source[key];
  if (source.bendPoints?.length) for (const point of source.bendPoints)
    note.addBendPoint(new alphaTab.model.BendPoint(point.offset, point.value));
  return note;
}

// Same criterion as copyNote, plus a third: everything describing the beat's
// RHYTHM (duration, dots, tuplets, display/playback timing) is skipped, because
// the caller is re-deriving it. This copies what a beat *means* — its effects,
// text, dynamics — onto a beat whose timing is being rebuilt.
function copyBeatSemantics(alphaTab, source) {
  const beat = new alphaTab.model.Beat();
  if (!source) return beat;
  const skip = new Set(["id", "index", "voice", "notes", "noteStringLookup", "noteValueLookup", "previousBeat", "nextBeat",
    "duration", "dots", "tupletNumerator", "tupletDenominator", "tupletGroup", "displayStart", "playbackStart",
    "displayDuration", "playbackDuration", "graceGroup", "graceIndex", "whammyBarPoints", "maxWhammyPoint", "minWhammyPoint"]);
  for (const key of Object.keys(source)) {
    if (skip.has(key)) continue;
    const value = source[key];
    if (value == null || typeof value !== "object") beat[key] = value;
    else if (Array.isArray(value)) beat[key] = [...value];
    else beat[key] = value;
  }
  if (source.whammyBarPoints?.length) for (const point of source.whammyBarPoints)
    beat.addWhammyBarPoint(new alphaTab.model.BendPoint(point.offset, point.value));
  return beat;
}

// alphaTab offsets run 0..60 and values are quarter-tones, same as the .gp5 file.
// A hand-edited curve is fed through verbatim as BendType.Custom — the shape
// presets only tell alphaTab which glyph to draw, and none of them describes an
// arbitrary curve.
// `from`/`to`: the part of the note this written note is. `written`: whether the file
// wrote a bend on this part (null: decide from the curve, a held part gets none).
function setBend(alphaTab, note, editorNote, from = 0, to = 1, written = null) {
  note.bendPoints = null; note.maxBendPoint = null; note.bendType = alphaTab.model.BendType.None;
  const whole = bendCurve(editorNote);
  if (!whole || written === false) return;
  if (from > 1e-6 || to < 1 - 1e-6) {
    const inside = whole.filter(([t]) => t > from + 1e-6 && t < to - 1e-6);
    const slice = [[from, bendAt(whole, from)], ...inside, [to, bendAt(whole, to)]];
    const held = slice.every(([, v]) => Math.abs(v - slice[0][1]) < 1e-6);
    if (slice.every(([, v]) => Math.abs(v) < 1e-6) || (held && from > 1e-6 && written === null)) return;
    while (slice.length > 2 && Math.abs(slice[0][1] - slice[1][1]) < 1e-6) slice.shift();
    while (slice.length > 2 && Math.abs(slice.at(-1)[1] - slice.at(-2)[1]) < 1e-6) slice.pop();
    note.bendType = alphaTab.model.BendType.Custom;
    for (const [t, v] of slice)
      note.addBendPoint(new alphaTab.model.BendPoint(Math.round((t - from) / (to - from) * 60 * 1000) / 1000, Math.round(v * 2)));
    return;
  }
  const pts = whole;
  const SHAPES = { bend: alphaTab.model.BendType.Bend, bendRelease: alphaTab.model.BendType.BendRelease,
    bendReleaseBend: alphaTab.model.BendType.Custom, prebend: alphaTab.model.BendType.Prebend,
    prebendRelease: alphaTab.model.BendType.PrebendRelease };
  const shape = editorNote.bendPoints?.length ? "custom" : bendShape(pts);
  note.bendType = SHAPES[shape] ?? alphaTab.model.BendType.Custom;
  const peak = Math.round(bendPeak(pts) * 2);
  const points =
    // A plain rise is encoded by alphaTab as one continuous line. Feeding it the
    // preset's redundant midpoint looks harmless in memory but is normalized away
    // by Score.finish/export, and made strict round-trip checks disagree.
    shape === "bend" ? [[0, 0], [60, peak]]
      // alphaTab's canonical BendRelease shape has two identical middle points:
      // its renderer reads point 3 as the released value when bendType is already
      // explicit, so the plain three-point curve is valid GP input but not a
      // valid constructed alphaTab BendRelease model.
      : shape === "bendRelease" ? [[0, 0], [30, peak], [30, peak], [60, Math.round(pts[pts.length - 1][1] * 2)]]
        : shape === "prebend" ? [[0, peak], [60, peak]]
          : pts.map(([t, v]) => [t * 60, Math.round(v * 2)]);
  for (const [offset, value] of points) note.addBendPoint(new alphaTab.model.BendPoint(offset, value));
}

// The part of a note's whammy curve between `from` and `to` (fractions of the
// note), on the beat of that part: offsets 0..60 and quarter-tones.
function setWhammy(alphaTab, beat, editorNote, from = 0, to = 1) {
  beat.whammyBarPoints = null; beat.maxWhammyPoint = null; beat.minWhammyPoint = null;
  beat.whammyBarType = alphaTab.model.WhammyType.None;
  const curve = whammyCurve(editorNote);
  if (!curve || to <= from) return;
  const inside = curve.filter(([t]) => t > from + 1e-6 && t < to - 1e-6);
  const points = [[from, bendAt(curve, from)], ...inside, [to, bendAt(curve, to)]];
  if (points.every(([, v]) => Math.abs(v) < 1e-6)) return;
  // A value held from the part's start, or to its end, needs no point of its own.
  while (points.length > 2 && Math.abs(points[0][1] - points[1][1]) < 1e-6) points.shift();
  while (points.length > 2 && Math.abs(points.at(-1)[1] - points.at(-2)[1]) < 1e-6) points.pop();
  const kind = editorNote.whammy;
  beat.whammyBarType = from === 0 && to === 1 && kind === "dip" ? alphaTab.model.WhammyType.Dip
    : from === 0 && to === 1 && kind === "dive" ? alphaTab.model.WhammyType.Dive : alphaTab.model.WhammyType.Custom;
  beat.isContinuedWhammy = from > 0 && Math.abs(points[0][1]) > 1e-6;
  for (const [t, v] of points)
    beat.addWhammyBarPoint(new alphaTab.model.BendPoint(Math.round((t - from) / (to - from) * 60 * 1000) / 1000, Math.round(v * 2)));
}

function setTremoloPicking(alphaTab, beat, preset) {
  beat.tremoloPicking = undefined;
  const targetDuration = Number(preset);
  if (![8, 16, 32].includes(targetDuration)) return;
  const baseDuration = Math.max(1, Math.abs(Number(beat.duration) || 4));
  const effect = new alphaTab.model.TremoloPickingEffect();
  effect.marks = Math.max(1, Math.min(5, Math.round(Math.log2(targetDuration / baseDuration))));
  beat.tremoloPicking = effect;
}

// `from`/`to` say which part of the editor note this written note is (fractions):
// a long note goes out as tied parts, and each part gets what happens during it.
// `part` is the file's own tied part this note is (gp.tieSegments, with what the file
// marked on it), when the parts still fall where the file had them: an effect the
// editor has not changed is then written on it as the file had it. Otherwise, and for
// notes the editor made, the parts get what most files do (counted over real files,
// tools/gp-audit): a dead note, palm mute, let ring and harmonic on every part, a
// ghost note, staccato and accent on the first.
function applyEditorEffects(alphaTab, sourceProjection, targetNote, targetBeat, force = false, from = 0, to = 1, part = null) {
  if (!force && !sourceProjection.gp?.editorEffects) return;
  const current = effectsOf(sourceProjection), original = sourceProjection.gp?.editorEffects || {};
  const changed = (key) => force || !same(current[key], original[key]);
  const edited = (key) => !same(current[key], original[key]);
  const fx = current.fx || {}, oldFx = original.fx || {};
  const first = from < 1e-6, last = to > 1 - 1e-6;
  const asFile = (keys) => part && !keys.some(edited);
  const flag = (key, property, everyPart, on = true, off = false) => {
    if (!force && !!fx[key] === !!oldFx[key]) return;
    const value = part && !!fx[key] === !!oldFx[key] ? !!part[key] : !!fx[key] && (everyPart || first);
    targetNote[property] = value ? on : off;
  };
  flag("palmMute", "isPalmMute", true); flag("ghost", "isGhost", false); flag("letRing", "isLetRing", true);
  flag("staccato", "isStaccato", false); flag("dead", "isDead", true);
  flag("accent", "accentuated", false, alphaTab.model.AccentuationType.Normal, alphaTab.model.AccentuationType.None);
  // A typed finger, on the first part (an unchanged one stays as the file has it).
  if (changed("finger") && !asFile(["finger"])) targetNote.leftHandFinger = first && current.finger != null ? current.finger : alphaTab.model.Fingers.Unknown;
  // The editor knows a richer effect by a plainer name (a heavy accent is an accent, a
  // tapped harmonic a note, a trill a half or whole step): while the editor has not
  // changed it, the note gets the file's own.
  const gp = sourceProjection.gp || {};
  if (targetNote.accentuated && !!fx.accent === !!oldFx.accent && (part?.accent || gp.accentuated))
    targetNote.accentuated = part?.accent || gp.accentuated;
  // Late vibrato is on the parts from where it starts, and stops where a late
  // slide-out does: the part that slides out is held still (as Guitar Pro writes it).
  // (The part that slides starts before the slide does: it moves in that part's last quarter, GP_SLIDE_AT.)
  const slideOutAt = SLIDE_OUT.has(current.slide)
    ? Math.max(0, ((Number(sourceProjection.slideStart) || 0) - gpSlideAt(current.slide)) / (1 - gpSlideAt(current.slide))) : 0;
  if (force || !!fx.vibrato !== !!oldFx.vibrato || changed("vibratoStart") || changed("slide"))
    targetNote.vibrato = (asFile(["vibratoStart", "slide"]) && !!fx.vibrato === !!oldFx.vibrato ? part.vibrato
      : fx.vibrato && (Number(current.vibratoStart) || 0) < to - 1e-6 && !(slideOutAt > 0 && from >= slideOutAt - 1e-6))
      // As wide as the file had it, while the editor's vibrato is the file's.
      ? (!!fx.vibrato === !!oldFx.vibrato && (part?.vibrato || sourceProjection.gp?.vibrato)) || alphaTab.model.VibratoType.Slight
      : alphaTab.model.VibratoType.None;
  // The editor flags where a hammer-on lands (true, "dest", "both"); Guitar Pro the
  // note it starts from. An origin role is this note's; a landing marks the note
  // before it (linkHammerOrigins), once the score is linked.
  if (force || !same(fx.hammer, oldFx.hammer)) {
    if (!fx.hammer && targetNote.isHammerPullDestination && targetNote.hammerPullOrigin)
      targetNote.hammerPullOrigin.isHammerPullOrigin = false;
    targetNote.isHammerPullOrigin = last && (fx.hammer === "origin" || fx.hammer === "both");
  }
  if (changed("slide") || changed("slideIn")) {
    const into = first ? slideInOf(current) : null, on = last && !SLIDE_IN.has(current.slide) ? current.slide : null;
    targetNote.slideInType = asFile(["slide", "slideIn"]) ? part.slideInType || alphaTab.model.SlideInType.None
      : into === "inBelow" ? alphaTab.model.SlideInType.IntoFromBelow
        : into === "inAbove" ? alphaTab.model.SlideInType.IntoFromAbove : alphaTab.model.SlideInType.None;
    targetNote.slideOutType = asFile(["slide", "slideIn", "slideStart"]) ? part.slideOutType || alphaTab.model.SlideOutType.None
      : last && !edited("slide") && gp.slideOutType > 4 ? gp.slideOutType   // a pick slide
      : { shift: alphaTab.model.SlideOutType.Shift, legato: alphaTab.model.SlideOutType.Legato,
        outUp: alphaTab.model.SlideOutType.OutUp, outDown: alphaTab.model.SlideOutType.OutDown, pickDown: alphaTab.model.SlideOutType.PickSlideDown, pickUp: alphaTab.model.SlideOutType.PickSlideUp }[on] ?? alphaTab.model.SlideOutType.None;
  }
  // A long editor note may be represented as tied score segments, and its bend is
  // one gesture across them: each part gets its stretch of the curve. A part that
  // only holds where the bend got to gets none, as Guitar Pro writes it (alphaTab
  // carries the bend on over tied parts); where the file wrote one, it gets it.
  if (changed("bend") || changed("bendPoints"))
    setBend(alphaTab, targetNote, current, from, to, asFile(["bend", "bendPoints"]) ? !!part.bend : null);
  if (changed("harmonic")) {
    targetNote.harmonicType = asFile(["harmonic"]) ? part.harmonicType || 0
      : !edited("harmonic") && gp.harmonicType ? gp.harmonicType
      : current.harmonic === "natural" ? alphaTab.model.HarmonicType.Natural
        : current.harmonic === "artificial" ? alphaTab.model.HarmonicType.Artificial
        : current.harmonic === "pinch" ? alphaTab.model.HarmonicType.Pinch : alphaTab.model.HarmonicType.None;
    // Where along the string a harmonic is touched: the file's, while the editor's harmonic is the file's.
    if (!edited("harmonic") && sourceProjection.gp?.harmonicValue) targetNote.harmonicValue = sourceProjection.gp.harmonicValue;
  }
  if (changed("ornament")) targetNote.ornament = asFile(["ornament"])
    ? part.noteExtras?.ornament || 0
    : first ? ({ invertedTurn: 1, turn: 2, upperMordent: 3, lowerMordent: 4 }[current.ornament] || 0) : 0;
  if (changed("trill")) {
    const file = part && !edited("trill") ? part : gp;
    const asFiled = !edited("trill") && (part ? true : gp.trillValue >= 0);
    targetNote.trillValue = asFiled ? file.trillValue ?? -1 : current.trill ? targetNote.fret + (current.trill === "whole" ? 2 : 1) : -1;
    if (targetNote.trillValue >= 0) targetNote.trillSpeed = asFiled ? file.trillSpeed ?? 32 : alphaTab.model.Duration.Sixteenth;
  }
  if (changed("tremPick")) setTremoloPicking(alphaTab, targetBeat, current.tremPick);
  // A strum, slap or tap is the pick: on the first part only.
  if (changed("slap") && !first) { targetBeat.tap = false; targetBeat.slap = false; targetBeat.pop = false; }
  else if (changed("slap")) {
    // Preserve the original notation for techniques projected onto the same
    // editor control (left-hand tap and dead slap), including tied parts.
    const originalParts = [gp, ...(gp.tieSegments || [])];
    const leftTap = !edited("slap") && originalParts.some((p) => p.isLeftHandTapped || p.noteExtras?.isLeftHandTapped);
    const deadSlap = !edited("slap") && originalParts.some((p) => p.beatExtras?.deadSlapped);
    if (deadSlap && !!fx.dead === !!oldFx.dead) targetNote.isDead = part ? !!part.dead : !!gp.isDead;
    targetBeat.tap = current.slap === "tap" && !leftTap;
    targetBeat.slap = current.slap === "slap" && !deadSlap;
    targetBeat.pop = current.slap === "pop";
    if (edited("slap")) { targetNote.isLeftHandTapped = false; targetBeat.deadSlapped = false; }
  }
  if (changed("stroke") && (current.stroke || original.stroke)) {
    // A strum the file wrote as a brush stays a brush; otherwise it is a pick stroke.
    const dir = !first ? 0 : current.stroke === "up" ? 1 : current.stroke === "down" ? 2 : 0;
    const brush = targetBeat.brushType || sourceProjection.gp?.brushType;
    if (brush) {
      targetBeat.brushType = dir ? (brush > 2 ? dir + 2 : dir) : 0;
      if (!dir) targetBeat.brushDuration = 0;
      else if (!targetBeat.brushDuration && sourceProjection.gp?.brushDuration) targetBeat.brushDuration = sourceProjection.gp.brushDuration;
    }
    else targetBeat.pickStroke = dir;
  }
  if (changed("whammy") || changed("whammyPoints")) setWhammy(alphaTab, targetBeat, current, from, to);
}

function addGraceBeat(alphaTab, voice, projected, tuning) {
  const beat = new alphaTab.model.Beat();
  beat.duration = alphaTab.model.Duration.ThirtySecond; beat.graceType = alphaTab.model.GraceType.BeforeBeat;
  const note = new alphaTab.model.Note();
  note.string = tuning.length - projected.pos.string;
  note.fret = Math.max(0, Math.round(projected.pos.fret) - (projected.grace === "whole" ? 2 : 1));
  note.isHammerPullOrigin = true;
  beat.addNote(note); voice.addBeat(beat);
}

function chooseVoices(notes) {
  const assigned = new Map(), occupied = Array.from({ length: MAX_VOICES }, () => []);
  const ordered = [...notes].sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick);
  // Source-authored voice choices are canonical, including deliberate overlap
  // and let-ring situations that look conflicting in the flattened editor.
  for (const item of ordered.filter((candidate) => Number.isInteger(candidate.projected.gp?.voice))) {
    const voice = Math.max(0, Math.min(MAX_VOICES - 1, item.projected.gp.voice));
    item.voice = voice; assigned.set(item.projected, voice); occupied[voice].push(item);
  }
  // Only genuinely new editor notes need automatic voice placement.
  for (const item of ordered.filter((candidate) => !Number.isInteger(candidate.projected.gp?.voice))) {
    // Lowest free voice wins. This used to prepend a `preferred` that was a
    // literal 0 and then dedupe the duplicate it had just created.
    const order = [0, 1, 2, 3].filter((value) => value < MAX_VOICES);
    const voice = order.find((candidate) => !occupied[candidate].some((other) =>
      other.string === item.string && other.startTick < item.endTick && item.startTick < other.endTick));
    if (voice == null) throw new Error("Modern export needs more than four voices to represent overlapping notes on one string.");
    item.voice = voice; assigned.set(item.projected, voice); occupied[voice].push(item);
  }
  return assigned;
}

function ensureVoice(alphaTab, bar, index) {
  while (bar.voices.length <= index) bar.addVoice(new alphaTab.model.Voice());
  return bar.voices[index];
}

// alphaTab chains every voice into the SAME voice of the next bar when it
// finishes a score (`nextBar.voices[index].beats`), so a second voice that exists
// in one bar only is a crash, not a layout. Padded the way a Guitar Pro file
// itself is: one empty beat per missing voice.
function evenVoiceCounts(alphaTab, staff) {
  const count = Math.max(1, ...staff.bars.map((bar) => bar.voices.length));
  for (const bar of staff.bars) while (bar.voices.length < count) {
    const voice = new alphaTab.model.Voice(), beat = new alphaTab.model.Beat();
    beat.isEmpty = true; voice.addBeat(beat); bar.addVoice(voice);
  }
}

// An imported grace note (planLane: gp.graceType, its timing untouched) plays
// before its beat and takes no time of its own: written back as a grace beat
// ahead of the note it leads into, and the note before it keeps its written length.
function addSourceGraces(alphaTab, voice, graces, tuning, sourceById) {
  const byStart = new Map();
  for (const item of graces) byStart.set(item.startTick, [...(byStart.get(item.startTick) || []), item]);
  for (const group of [...byStart.keys()].sort((a, b) => a - b).map((tick) => byStart.get(tick))) {
    const gp = group[0].projected.gp;
    const beat = copyBeatSemantics(alphaTab, sourceById.get(gp.noteId)?.beat);
    beat.notes = []; beat.noteStringLookup = new Map(); beat.noteValueLookup = new Map(); beat.isEmpty = false;
    beat.duration = gp.graceDuration || alphaTab.model.Duration.ThirtySecond; beat.dots = 0;
    beat.tupletNumerator = -1; beat.tupletDenominator = -1; beat.graceType = gp.graceType;
    if (!sourceById.get(gp.noteId)) restoreFileExtras(beat, gp.beatExtras);
    for (const item of group) {
      const source = sourceById.get(item.projected.gp.noteId), note = source || new alphaTab.model.Note();
      if (!source) restoreFileExtras(note, item.projected.gp.noteExtras);
      resetRelationships(note);
      note.string = tuning.length - item.string; note.fret = Math.round(item.projected.pos.fret);
      applyEditorEffects(alphaTab, item.projected, note, beat, !source);
      beat.addNote(note);
    }
    voice.addBeat(beat);
  }
}

// What the file said on a note or beat beyond the editor's fields (guitar-pro-core.js
// fileExtras), on one the export builds anew.
function restoreFileExtras(object, extras) {
  for (const [key, value] of Object.entries(extras || {})) object[key] = Array.isArray(value) ? [...value] : value;
}

// A chord name the layer holds (chord-names.js), on the beat it names. Only while it
// still names these tones (chordNameFor), as the editor shows it.
function nameChord(alphaTab, staff, beat, onset) {
  const pitches = [...new Set(onset.filter((item) => !item.projected.fx?.dead).map((item) => item.projected.pitch))]
    .sort((a, b) => a - b).join(",");
  const named = onset.find((item) => item.projected.chordName && item.projected.chordNameFor === pitches)?.projected;
  if (!named) return;
  // With the file's diagram while the name is the file's.
  const diagram = named.gp?.chordDiagram?.name === named.chordName ? named.gp.chordDiagram : null;
  const id = `chord ${named.chordName}${diagram ? " " + JSON.stringify(diagram) : ""}`;
  if (!staff.chords?.has(id)) {
    const chord = new alphaTab.model.Chord(); chord.name = named.chordName;
    restoreFileExtras(chord, diagram);
    staff.addChord(id, chord);
  }
  beat.chordId = id;
}

function rebuildVoice(alphaTab, staff, barIndex, voiceIndex, allItems, tuning, sourceById) {
  const bar = staff.bars[barIndex], voice = ensureVoice(alphaTab, bar, voiceIndex), master = bar.masterBar;
  const barStart = master.start, barEnd = barStart + masterBarDuration(master);
  const graces = allItems.filter((item) => item.grace);
  const items = allItems.filter((item) => !item.grace).map((item) => item.heldTo || item.writtenFrom != null
    ? { ...item, startTick: item.writtenFrom ?? item.startTick, endTick: item.heldTo ?? item.endTick, file: item } : item);
  const oldBeats = [...voice.beats];
  const reusable = new Map();
  for (const beat of oldBeats) {
    const key = `${beat.absolutePlaybackStart}:${beat.playbackDuration}`;
    if (!reusable.has(key)) reusable.set(key, []);
    reusable.get(key).push(beat);
  }
  const boundaries = new Set([barStart, barEnd]);
  for (const item of items) {
    boundaries.add(Math.max(barStart, item.startTick)); boundaries.add(Math.min(barEnd, item.endTick));
    // Tied parts where the file had them (its note values, and what happens on a later
    // part), and where a late slide or vibrato starts: Guitar Pro starts them on a part.
    const gp = item.projected.gp, length = item.endTick - item.startTick;
    const file = item.file || item;
    if (gp?.tieSegments && file.startTick === gp.startTick && file.endTick === gp.endTick)
      for (const segment of gp.tieSegments.slice(1)) boundaries.add(segment.startTick);
    const vibrato = Number(item.projected.vibratoStart);
    if (vibrato > 0 && vibrato < 1) boundaries.add(item.startTick + quantizeTick(vibrato * length));
    // A slide plays at a fixed point of its part (GP_SLIDE_AT): a later start is a tied
    // part that begins where that point lands on it. One the file had is in its parts already.
    const slide = Number(item.projected.slideStart), at = gpSlideAt(item.projected.slide);
    const asImported = gp && Math.abs((gp.editorEffects?.slideStart ?? 0) - slide) < 1e-6;
    const part = (slide - at) / (1 - at);
    if (!asImported && part > 1e-3 && part < 1) boundaries.add(item.startTick + quantizeTick(part * length));
  }
  // Rests keep the file's spelling where no note now sounds over them.
  for (const beat of oldBeats) if (beat.isRest && !items.some((item) =>
    item.startTick < beat.absolutePlaybackStart && item.endTick > beat.absolutePlaybackStart)) boundaries.add(beat.absolutePlaybackStart);
  const ordered = [...boundaries].filter((tick) => tick >= barStart && tick <= barEnd).sort((a, b) => a - b);
  const ratios = [...new Map(items.map((item) => item.projected.gp?.tuplet).filter((r) => r && !(r[0] === 3 && r[1] === 2))
    .map((r) => [r.join(":"), r])).values()];
  voice.beats = [];
  for (let boundaryIndex = 0; boundaryIndex < ordered.length - 1; boundaryIndex++) {
    let cursor = ordered[boundaryIndex], end = ordered[boundaryIndex + 1];
    const active = items.filter((item) => item.startTick <= cursor && item.endTick > cursor);
    // The tuplet of the note starting here, else what the bar's notes use.
    const own = active.filter((item) => item.startTick === cursor).map((item) => item.projected.gp?.tuplet).find(Boolean);
    for (const figure of decompose(end - cursor, own ? [own] : ratios)) {
      const onset = active.filter((item) => item.startTick === cursor);
      addSourceGraces(alphaTab, voice, graces.filter((g) => g.attach === cursor), tuning, sourceById);
      for (const item of onset) if (item.projected.grace) addGraceBeat(alphaTab, voice, item.projected, tuning);
      const key = `${cursor}:${figure.ticks}`;
      const bucket = reusable.get(key);
      const semanticSource = onset.map((item) => sourceById.get(item.projected.gp?.noteId)?.beat).find(Boolean);
      const reused = bucket?.length ? bucket.shift() : null;
      const beat = reused || copyBeatSemantics(alphaTab, semanticSource);
      if (!semanticSource) {
        nameChord(alphaTab, staff, beat, onset);
        // The beat's details as the file had them: a note's that starts here, else a tied part's.
        if (!reused) restoreFileExtras(beat, onset.map((item) => item.projected.gp?.beatExtras).find(Boolean)
          ?? active.map((item) => item.projected.gp?.tieSegments?.find((s) => s.startTick === cursor)?.beatExtras).find(Boolean));
      }
      beat.notes = []; beat.noteStringLookup = new Map(); beat.noteValueLookup = new Map();
      // A reused beat lasts these ticks already, written as the file writes them (a 6:4 stays 6:4).
      if (!reused) {
        beat.duration = figure.duration; beat.dots = figure.dots;
        beat.tupletNumerator = figure.tuplet ? figure.tuplet[0] : -1; beat.tupletDenominator = figure.tuplet ? figure.tuplet[1] : -1;
      }
      beat.isEmpty = false;
      for (const item of active) {
        const segmentIds = item.projected.gp?.tieSegments || [];
        const matching = segmentIds.find((segment) => segment.startTick === cursor);
        const source = matching ? sourceById.get(matching.noteId)
          : cursor === item.startTick && Number.isFinite(item.projected.gp?.noteId) ? sourceById.get(item.projected.gp.noteId) : null;
        const note = source || copyNote(alphaTab, sourceById.get(item.projected.gp?.noteId));
        if (!source) restoreFileExtras(note, matching && matching.startTick !== item.projected.gp?.startTick ? matching.noteExtras
          : cursor === item.startTick ? item.projected.gp?.noteExtras : null);
        resetRelationships(note);
        note.string = tuning.length - item.string; note.fret = Math.round(item.projected.pos.fret);
        note.isTieDestination = cursor !== item.startTick;
        // Each tied part gets what happens during it: slide-in on the first, slide-out on the last.
        // Measured on the note as it sounds (a note written on to a grace note's beat stops where it plays).
        const sounding = item.file || item;
        const [from, to] = partOf(item.points, sounding.startTick, sounding.endTick, cursor, cursor + figure.ticks);
        const file = item.file || item, unmoved = file.startTick === item.projected.gp?.startTick && file.endTick === item.projected.gp?.endTick;
        applyEditorEffects(alphaTab, item.projected, note, beat, !source, from, to, unmoved ? matching || null : null);
        // A reused part keeps what the file had on it. A slide-out the file wrote on its
        // last part stays on the last part, wherever the parts now fall.
        const wasLast = !segmentIds.length || matching === segmentIds.at(-1) || (!matching && source);
        if (to < 1 - 1e-6 && wasLast) note.slideOutType = alphaTab.model.SlideOutType.None;
        if (from > 1e-6 && !matching) note.slideInType = alphaTab.model.SlideInType.None;   // a file's own tied part keeps its own
        beat.addNote(note);
      }
      voice.addBeat(beat);
      cursor += figure.ticks;
    }
  }
}

function planLane(score, staff, lane, points, bounds, rebuildAll = false) {
  const { byId, origins } = sourceNotes(staff), items = [];
  const scoreEnd = bounds[bounds.length - 1]?.end || 0;
  for (const projected of lane.notes) {
    const rawStart = secondsToTick(projected.start, points), rawEnd = secondsToTick(projected.end, points);
    if (rawStart < -1 || rawEnd > scoreEnd + 1)
      throw new Error(`A note on “${lane.name}” extends beyond the imported score's first or final bar.`);
    // Round-tripped source seconds can carry tiny floating error. Preserve the
    // exact imported tick when the user has not actually moved that edge.
    let startTick = projected.gp && Math.abs(rawStart - projected.gp.startTick) < 1 ? projected.gp.startTick : quantizeTick(rawStart);
    let endTick = projected.gp && Math.abs(rawEnd - projected.gp.endTick) < 1 ? projected.gp.endTick : quantizeTick(rawEnd);
    startTick = Math.min(startTick, Math.max(0, scoreEnd - TICK_QUANTUM));
    endTick = Math.min(scoreEnd, Math.max(startTick + TICK_QUANTUM, endTick));
    const gp = projected.gp;
    const grace = gp?.graceType && startTick === gp.startTick && endTick === gp.endTick ? gp.graceType : 0;
    items.push({ projected, startTick, endTick, string: Number(projected.pos.string), grace, points });
  }
  const assignments = chooseVoices(items), affected = new Set();
  // A grace note takes its time in playback only: before the beat from the note
  // before it, which is written on to the beat; on the beat from the note it leads
  // into, which is written from the beat. `attach` is the beat it is written at.
  // Grace notes in a row (a rake) take their time together, from where the first starts
  // to where the last ends.
  const graces = items.filter((item) => item.grace);
  for (const grace of graces) {
    const voice = assignments.get(grace.projected);
    const inVoice = graces.filter((g) => assignments.get(g.projected) === voice);
    let first = grace.startTick, last = grace.endTick, next;
    while ((next = inVoice.find((g) => g.startTick === last && g.endTick > last))) last = next.endTick;
    while ((next = inVoice.find((g) => g.endTick === first && g.startTick < first))) first = next.startTick;
    const onBeat = grace.grace === 1;   // GraceType.OnBeat
    grace.attach = onBeat ? first : last;
    for (const item of items) if (!item.grace && assignments.get(item.projected) === voice) {
      if (!onBeat && item.endTick === first) item.heldTo = last;
      if (onBeat && item.startTick === last) item.writtenFrom = first;
    }
  }
  const currentIds = new Set(items.map((item) => item.projected.gp?.noteId).filter(Number.isFinite));
  for (const origin of origins) if (!currentIds.has(origin.id)) {
    let tail = origin, guard = 0;
    while (tail && guard++ < MAX_TIE_CHAIN) {
      affected.add(`${tail.beat.voice.bar.index}:${tail.beat.voice.index}`);
      tail = tail.isTieOrigin ? tail.tieDestination : null;
    }
  }
  for (const item of items) {
    const gp = item.projected.gp, assigned = assignments.get(item.projected);
    const changed = rebuildAll || !gp || Math.abs(item.startTick - gp.startTick) > 1 || Math.abs(item.endTick - gp.endTick) > 1 || assigned !== gp.voice;
    const graceChanged = !same(item.projected.grace, gp?.editorEffects?.grace);
    if (changed || graceChanged) {
      if (gp) for (const bar of barsOverlapping(bounds, gp.startTick, gp.endTick)) affected.add(`${bar}:${gp.voice}`);
      for (const bar of barsOverlapping(bounds, item.startTick, item.endTick)) affected.add(`${bar}:${assigned}`);
    }
  }
  return { byId, items, assignments, affected };
}

// `rebuildAll` rewrites every voice from the layer, as edits everywhere would (the audit, tools/gp-audit).
export function applyImportedProjection(alphaTab, score, lanes, selectedTrackIndexes, { rebuildAll = false } = {}) {
  validateImportedProjection(lanes);
  const selectedPosition = new Map((selectedTrackIndexes || []).map((sourceIndex, index) => [Number(sourceIndex), index]));
  const points = timeline(score), bounds = barBounds(score);
  const connectedSlidePlans = [];
  let didRebuild = false;
  for (const lane of lanes) {
    const track = score.tracks[selectedPosition.get(Number(lane.sourceTrackIndex))];
    const staff = track?.staves?.[Number(lane.sourceStaffIndex)];
    if (!track || !staff) throw new Error(`The source staff for “${lane.name}” is missing.`);
    if (track.staves.length === 1) track.name = lane.name;
    if (Number.isFinite(lane.gmProgram)) track.playbackInfo.program = Math.round(lane.gmProgram);
    const tuning = tuningFromImportedLane(lane);
    // Positions come in from laneFingering (guitar-pro-score.js), so this only
    // covers a headless caller. On COPIES: export must never edit the project.
    // Notes from the file stay as the file has them, a note doubled in a second voice
    // included (notation: one string, written twice); only the editor's own are unstacked.
    const fromFile = (lane.notes || []).filter((note) => Number.isFinite(note.gp?.noteId));
    const laneNotes = [...fromFile, ...unstacked((lane.notes || []).filter((note) => !fromFile.includes(note)))].map((note) => {
      const pos = resolvedPosition(note, tuning, pitchOffset(lane));
      return pos ? { ...note, pos: { ...note.pos, ...pos, scope: "local" } } : note;
    });
    const sourceTuning = [...(staff.stringTuning?.tunings || [])];
    const tuningChanged = sourceTuning.length !== tuning.length
      || sourceTuning.some((pitch, index) => pitch !== tuning[index]);
    staff.stringTuning.tunings = [...tuning];
    // Keep Guitar Pro's authored tuning label/standard flag when the app has
    // not changed the pitches. Clearing them made a pristine import subtly
    // different even though every note still sounded at the same pitch.
    if (tuningChanged) {
      staff.stringTuning.name = "";
      staff.stringTuning.isStandard = false;
    }
    staff.capo = Number(lane.capo) || 0;
    staff.transpositionPitch = Number(lane.transpositionPitch) || 0;
    staff.displayTranspositionPitch = Number(lane.displayTranspositionPitch) || 0;
    const projectedLane = {
      ...lane,
      notes: representPickedOpenSlides(laneNotes),
    };
    const plan = planLane(score, staff, projectedLane, points, bounds, rebuildAll);
    // Patch position and editor effects onto surviving source notes first. Voice
    // rebuilds below reuse these objects where possible.
    for (const item of plan.items) {
      const source = plan.byId.get(item.projected.gp?.noteId);
      if (!source) continue;
      source.string = tuning.length - item.string; source.fret = Math.round(item.projected.pos.fret);
      const { startTick, endTick, tieSegments } = item.projected.gp;
      const parts = tieSegments?.length > 1 ? tieSegments : [{ noteId: source.id, startTick, durationTicks: endTick - startTick }];
      for (const segment of parts) {
        const tied = plan.byId.get(segment.noteId);
        if (!tied) continue;
        tied.string = source.string; tied.fret = source.fret;
        // Each tied part gets what happens during it (see rebuildVoice).
        applyEditorEffects(alphaTab, item.projected, tied, tied.beat, false,
          ...partOf(points, startTick, endTick, segment.startTick, segment.startTick + segment.durationTicks), tieSegments?.length > 1 ? segment : null);
      }
    }
    for (const key of plan.affected) {
      didRebuild = true;
      const [barIndex, voiceIndex] = key.split(":").map(Number);
      const active = plan.items.filter((item) => plan.assignments.get(item.projected) === voiceIndex && inBar(item, bounds[barIndex]));
      rebuildVoice(alphaTab, staff, barIndex, voiceIndex, active, tuning, plan.byId);
    }
    evenVoiceCounts(alphaTab, staff);
    connectedSlidePlans.push({ staff, plan });
  }
  if (didRebuild) score.finish(new alphaTab.Settings());
  if (restoreConnectedSlideLinks(alphaTab, connectedSlidePlans) + linkHammerOrigins(connectedSlidePlans))
    score.finish(new alphaTab.Settings());
  return score;
}

function normalizeAutomaticStringPerformance(notes) {
  const kept = new Set(notes);
  let dropped = 0, shortened = 0;
  const stringCount = notes.reduce((count, note) => Math.max(count, (Number(note.pos?.string) + 1) || 0), 0);
  for (let string = 0; string < stringCount; string++) {
    const onString = notes.filter((note) => Number(note.pos?.string) === string)
      .sort((a, b) => a.start - b.start || a.pos.fret - b.pos.fret || a.end - b.end);
    const ordered = [];
    for (let index = 0; index < onString.length;) {
      let end = index + 1;
      while (end < onString.length && Math.abs(onString[end].start - onString[index].start) < 1e-6) end++;
      // One string cannot sound two frets at one onset. Keep the lower fret,
      // matching the legacy GP5 writer's collision behavior.
      ordered.push(onString[index]);
      for (let duplicate = index + 1; duplicate < end; duplicate++) {
        kept.delete(onString[duplicate]);
        dropped++;
      }
      index = end;
    }
    // Re-picking a string stops its previous note. The legacy writer already
    // clips that sustain; doing it here prevents artificial voice explosions
    // when a polyphonic MIDI transcription is assigned to guitar strings.
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1], current = ordered[index];
      if (previous.end > current.start + 1e-6) {
        previous.end = current.start;
        shortened++;
      }
    }
  }
  return { notes: notes.filter((note) => kept.has(note) && note.end > note.start + 1e-6), dropped, shortened };
}

// alphaTab resolves connected slides during Score.finish(). On the first pass,
// within-bar beat links exist but a following bar is not yet reachable, so it
// destructively clears cross-bar slides. After that pass has linked the score,
// restore the editor effects with explicit targets and finish once more.
function restoreConnectedSlideLinks(alphaTab, plans) {
  let restored = 0;
  for (const { staff, plan } of plans) {
    const notes = [];
    for (const bar of staff.bars) for (const voice of bar.voices)
      for (const beat of voice.beats) for (const note of beat.notes)
        notes.push({ note, voice: voice.index, start: beat.absolutePlaybackStart });
    for (const item of plan.items) {
      if (item.projected.slide !== "shift" && item.projected.slide !== "legato") continue;
      const string = staff.stringTuning.tunings.length - item.string;
      const voice = plan.assignments.get(item.projected);
      const parts = notes.filter((entry) => entry.voice === voice && entry.note.string === string
        && entry.start >= item.startTick && entry.start < item.endTick);
      // Still linked (a part the file slid from, kept as it was): nothing to restore.
      if (parts.some((entry) => entry.note.slideTarget)) continue;
      const origin = parts.sort((a, b) => b.start - a.start)[0]?.note;
      if (!origin) continue;
      const target = alphaTab.model.Note.nextNoteOnSameLine(origin);
      if (!target) continue;
      origin.slideOutType = item.projected.slide === "legato"
        ? alphaTab.model.SlideOutType.Legato : alphaTab.model.SlideOutType.Shift;
      origin.slideTarget = target;
      target.slideOrigin = origin;
      restored++;
    }
  }
  return restored;
}

// What a layer from a file keeps beside its notes, written back where it was: text and
// chord names over rests (scoreText), and the instrument changes its tone switches
// came from (gpProgram, guitar-pro-core.js toneSwitches).
function writeLaneExtras(alphaTab, staff, lane, points) {
  let wrote = 0;
  const beatAt = (t, voiceIndex = 0) => {
    const tick = secondsToTick(t, points);
    for (const bar of staff.bars) for (const beat of bar.voices[voiceIndex]?.beats || [])
      if (!beat.graceType && beat.absolutePlaybackStart <= tick + 1 && tick < beat.absolutePlaybackStart + beat.playbackDuration - 1) return beat;
    return null;
  };
  for (const item of lane.scoreText || []) {
    const beat = beatAt(item.t, item.voice);
    if (!beat) continue;
    if (item.text) beat.text = item.text;
    if (item.lyrics) beat.lyrics = [...item.lyrics];
    if (item.chord) {
      const id = `chord ${item.chord}`;
      if (!staff.chords?.has(id)) { const chord = new alphaTab.model.Chord(); chord.name = item.chord; staff.addChord(id, chord); }
      beat.chordId = id;
    }
    wrote++;
  }
  for (const marker of lane.toneMarkers || []) {
    const beat = Number.isInteger(marker.gpProgram) && beatAt(marker.t);
    if (!beat) continue;
    const automation = new alphaTab.model.Automation();
    automation.type = alphaTab.model.AutomationType.Instrument; automation.value = marker.gpProgram;
    beat.automations.push(automation);
    wrote++;
  }
  return wrote;
}

// The editor flags the note a hammer-on or pull-off lands on (fx.hammer true,
// "dest" or "both", web/articulations.js hammerLink); Guitar Pro the note it starts
// from, the one right before on the same string. Marked once the score is linked;
// finish() then links the pair.
function linkHammerOrigins(plans) {
  let linked = 0;
  for (const { staff, plan } of plans) {
    const notes = [];
    for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes)
      notes.push({ note, voice: voice.index, start: beat.absolutePlaybackStart, end: beat.absolutePlaybackStart + beat.playbackDuration });
    for (const item of plan.items) {
      const role = item.projected.fx?.hammer;
      if (role !== true && role !== "dest" && role !== "both") continue;
      const string = staff.stringTuning.tunings.length - item.string, voice = plan.assignments.get(item.projected);
      const before = notes.filter((entry) => entry.voice === voice && entry.note.string === string && entry.start < item.startTick)
        .sort((a, b) => b.start - a.start)[0];
      // ponytail: a 1/64 gap still counts as legato, as hammerLink's 30 ms does
      if (!before || item.startTick - before.end > QUARTER_TICKS / 16 || before.note.isHammerPullOrigin) continue;
      before.note.isHammerPullOrigin = true;
      linked++;
    }
  }
  return linked;
}

// `bars` is the song's bar-line times, which the voicer plans the fretting hand
// against (planSeats). Passed in rather than read from the store: this module stays
// DOM-free so the headless GP tests can import it. Without them a created lane is
// still voiced, just without a plan — and then the exported file disagrees with the
// tab on screen, which is why every caller in guitar-pro-score.js supplies them.
export function appendCreatedLanes(alphaTab, score, lanes, bars = []) {
  if (!lanes.length) return score;
  const connectedSlidePlans = [];
  for (const lane of lanes) {
    const tuning = tuningFromLane(lane);
    // Notes from a file stay as it has them, a note doubled in a second voice included
    // (applyImportedProjection); the rest are played as arranged.
    const notes = lane.notes || [];
    const arranged = new Set(chordColumns(notes).filter((c) => c.notes.some((n) => n.arrangement)).flatMap((c) => c.notes));
    const fromFile = new Set(notes.filter((n) => Number.isFinite(n.gp?.noteId) && !arranged.has(n)));
    const sourceNotes = [...fromFile, ...arrangedNotes(notes.filter((n) => !fromFile.has(n)))];
    // The app hands lanes in already fingered by laneFingering (guitar-pro-score.js),
    // so the file says what the fretboard shows. Voicing here is the headless fallback.
    const positions = sourceNotes.every((note) => note.pos)
      ? new Map(sourceNotes.map((note) => [note, note.pos]))
      : voiceNotes(sourceNotes, tuning, Infinity, { bars, instrument: lane.instrument, capo: lane.capo, holds: lane.handHolds });
    const missing = sourceNotes.filter((note) => !positions.get(note));
    if (missing.length) {
      score.cwWarnings ||= [];
      score.cwWarnings.push(`${lane.name}: ${missing.length} note(s) cannot be played in this tuning and were skipped`);
    }
    const fileCopies = new Set();
    let projected = sourceNotes.flatMap((note) => {
      const position = positions.get(note);
      if (!position) return [];
      const copy = { ...note, pos: { string: Number(position.string), fret: Number(position.fret), scope: "local" } };
      if (fromFile.has(note)) fileCopies.add(copy);
      return [copy];
    });
    {
      // Only the editor's own notes: the file's keep their voices and lengths.
      const normalized = normalizeAutomaticStringPerformance(projected.filter((n) => !fileCopies.has(n)));
      projected = [...fileCopies, ...normalized.notes];
      if (normalized.dropped) {
        score.cwWarnings ||= [];
        score.cwWarnings.push(`${lane.name}: ${normalized.dropped} simultaneous note(s) competed for one string and were skipped`);
      }
      if (normalized.shortened) {
        score.cwWarnings ||= [];
        score.cwWarnings.push(`${lane.name}: ${normalized.shortened} earlier note(s) were shortened when their string was played again`);
      }
    }
    projected = representPickedOpenSlides(projected);

    const track = new alphaTab.model.Track();
    track.name = lane.name || "Guitar";
    if (Number.isFinite(lane.gmProgram)) track.playbackInfo.program = Math.max(0, Math.min(127, Math.round(lane.gmProgram)));
    const staff = new alphaTab.model.Staff();
    staff.stringTuning.tunings = [...tuning]; staff.stringTuning.name = ""; staff.stringTuning.isStandard = false;
    staff.capo = Number(lane.capo) || 0;
    staff.transpositionPitch = Number(lane.transpositionPitch) || 0;
    staff.displayTranspositionPitch = Number(lane.displayTranspositionPitch) || 0;
    restoreFileExtras(track, lane.gpTrack?.track); restoreFileExtras(track.playbackInfo, lane.gpTrack?.playback);
    restoreFileExtras(staff, lane.gpTrack?.staff);
    track.addStaff(staff); score.addTrack(track);
    for (let index = 0; index < score.masterBars.length; index++) {
      const bar = new alphaTab.model.Bar();
      bar.addVoice(new alphaTab.model.Voice());
      staff.addBar(bar);
    }
    const points = timeline(score), bounds = barBounds(score);
    const plan = planLane(score, staff, { ...lane, notes: projected }, points, bounds);
    // A new track: every bar, in every voice its notes use.
    const rebuild = new Set(plan.affected);
    for (const voice of new Set([0, ...plan.assignments.values()]))
      for (let barIndex = 0; barIndex < bounds.length; barIndex++) rebuild.add(`${barIndex}:${voice}`);
    for (const key of rebuild) {
      const [barIndex, voiceIndex] = key.split(":").map(Number);
      const active = plan.items.filter((item) => plan.assignments.get(item.projected) === voiceIndex && inBar(item, bounds[barIndex]));
      rebuildVoice(alphaTab, staff, barIndex, voiceIndex, active, tuning, plan.byId);
    }
    evenVoiceCounts(alphaTab, staff);
    connectedSlidePlans.push({ staff, plan, lane, points });
  }
  score.finish(new alphaTab.Settings());
  if (restoreConnectedSlideLinks(alphaTab, connectedSlidePlans) + linkHammerOrigins(connectedSlidePlans)
    + connectedSlidePlans.reduce((n, { staff, lane, points }) => n + writeLaneExtras(alphaTab, staff, lane, points), 0))
    score.finish(new alphaTab.Settings());
  return score;
}

// Tracks taken from several sources into one score can share bar, voice, beat and
// note ids, and the .gp writer keys its tables by them: it would mix the tracks up.
// The model links by reference, so new ids change nothing else.
export function renumberScoreIds(score) {
  let id = 0;
  for (const track of score.tracks) for (const staff of track.staves) for (const bar of staff.bars) {
    bar.id = id++;
    for (const voice of bar.voices) {
      voice.id = id++;
      for (const beat of voice.beats) { beat.id = id++; for (const note of beat.notes) note.id = id++; }
    }
  }
}

export function applyScoreStructure(alphaTab, score, bars) {
  if (!Array.isArray(bars) || !bars.length || !score.tracks?.length) return score;
  const oldMasters = [...score.masterBars];
  const oldStaffBars = new Map();
  for (const track of score.tracks) for (const staff of track.staves) oldStaffBars.set(staff, [...staff.bars]);
  score.masterBars = bars.map((item) => Number.isInteger(item.sourceIndex) && oldMasters[item.sourceIndex]
    ? oldMasters[item.sourceIndex] : new alphaTab.model.MasterBar());
  for (const [staff, originals] of oldStaffBars) {
    staff.bars = bars.map((item) => {
      if (Number.isInteger(item.sourceIndex) && originals[item.sourceIndex]) return originals[item.sourceIndex];
      const bar = new alphaTab.model.Bar(); bar.addVoice(new alphaTab.model.Voice()); return bar;
    });
  }
  let start = 0;
  score.masterBars.forEach((master, index) => {
    const item = bars[index];
    master.score = score; master.index = index; master.start = start;
    master.previousMasterBar = score.masterBars[index - 1] || null;
    master.nextMasterBar = score.masterBars[index + 1] || null;
    master.timeSignatureNumerator = Math.max(1, Number(item.timeSignatureNumerator) || 4);
    master.timeSignatureDenominator = Math.max(1, Number(item.timeSignatureDenominator) || 4);
    start += masterBarDuration(master);
  });
  for (const [staff] of oldStaffBars) staff.bars.forEach((bar, index) => {
    bar.staff = staff; bar.index = index; bar.previousBar = staff.bars[index - 1] || null; bar.nextBar = staff.bars[index + 1] || null;
    if (!Number.isInteger(bars[index].sourceIndex))
      rebuildVoice(alphaTab, staff, index, 0, [], staff.stringTuning.tunings || [], new Map());
  });
  for (const [staff] of oldStaffBars) evenVoiceCounts(alphaTab, staff);   // inserted bars have one voice
  // Master bars put in place by hand, not through addMasterBar, have no repeat
  // group, and playback (MIDI generation) reads one from every bar.
  score.rebuildRepeatGroups();
  score.finish(new alphaTab.Settings());
  // The time signature is set twice on purpose. finish() recomputes bar timing
  // from the whole score and normalizes the master bars while doing it, so
  // anything that must survive has to be written AFTERWARDS — the same hazard
  // spelled out for connected slides ~120 lines above ("alphaTab destructively
  // clears cross-bar slides... restore... and finish once more"). Delete either
  // assignment and the meter reverts to whatever alphaTab inferred.
  bars.forEach((item, index) => {
    const master = score.masterBars[index];
    master.timeSignatureNumerator = Math.max(1, Number(item.timeSignatureNumerator) || 4);
    master.timeSignatureDenominator = Math.max(1, Number(item.timeSignatureDenominator) || 4);
    // The key is each staff's bar's in alphaTab 1.8 (MasterBar only reads it back).
    for (const track of score.tracks) for (const staff of track.staves) if (staff.bars[index]) {
      staff.bars[index].keySignature = Math.max(-7, Math.min(7, Number(item.keySignature) || 0));
      staff.bars[index].keySignatureType = Number(item.keySignatureType) === 1 ? 1 : 0;
    }
    master.isDoubleBar = !!item.isDoubleBar;
    master.isRepeatStart = !!item.isRepeatStart; master.repeatCount = Math.max(0, Number(item.repeatCount) || 0);
    master.alternateEndings = Math.max(0, Number(item.alternateEndings) || 0);
    master.isAnacrusis = !!item.isAnacrusis; master.isFreeTime = !!item.isFreeTime;
    if (Number.isFinite(Number(item.tripletFeel))) master.tripletFeel = Number(item.tripletFeel);
    if (item.section?.text || item.section?.marker) {
      const section = new alphaTab.model.Section();
      section.marker = item.section.marker || "";   // Guitar Pro's letter; a section may have none
      section.text = item.section.text || item.section.marker || ""; master.section = section;
    } else master.section = null;
  });
  score.rebuildRepeatGroups();   // the repeat flags just written decide the groups
  score.finish(new alphaTab.Settings());
  return score;
}
